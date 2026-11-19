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
import { AsyncLocalStorage } from 'async_hooks';
import { sql } from './_db.js';
import { agentVersion } from './_agentFiles.js';
import { accessTo, allows, member, visible, ReadOnlyError } from './_access.js';
import { checkAutomation, blankAutomation, LIMITS, TRIGGER_ID } from './_automationSpec.js';
import { advance, freshState, clip, maskSecrets } from './_automationEngine.js';
import { fillConfig, runStep } from './_automationSteps.js';
import { nextRun, nextRunAfter } from './_schedule.js';
import { canUseConnection } from './_connections.js';

/** How long one function works a run before handing it on (seconds). */
export const WORK_BUDGET_MS = 240 * 1000;
/** What a worker may run past its budget to finish the step it is on. */
const HARD_MARGIN_MS = 40 * 1000;
const STALE_AFTER = '10 minutes';
/* A run whose worker died this many times is not picked up again: whatever
   kills it will kill the next one too. */
const MAX_RECLAIMS = 3;
/* The most runs one organization gets in one tick, so one with a pile of
   runs cannot starve the rest. */
const PER_ORG_PER_TICK = 5;
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,59}$/;

/**
 * The run being worked right now, if any: { runId, depth, orgId }.
 *
 * Whatever a run sets off — a row its table step writes, a chatbot its agent
 * step asks, another automation it calls — starts its runs inside this, so
 * each knows how deep the chain already is (see startRun), however many
 * files it went through to get there.
 */
export const runScope = new AsyncLocalStorage();

/** Runs `fn` over `items`, at most `limit` at a time. */
export async function eachLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

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

/** The connections a definition names (its trigger's and its steps'). */
function connectionsNamed(def) {
  const names = new Set();
  const add = (v) => { const n = typeof v === 'string' ? v.trim() : ''; if (n && !n.includes('{{')) names.add(n); };
  if (def && def.trigger && def.trigger.config) add(def.trigger.config.connection);
  for (const step of (def && def.steps) || []) add(step.config && step.config.connection);
  return [...names];
}

/**
 * A live automation acts for whoever published it: it may only name
 * connections that person may use. (A test acts for whoever runs it, and is
 * checked when its steps run.)
 */
async function assertConnectionsUsable(def, orgId, user) {
  if (user && user.system) return;
  for (const name of connectionsNamed(def)) {
    const [row] = await sql`select * from connections where org_id = ${orgId} and (lower(name) = lower(${name}) or id = ${name})`;
    if (row && !(await canUseConnection(row, user && user.userId))) {
      throw fail(`The connection "${row.name}" has not been shared with you. The organization's admin can share it under Connections.`, 'NOT_SHARED', 403);
    }
  }
}

const publisherOf = (user) => (user && !user.system && user.userId ? user.userId : null);

/** Makes the draft what triggers fire, and keeps it as a version. */
export async function publish({ id, user, source = 'ui', commitSha, message }) {
  const loaded = await loadAutomation({ id, user, need: 'edit' });
  if (!loaded) return null;
  const { automation: def, errors } = checkAutomation(loaded.row.data);
  if (errors.length) throw Object.assign(fail(errors[0], 'INVALID', 422), { errors });
  await assertConnectionsUsable(def, loaded.row.org_id, user);
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
        published_by = coalesce(${publisherOf(user)}, published_by, user_id),
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
  await assertConnectionsUsable(v.data, loaded.row.org_id, user);
  const next = scheduleFor(v.data, loaded.row.enabled);
  const [row] = await sql`
    update automations
    set data = ${JSON.stringify(v.data)}::jsonb, published = ${JSON.stringify(v.data)}::jsonb,
        published_by = coalesce(${publisherOf(user)}, published_by, user_id),
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
 *
 * A run started while another is being worked (inside `runScope`) is one
 * deeper than it; `depth` can only add to that (a webhook says how deep the
 * caller was). Past LIMITS.callDepth it is refused: automations that start
 * each other — through a table, a chatbot, a Run automation step or their
 * own webhook — cannot go round forever.
 */
export async function startRun({ row, mode = 'live', source = 'manual', input = null, userId = null, host = null, depth = 0, parentRunId = null }) {
  const draft = mode === 'test';
  const { automation: def, errors } = checkAutomation(draft ? row.data : row.published);
  if (!draft && !row.published) throw fail('This automation has not been published yet.', 'NOT_PUBLISHED', 409);
  if (errors.length) throw Object.assign(fail(errors[0], 'INVALID', 422), { errors });
  const scope = runScope.getStore();
  const deep = Math.max(Math.max(0, Math.floor(Number(depth) || 0)), scope ? scope.depth + 1 : 0);
  if (deep > LIMITS.callDepth) {
    throw fail(`Automations are starting each other more than ${LIMITS.callDepth} deep, so this one was not started (they could otherwise run each other forever).`, 'TOO_DEEP', 409);
  }
  const parent = parentRunId || (scope ? scope.runId : null);
  const id = crypto.randomUUID();
  await sql`
    insert into automation_runs (id, automation_id, org_id, mode, source, status, definition, input, state, resume_at, host, started_by, depth, parent_run_id)
    values (${id}, ${row.id}, ${row.org_id}, ${mode}, ${source}, 'queued', ${JSON.stringify(def)}::jsonb,
            ${JSON.stringify(input === undefined ? null : input)}::jsonb, ${JSON.stringify(freshState())}::jsonb,
            now(), ${rememberHost(host)}, ${userId}, ${deep}, ${parent})
  `;
  return id;
}

/**
 * Works a run as far as it will go in this function's time.
 *
 * Only one function works a run at a time: the claim is a single UPDATE that
 * succeeds for a run that is due, or one whose worker stopped answering, and
 * writes a fresh `claim_id`. Every later write is `where claim_id = ours and
 * status = 'running'`, so once a person presses Stop (or another worker takes
 * the run over) nothing this worker does can bring the run back: its saves
 * touch no row, and the engine ends there.
 *
 * `budgetMs` is when to hand over between steps; `hardBudgetMs` (default
 * budgetMs + 40 s) is what no step, retry or loop may run past — callers set
 * it below their function's maxDuration.
 *
 * Returns the run's row afterwards, or null if somebody else has it.
 */
export async function workRun(runId, { host = null, budgetMs = WORK_BUDGET_MS, hardBudgetMs = null } = {}) {
  const claim = crypto.randomUUID();
  const [run] = await sql`
    update automation_runs
    set status = 'running', heartbeat_at = now(), claim_id = ${claim},
        reclaims = reclaims + (case when status = 'running' then 1 else 0 end)
    where id = ${runId}
      and (status in ('queued', 'waiting')
           or (status = 'running' and heartbeat_at < now() - ${STALE_AFTER}::interval))
    returning *
  `;
  if (!run) return null;
  if ((run.reclaims || 0) > MAX_RECLAIMS) {
    const [gaveUp] = await sql`
      update automation_runs
      set status = 'failed', finished_at = now(), resume_at = null, heartbeat_at = now(),
          error = ${`The run stopped answering ${run.reclaims} times in a row, so it is not tried again.`}
      where id = ${run.id} and claim_id = ${claim} and status = 'running' returning *
    `;
    return gaveUp || null;
  }
  const [auto] = await sql`select id, org_id, user_id, published_by, secrets, samples from automations where id = ${run.automation_id}`;
  if (!auto) return null;

  const started = Date.now();
  const secrets = auto.secrets || {};
  const state = run.state && run.state.nodes ? run.state : freshState();
  const samples = {};
  const depth = Number(run.depth) || 0;

  /* The small parts of the state, which change with every step. The step
     outputs, which can be large, are written one at a time as they appear. */
  const small = (st) => JSON.stringify({ nodes: st.nodes || {}, edges: st.edges || {}, wait: st.wait ?? null,
                                         output: st.output ?? null, inflight: st.inflight ?? null });
  let savedWhole = false;
  const saveState = async (st, { stepId = null } = {}) => {
    let rows;
    if (!savedWhole) {
      rows = await sql`
        update automation_runs set state = ${JSON.stringify(st)}::jsonb, heartbeat_at = now()
        where id = ${run.id} and claim_id = ${claim} and status = 'running' returning id
      `;
      savedWhole = !!(rows && rows.length);
    } else {
      const patch = stepId ? JSON.stringify({ [stepId]: st.outputs[stepId] === undefined ? null : st.outputs[stepId] }) : '{}';
      rows = await sql`
        update automation_runs
        set state = jsonb_set(state, '{outputs}', coalesce(state->'outputs', '{}'::jsonb) || ${patch}::jsonb) || ${small(st)}::jsonb,
            heartbeat_at = now()
        where id = ${run.id} and claim_id = ${claim} and status = 'running' returning id
      `;
    }
    return !!(rows && rows.length);
  };

  const ctx = {
    runId: run.id,
    mode: run.mode,
    orgId: auto.org_id,
    ownerId: auto.user_id,
    /* Who the run acts for: whoever is testing it, or whoever published what runs. */
    actorId: run.mode === 'test' ? (run.started_by || auto.user_id) : (auto.published_by || auto.user_id),
    automationId: auto.id,
    depth,
    secrets,
    baseUrl: publicBase(host, run.host),
    deadline: started + budgetMs,
    hardDeadline: started + (hardBudgetMs || budgetMs + HARD_MARGIN_MS),
    recordStep: (r) => sql`
      insert into automation_run_steps (run_id, step_id, step_type, step_name, status, port, iteration, input, output, error, ms)
      values (${run.id}, ${r.stepId}, ${r.stepType}, ${r.stepName}, ${r.status}, ${r.port}, ${r.iteration},
              ${JSON.stringify(r.input ?? null)}::jsonb, ${JSON.stringify(r.output ?? null)}::jsonb, ${r.error}, ${r.ms})
    `,
    saveState,
    stillRunning: async () => {
      const rows = await sql`
        update automation_runs set heartbeat_at = now()
        where id = ${run.id} and claim_id = ${claim} and status = 'running' returning id
      `;
      return !!(rows && rows.length);
    },
    onSample: run.mode === 'test' ? (id, value) => { samples[id] = value; } : null,
    callAutomation: (targetId, input) => callAutomation({ targetId, input, orgId: auto.org_id, parent: run, host,
                                                          budgetMs: Math.max(5000, started + budgetMs - Date.now()) }),
  };

  let result;
  try {
    result = await runScope.run({ runId: run.id, depth, orgId: auto.org_id },
      () => advance({ definition: run.definition, input: run.input, state, ctx }));
  } catch (err) {
    result = { status: 'failed', error: `The run stopped unexpectedly: ${err.message}` };
  }

  let after = null;
  if (result.status !== 'stopped') {
    const finished = result.status === 'done' || result.status === 'failed';
    const output = JSON.stringify(clip(maskSecrets(result.output ?? null, secrets), LIMITS.outputBytes));
    const resumeAt = result.status === 'waiting' ? new Date(result.resumeAt) : result.status === 'queued' ? new Date() : null;
    [after] = savedWhole
      ? await sql`
          update automation_runs
          set status = ${result.status}, state = state || ${small(state)}::jsonb, output = ${output}::jsonb,
              error = ${result.error || null}, resume_at = ${resumeAt}, finished_at = ${finished ? new Date() : null},
              heartbeat_at = now()
          where id = ${run.id} and claim_id = ${claim} and status = 'running' returning *
        `
      : await sql`
          update automation_runs
          set status = ${result.status}, state = ${JSON.stringify(state)}::jsonb, output = ${output}::jsonb,
              error = ${result.error || null}, resume_at = ${resumeAt}, finished_at = ${finished ? new Date() : null},
              heartbeat_at = now()
          where id = ${run.id} and claim_id = ${claim} and status = 'running' returning *
        `;
  }
  /* Stopped meanwhile (or taken over): what the run is now, untouched. */
  if (!after) [after] = await sql`select * from automation_runs where id = ${run.id}`;

  if (run.mode === 'test' && Object.keys(samples).length) {
    const merged = { ...(auto.samples || {}) };
    for (const [id, value] of Object.entries(samples)) merged[id] = clip(maskSecrets(value, secrets), LIMITS.sampleBytes);
    await sql`update automations set samples = ${JSON.stringify(merged)}::jsonb where id = ${auto.id}`.catch(() => {});
  }
  return after || null;
}

/** A Run automation step: the other automation's published steps, run in place. */
async function callAutomation({ targetId, input, orgId, parent, host, budgetMs }) {
  if ((Number(parent && parent.depth) || 0) >= LIMITS.callDepth) {
    throw new Error(`automations are calling each other more than ${LIMITS.callDepth} deep`);
  }
  const [row] = await sql`select * from automations where id = ${targetId} and org_id = ${orgId}`;
  if (!row) throw new Error('the automation to run no longer exists');
  if (!row.published) throw new Error(`"${row.data.name}" has not been published yet`);
  const childId = await startRun({ row, mode: 'live', source: 'call', input, userId: parent.started_by, host: host || parent.host,
                                   parentRunId: parent.id || null });
  const child = await workRun(childId, { host, budgetMs });
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
        orgId: loaded.row.org_id, ownerId: loaded.row.user_id, actorId: user.userId, automationId: loaded.row.id,
        depth: 0, hardDeadline: Date.now() + 120 * 1000,
        callAutomation: (targetId, input) => callAutomation({
          targetId, input, orgId: loaded.row.org_id, parent: { started_by: user.userId, host, depth: 0 }, host, budgetMs: 60000 }),
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
    printed: String(maskSecrets(result.printed || '', secrets) || ''),
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
 * same statement that checks it is still due, so two overlapping ticks cannot
 * both fire it. A schedule that fell behind fires once, not once per missed
 * slot; an interval counts from the slot it was due at, so it does not drift.
 * One query reads the due automations with the host each last ran on, and
 * they are fired side by side.
 */
export async function fireDueSchedules(now = new Date()) {
  const due = await sql`
    select a.*, h.host as last_host
    from automations a
    left join lateral (
      select host from automation_runs r
      where r.automation_id = a.id and r.host is not null order by r.started_at desc limit 1
    ) h on true
    where a.enabled and a.published is not null and a.next_run_at is not null and a.next_run_at <= ${now}
    order by a.next_run_at
    limit 50
  `;
  const started = [];
  await eachLimited(due || [], 10, async (row) => {
    const scheduledFor = row.next_run_at;
    const trigger = (row.published && row.published.trigger) || {};
    let next = null;
    try { next = trigger.type === 'schedule' ? nextRunAfter(trigger.config, scheduledFor, now) : null; } catch { next = null; }
    const [claimed] = await sql`
      update automations set next_run_at = ${next}
      where id = ${row.id} and next_run_at = ${scheduledFor} returning id
    `;
    if (!claimed) return;
    try {
      started.push(await startRun({
        row, mode: 'live', source: 'schedule', host: row.last_host || null,
        input: { scheduledFor: new Date(scheduledFor).toISOString(), firedAt: now.toISOString() },
      }));
    } catch (err) {
      console.error(`[automations] schedule for ${row.id} did not start:`, err.message);
    }
  });
  return started;
}

/**
 * Runs that are due: queued, done waiting, or left by a function that died.
 *
 * Taken round-robin across organizations — each one's oldest first, at most
 * PER_ORG_PER_TICK each — so one organization's pile of runs cannot keep
 * everyone else's waiting.
 */
export async function dueRuns(limit = 20) {
  const rows = await sql`
    select id from (
      select id, resume_at,
             row_number() over (partition by org_id order by resume_at nulls first) as turn
      from automation_runs
      where (status in ('queued', 'waiting') and resume_at <= now())
         or (status = 'running' and heartbeat_at < now() - ${STALE_AFTER}::interval)
    ) due
    where turn <= ${PER_ORG_PER_TICK}
    order by turn, resume_at nulls first
    limit ${limit}
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
