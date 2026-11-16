/**
 * Automations in the database: the draft, what is published, its versions,
 * its secrets, and its runs.
 *
 * `automations.data` is the draft everyone edits. Publishing copies it to
 * `published` and into `automation_versions`; triggers only ever fire what is
 * published, and only while the automation is switched on. Testing runs the
 * draft, for real.
 */
import crypto from 'crypto';
import { sql } from './_db.js';
import { agentVersion } from './_agentFiles.js';
import { accessTo, allows, member, visible, ReadOnlyError } from './_access.js';
import { checkAutomation, blankAutomation, LIMITS, TRIGGER_ID } from './_automationSpec.js';
import { advance, freshState, clip, maskSecrets } from './_automationEngine.js';
import { fillConfig, runStep } from './_automationSteps.js';
import { nextRun } from './_schedule.js';

/** How long one function works a run before handing it on (seconds). */
export const WORK_BUDGET_MS = 240 * 1000;
const STALE_AFTER = '10 minutes';
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,59}$/;

const fail = (message, code, status = 400) => Object.assign(new Error(message), { code, status });

/** The content hash of a definition: what a push is checked against. */
export const versionOf = (def) => agentVersion(def || {});

function shape(row, level) {
  const data = row.data || {};
  return {
    id: row.id,
    ...data,
    enabled: !!row.enabled,
    published: !!row.published,
    /* The draft has moved on from what is live. */
    unpublished: !row.published || versionOf(row.published) !== versionOf(data),
    version: versionOf(data),
    hookKey: row.hook_key,
    nextRunAt: row.next_run_at || null,
    secretNames: Object.keys(row.secrets || {}).sort(),
    updatedAt: row.updated_at,
    createdAt: row.created_at,
    _access: level,
  };
}

/** The organization's automations this person may see. */
export async function listAutomations(user) {
  const me = await member(user);
  if (!me) return [];
  const rows = await sql`
    select a.id, a.org_id, a.data, a.published, a.enabled, a.next_run_at, a.updated_at, a.created_at,
           r.status as last_status, r.started_at as last_run_at
    from automations a
    left join lateral (
      select status, started_at from automation_runs
      where automation_id = a.id and mode = 'live' order by started_at desc limit 1
    ) r on true
    where a.org_id = ${me.orgId}
    order by a.updated_at desc
  `;
  return (await visible(me, 'automation', rows)).map(({ row: r, level }) => ({
    id: r.id,
    name: r.data.name || '',
    description: r.data.description || '',
    trigger: (r.data.trigger || {}).type || 'manual',
    steps: (r.data.steps || []).length,
    stepTypes: [...new Set((r.data.steps || []).map(s => s.type))],
    enabled: !!r.enabled,
    published: !!r.published,
    unpublished: !r.published || versionOf(r.published) !== versionOf(r.data),
    nextRunAt: r.next_run_at || null,
    lastStatus: r.last_status || null,
    lastRunAt: r.last_run_at || null,
    updatedAt: r.updated_at,
    _access: level,
  }));
}

/**
 * One automation if the caller may see it; null when not.
 * `need: 'edit'` from someone who may only look throws ReadOnlyError.
 */
export async function loadAutomation({ id, user, need = 'view' }) {
  const { level, item } = await accessTo(user, 'automation', id);
  if (!item || !allows(level, 'view')) return null;
  if (need === 'edit' && !allows(level, 'edit')) throw new ReadOnlyError('this automation');
  const [row] = await sql`select * from automations where id = ${item.id}`;
  if (!row) return null;
  return { row, automation: shape(row, level), access: level };
}

export async function createAutomation({ user, name, trigger = 'manual', data }) {
  const clean = String(name || '').trim().slice(0, 80);
  if (!clean) throw fail('An automation needs a name', 'BAD_NAME');
  const id = crypto.randomUUID();
  /* A new automation is a draft: settings not filled in yet are expected. */
  const { automation, structural } = checkAutomation(data ? { ...data, name: clean } : blankAutomation(clean, trigger));
  if (structural.length) throw fail(structural[0], 'INVALID', 422);
  const hookKey = crypto.randomBytes(24).toString('base64url');
  await sql`
    insert into automations (id, user_id, data, hook_key)
    values (${id}, ${user.userId}, ${JSON.stringify(automation)}::jsonb, ${hookKey})
  `;
  const [row] = await sql`select * from automations where id = ${id}`;
  return shape(row, 'edit');
}

/**
 * Saves the draft. An invalid draft is still saved — half-built is what a
 * draft is — and its problems come back with it; only publishing and running
 * refuse them.
 *
 * `baseVersion`, when given, must be the draft the caller started from: a
 * push made on top of something older is refused rather than undoing it.
 */
export async function saveDraft({ id, user, data, baseVersion }) {
  const loaded = await loadAutomation({ id, user, need: 'edit' });
  if (!loaded) return null;
  if (baseVersion && baseVersion !== versionOf(loaded.row.data)) {
    throw fail('The automation changed on the platform since you opened it.', 'STALE', 409);
  }
  const { automation, errors, warnings } = checkAutomation(data);
  /* A name is the one thing even a draft must have. */
  if (!automation.name) automation.name = loaded.row.data.name;
  const [row] = await sql`
    update automations set data = ${JSON.stringify(automation)}::jsonb, updated_at = now()
    where id = ${loaded.row.id} returning *
  `;
  return { automation: shape(row, loaded.access), errors, warnings };
}

async function recordVersion({ automationId, user, data, source, commitSha = null, message = '' }) {
  const id = crypto.randomUUID();
  const [row] = await sql`
    insert into automation_versions (id, automation_id, number, data, source, commit_sha, message, created_by)
    values (${id}, ${automationId},
            (select coalesce(max(number), 0) + 1 from automation_versions where automation_id = ${automationId}),
            ${JSON.stringify(data)}::jsonb, ${source}, ${commitSha},
            ${String(message || '').slice(0, 200)}, ${user.userId || null})
    returning number
  `;
  return { id, number: row ? row.number : null };
}

const freshTriggerState = () => ({ since: new Date().toISOString() });

/** When a published automation's schedule fires next; null if it has none or is off. */
function scheduleFor(def, enabled, after = new Date()) {
  if (!enabled || !def || !def.trigger || def.trigger.type !== 'schedule') return null;
  try { return nextRun(def.trigger.config, after); } catch { return null; }
}

/** Makes the draft what triggers fire, and keeps it as a version. */
export async function publish({ id, user, source = 'ui', commitSha, message }) {
  const loaded = await loadAutomation({ id, user, need: 'edit' });
  if (!loaded) return null;
  const { automation: def, errors } = checkAutomation(loaded.row.data);
  if (errors.length) throw Object.assign(fail(errors[0], 'INVALID', 422), { errors });
  const changed = !loaded.row.published || versionOf(loaded.row.published) !== versionOf(def);
  let made = null;
  if (changed) made = await recordVersion({ automationId: loaded.row.id, user, data: def, source, commitSha, message });
  /* The first publish switches it on: publishing is how an automation goes live. */
  const enabled = loaded.row.published ? loaded.row.enabled : true;
  const next = scheduleFor(def, enabled);
  /* A polling trigger starts from now: publishing must not fire for mail
     that arrived while the automation was a draft. */
  const [row] = await sql`
    update automations
    set published = ${JSON.stringify(def)}::jsonb, enabled = ${enabled}, next_run_at = ${next},
        trigger_state = ${JSON.stringify(freshTriggerState())}::jsonb,
        active_version_id = coalesce(${made ? made.id : null}, active_version_id), updated_at = now()
    where id = ${loaded.row.id} returning *
  `;
  return { automation: shape(row, loaded.access), versionNumber: made ? made.number : null, changed };
}

export async function setEnabled({ id, user, enabled }) {
  const loaded = await loadAutomation({ id, user, need: 'edit' });
  if (!loaded) return null;
  if (enabled && !loaded.row.published) throw fail('Publish the automation before switching it on.', 'NOT_PUBLISHED', 409);
  const next = scheduleFor(loaded.row.published, !!enabled);
  const [row] = await sql`
    update automations set enabled = ${!!enabled}, next_run_at = ${next},
           trigger_state = ${JSON.stringify(freshTriggerState())}::jsonb, updated_at = now()
    where id = ${loaded.row.id} returning *
  `;
  return shape(row, loaded.access);
}

export async function listVersions({ id, user }) {
  const loaded = await loadAutomation({ id, user });
  if (!loaded) return null;
  const rows = await sql`
    select id, number, source, commit_sha, message, created_at
    from automation_versions where automation_id = ${loaded.row.id}
    order by number desc limit 100
  `;
  return rows.map(r => ({ ...r, active: r.id === loaded.row.active_version_id }));
}

/** Puts an earlier version back: it becomes both the draft and what is live. */
export async function activateVersion({ id, user, versionId }) {
  const loaded = await loadAutomation({ id, user, need: 'edit' });
  if (!loaded) return null;
  const [v] = await sql`
    select id, number, data from automation_versions
    where automation_id = ${loaded.row.id} and (id = ${String(versionId)} or number::text = ${String(versionId)})
  `;
  if (!v) throw fail('No such version', 'NO_VERSION', 404);
  const next = scheduleFor(v.data, loaded.row.enabled);
  const [row] = await sql`
    update automations
    set data = ${JSON.stringify(v.data)}::jsonb, published = ${JSON.stringify(v.data)}::jsonb,
        active_version_id = ${v.id}, next_run_at = ${next},
        trigger_state = ${JSON.stringify(freshTriggerState())}::jsonb, updated_at = now()
    where id = ${loaded.row.id} returning *
  `;
  return { automation: shape(row, loaded.access), versionNumber: v.number };
}

export async function deleteAutomation({ id, user }) {
  const loaded = await loadAutomation({ id, user, need: 'edit' });
  if (!loaded) return null;
  await sql`delete from automations where id = ${loaded.row.id}`;
  return { ok: true };
}

/**
 * Sets and removes secrets. `set` is `{ NAME: value }`; `remove` is names.
 * Values go in and never come back out: the screen only ever sees the names.
 */
export async function saveSecrets({ id, user, set = {}, remove = [] }) {
  const loaded = await loadAutomation({ id, user, need: 'edit' });
  if (!loaded) return null;
  const secrets = { ...(loaded.row.secrets || {}) };
  for (const name of remove) delete secrets[String(name)];
  for (const [name, value] of Object.entries(set || {})) {
    if (!SECRET_NAME.test(name)) throw fail(`"${name}" is not a usable secret name — letters, digits and _`, 'BAD_SECRET');
    if (typeof value !== 'string' || !value) throw fail(`The secret ${name} needs a value`, 'BAD_SECRET');
    secrets[name] = value;
  }
  if (Object.keys(secrets).length > 50) throw fail('An automation holds at most 50 secrets', 'BAD_SECRET');
  await sql`update automations set secrets = ${JSON.stringify(secrets)}::jsonb where id = ${loaded.row.id}`;
  return { secretNames: Object.keys(secrets).sort() };
}

/* ─────────────────── where the platform can reach itself ─────────────────── */

/**
 * The address the code runner is called on.
 *
 * A request from a browser or a webhook arrives on a public host, and that is
 * the one to use. The cron arrives on the deployment's own URL, which
 * Deployment Protection answers with a login page — so a run started by the
 * cron uses the host its automation was last reached on, then the same
 * fallbacks the WhatsApp worker uses.
 */
export function publicBase(host, remembered) {
  const own = process.env.VERCEL_URL;
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const app = String(process.env.APP_URL || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();
  const pick = [host && host !== own ? host : null, remembered, app,
                prod && !prod.startsWith('www.') ? `www.${prod}` : null, prod, host].find(Boolean);
  if (!pick) return null;
  return `${/^(localhost|127\.0\.0\.1)(:|$)/.test(pick) ? 'http' : 'https'}://${pick}`;
}

const rememberHost = (host) => (host && host !== process.env.VERCEL_URL ? host : null);

/* ─────────────────── runs ─────────────────── */

/**
 * Records that an automation fired. The run is `queued`; `workRun` does it.
 *
 * `mode: 'test'` runs the draft, `'live'` what is published. The definition
 * is copied onto the run, so it finishes on the steps it started with.
 */
export async function startRun({ row, mode = 'live', source = 'manual', input = null, userId = null, host = null }) {
  const draft = mode === 'test';
  const { automation: def, errors } = checkAutomation(draft ? row.data : row.published);
  if (!draft && !row.published) throw fail('This automation has not been published yet.', 'NOT_PUBLISHED', 409);
  if (errors.length) throw Object.assign(fail(errors[0], 'INVALID', 422), { errors });
  const id = crypto.randomUUID();
  await sql`
    insert into automation_runs (id, automation_id, org_id, mode, source, status, definition, input, state, resume_at, host, started_by)
    values (${id}, ${row.id}, ${row.org_id}, ${mode}, ${source}, 'queued', ${JSON.stringify(def)}::jsonb,
            ${JSON.stringify(input === undefined ? null : input)}::jsonb, ${JSON.stringify(freshState())}::jsonb,
            now(), ${rememberHost(host)}, ${userId})
  `;
  return id;
}

/**
 * Works a run as far as it will go in this function's time.
 *
 * Only one function works a run at a time: the claim is a single UPDATE that
 * succeeds for a run that is due, or one whose worker stopped answering.
 * Returns the run's row afterwards, or null if somebody else has it.
 */
export async function workRun(runId, { host = null, budgetMs = WORK_BUDGET_MS, depth = 0 } = {}) {
  const [run] = await sql`
    update automation_runs set status = 'running', heartbeat_at = now()
    where id = ${runId}
      and (status in ('queued', 'waiting')
           or (status = 'running' and heartbeat_at < now() - ${STALE_AFTER}::interval))
    returning *
  `;
  if (!run) return null;
  const [auto] = await sql`select id, org_id, user_id, secrets, samples from automations where id = ${run.automation_id}`;
  if (!auto) return null;

  const started = Date.now();
  const secrets = auto.secrets || {};
  const state = run.state && run.state.nodes ? run.state : freshState();
  const samples = {};
  const ctx = {
    runId: run.id,
    mode: run.mode,
    orgId: auto.org_id,
    ownerId: auto.user_id,
    automationId: auto.id,
    secrets,
    baseUrl: publicBase(host, run.host),
    deadline: started + budgetMs,
    hardDeadline: started + budgetMs + 40 * 1000,
    recordStep: (r) => sql`
      insert into automation_run_steps (run_id, step_id, step_type, step_name, status, port, iteration, input, output, error, ms)
      values (${run.id}, ${r.stepId}, ${r.stepType}, ${r.stepName}, ${r.status}, ${r.port}, ${r.iteration},
              ${JSON.stringify(r.input ?? null)}::jsonb, ${JSON.stringify(r.output ?? null)}::jsonb, ${r.error}, ${r.ms})
    `,
    saveState: (st) => sql`
      update automation_runs set state = ${JSON.stringify(st)}::jsonb, heartbeat_at = now() where id = ${run.id}
    `,
    onSample: run.mode === 'test' ? (id, value) => { samples[id] = value; } : null,
    callAutomation: (targetId, input) => callAutomation({ targetId, input, orgId: auto.org_id, parent: run, host, depth,
                                                          budgetMs: Math.max(5000, started + budgetMs - Date.now()) }),
  };

  let result;
  try {
    result = await advance({ definition: run.definition, input: run.input, state, ctx });
  } catch (err) {
    result = { status: 'failed', error: `The run stopped unexpectedly: ${err.message}` };
  }

  const finished = result.status === 'done' || result.status === 'failed';
  const [after] = await sql`
    update automation_runs
    set status = ${result.status},
        state = ${JSON.stringify(state)}::jsonb,
        output = ${JSON.stringify(clip(maskSecrets(result.output ?? null, secrets), LIMITS.outputBytes))}::jsonb,
        error = ${result.error || null},
        resume_at = ${result.status === 'waiting' ? new Date(result.resumeAt) : result.status === 'queued' ? new Date() : null},
        finished_at = ${finished ? new Date() : null},
        heartbeat_at = now()
    where id = ${run.id} returning *
  `;

  if (run.mode === 'test' && Object.keys(samples).length) {
    const merged = { ...(auto.samples || {}) };
    for (const [id, value] of Object.entries(samples)) merged[id] = clip(maskSecrets(value, secrets), LIMITS.sampleBytes);
    await sql`update automations set samples = ${JSON.stringify(merged)}::jsonb where id = ${auto.id}`.catch(() => {});
  }
  return after;
}

/** A Run automation step: the other automation's published steps, run in place. */
async function callAutomation({ targetId, input, orgId, parent, host, depth, budgetMs }) {
  if (depth >= LIMITS.callDepth) throw new Error(`automations are calling each other more than ${LIMITS.callDepth} deep`);
  const [row] = await sql`select * from automations where id = ${targetId} and org_id = ${orgId}`;
  if (!row) throw new Error('the automation to run no longer exists');
  if (!row.published) throw new Error(`"${row.data.name}" has not been published yet`);
  const childId = await startRun({ row, mode: 'live', source: 'call', input, userId: parent.started_by, host: host || parent.host });
  const child = await workRun(childId, { host, budgetMs, depth: depth + 1 });
  if (!child) throw new Error(`"${row.data.name}" could not be started`);
  if (child.status === 'failed') throw new Error(`"${row.data.name}" failed — ${child.error}`);
  if (child.status !== 'done') {
    await sql`update automation_runs set status = 'stopped', error = 'It was called by another automation and could not finish in one go.', finished_at = now() where id = ${childId}`;
    throw new Error(`"${row.data.name}" has a long wait in it, so it cannot be run from another automation`);
  }
  return child.output;
}

/**
 * Runs one step of the draft on its own, against what the last test left.
 *
 * It really runs — an HTTP step calls the server, a code step executes — but
 * no run is recorded. What it returns becomes that step's sample, so the next
 * step's field picker has real data to offer.
 */
export async function testStep({ id, user, stepId, host }) {
  const loaded = await loadAutomation({ id, user, need: 'edit' });
  if (!loaded) return null;
  const { automation: def } = checkAutomation(loaded.row.data);
  const step = def.steps.find(s => s.id === stepId);
  if (!step) throw fail('No such step', 'NO_STEP', 404);
  const secrets = loaded.row.secrets || {};
  const samples = loaded.row.samples || {};
  const { [TRIGGER_ID]: trigger = null, ...rest } = samples;
  const scope = { ...rest, trigger, secrets, now: new Date().toISOString(), run: { id: null, mode: 'test' } };

  const started = Date.now();
  let filled, result, error = null;
  try {
    filled = fillConfig(step, scope);
    if (step.type === 'wait') {
      result = { output: { note: 'A wait is not waited out when a step is tested on its own.' }, port: 'out' };
    } else if (step.type === 'loop') {
      const items = typeof filled.items === 'string' ? JSON.parse(filled.items) : filled.items;
      if (!Array.isArray(items)) throw new Error('needs a list to go over, and what it was given is not a list');
      result = { output: { count: items.length, firstItem: items[0] ?? null,
                           note: 'Testing a loop on its own shows the list; run the automation to run its steps.' }, port: 'done' };
      if (items.length) { samples.item = clip(items[0], LIMITS.sampleBytes); samples.index = 0; }
    } else {
      result = await runStep(step, filled, {
        secrets, baseUrl: publicBase(host), mode: 'test', single: true,
        orgId: loaded.row.org_id, ownerId: loaded.row.user_id, automationId: loaded.row.id,
        callAutomation: (targetId, input) => callAutomation({
          targetId, input, orgId: loaded.row.org_id, parent: { started_by: user.userId, host }, host, depth: 0, budgetMs: 60000 }),
      });
    }
  } catch (err) {
    error = err.message || String(err);
    result = { output: err.output ?? null, port: null };
  }

  if (!error) {
    samples[step.id] = clip(maskSecrets(result.output ?? null, secrets), LIMITS.sampleBytes);
    await sql`update automations set samples = ${JSON.stringify(samples)}::jsonb where id = ${loaded.row.id}`.catch(() => {});
  }
  return {
    stepId: step.id,
    status: error ? 'failed' : 'done',
    port: result.port,
    input: maskSecrets(filled ?? null, secrets),
    output: clip(maskSecrets(result.output ?? null, secrets), LIMITS.storedBytes),
    printed: result.printed || '',
    error: error ? String(maskSecrets(error, secrets)) : null,
    ms: Date.now() - started,
  };
}

export async function listRuns({ id, user, limit = 50, mode = null }) {
  const loaded = await loadAutomation({ id, user });
  if (!loaded) return null;
  const rows = await sql`
    select id, mode, source, status, error, started_at, finished_at, resume_at
    from automation_runs
    where automation_id = ${loaded.row.id} and (${mode}::text is null or mode = ${mode})
    order by started_at desc limit ${Math.max(1, Math.min(200, Number(limit) || 50))}
  `;
  return rows;
}

/** One run with every step it took, if the caller may see its automation. */
export async function getRun({ runId, user }) {
  const [run] = await sql`
    select id, automation_id, mode, source, status, input, output, error, started_at, finished_at, resume_at, definition
    from automation_runs where id = ${runId}
  `;
  if (!run) return null;
  const loaded = await loadAutomation({ id: run.automation_id, user });
  if (!loaded) return null;
  const steps = await sql`
    select step_id, step_type, step_name, status, port, iteration, input, output, error, ms, created_at
    from automation_run_steps where run_id = ${run.id} order by id
  `;
  return { ...run, input: maskSecrets(run.input, loaded.row.secrets), steps };
}

/** Stops a run that is waiting or queued. A step already under way finishes. */
export async function stopRun({ runId, user }) {
  const [run] = await sql`select id, automation_id from automation_runs where id = ${runId}`;
  if (!run) return null;
  const loaded = await loadAutomation({ id: run.automation_id, user, need: 'edit' });
  if (!loaded) return null;
  await sql`
    update automation_runs set status = 'stopped', error = 'Stopped by a person.', finished_at = now(), resume_at = null
    where id = ${run.id} and status in ('queued', 'waiting', 'running')
  `;
  return { ok: true };
}

/** What the editor's field picker knows each step returns. */
export async function getSamples({ id, user }) {
  const loaded = await loadAutomation({ id, user });
  return loaded ? (loaded.row.samples || {}) : null;
}

/* ─────────────────── the clock ─────────────────── */

/**
 * Fires every schedule that has come due, and returns the runs it started.
 *
 * Each due automation is claimed by moving its next firing forward in the
 * same statement that reads it, so two overlapping ticks cannot both fire it.
 * A schedule that fell behind fires once, not once per missed slot.
 */
export async function fireDueSchedules(now = new Date()) {
  const due = await sql`
    select id from automations
    where enabled and published is not null and next_run_at is not null and next_run_at <= ${now}
    limit 50
  `;
  const started = [];
  for (const { id } of due) {
    const [row] = await sql`select * from automations where id = ${id}`;
    if (!row) continue;
    const scheduledFor = row.next_run_at;
    const next = scheduleFor(row.published, true, now);
    const [claimed] = await sql`
      update automations set next_run_at = ${next}
      where id = ${id} and next_run_at = ${scheduledFor} returning id
    `;
    if (!claimed) continue;
    try {
      const [last] = await sql`
        select host from automation_runs where automation_id = ${id} and host is not null order by started_at desc limit 1
      `;
      started.push(await startRun({
        row, mode: 'live', source: 'schedule', host: last ? last.host : null,
        input: { scheduledFor: new Date(scheduledFor).toISOString(), firedAt: now.toISOString() },
      }));
    } catch (err) {
      console.error(`[automations] schedule for ${id} did not start:`, err.message);
    }
  }
  return started;
}

/** Runs that are due: queued, done waiting, or left by a function that died. */
export async function dueRuns(limit = 20) {
  const rows = await sql`
    select id from automation_runs
    where (status in ('queued', 'waiting') and resume_at <= now())
       or (status = 'running' and heartbeat_at < now() - ${STALE_AFTER}::interval)
    order by resume_at nulls first limit ${limit}
  `;
  return rows.map(r => r.id);
}

/** Old runs go after 30 days; their steps go with them. */
export async function pruneRuns() {
  await sql`delete from automation_runs where started_at < now() - interval '30 days' and status in ('done', 'failed', 'stopped')`;
}

/** The automation a webhook address belongs to. */
export async function byHookKey(key) {
  const [row] = await sql`select * from automations where hook_key = ${String(key || '')}`;
  return row || null;
}
