/**
 * The triggers that are not a clock or an address: a WhatsApp message, a new
 * email, a new row in a table. Each ends the same way — `startRun` with what
 * happened as the run's input.
 *
 * Also here, because it arrives the same way a WhatsApp trigger does: the
 * reply to an approval question, which wakes the run that asked it.
 */
import { sql } from './_db.js';
import { startRun, workRun, eachLimited } from './_automations.js';
import { useConnection } from './_connections.js';
import { pollMailbox } from './_mail.js';
import { normalizePhone } from './_waControl.js';
import { readAnswer } from './_automationConnected.js';

const hostOf = (baseUrl) => { try { return new URL(baseUrl).host; } catch { return null; } };

/** Works a run without holding the caller up; a failure is logged, never thrown. */
function workSoon(runId, host) {
  workRun(runId, { host }).catch((err) => console.error('[automations] run', runId, err.message));
}

/* ─────────────────── WhatsApp ─────────────────── */

function whatsappMatches(config, message) {
  const text = String(message.text || '');
  const allowed = String(config.from || '').split(/[,\n;]/).map(normalizePhone).filter(Boolean);
  if (allowed.length && !allowed.includes(message.senderPhone)) return false;
  const want = String(config.text || '').trim().toLowerCase();
  if (config.match === 'contains') return !!want && text.toLowerCase().includes(want);
  if (config.match === 'starts') return !!want && text.trim().toLowerCase().startsWith(want);
  return true;
}

/**
 * A direct message that reached a linked number.
 *
 * First, a run that is waiting on this person. If one asked them for a yes or
 * no on this number and this is one, it is woken with it. If one is waiting
 * for their reply — whatever they write — it is woken with the message; when
 * several are, the one that has waited longest. Only when no run is waiting
 * for the message is every live automation listening on this number that it
 * matches started.
 *
 * Returns `{ consumed }` — true when the message was the automation's and
 * the number's chatbot or Jarvis should not also answer it.
 */
export async function onWhatsAppMessage({ numberId, message, baseUrl, triggers = true }) {
  const host = hostOf(baseUrl);
  const phone = message.senderPhone;
  if (!phone) return { consumed: false };

  /* One look for a run waiting on this person (partial index on number and
     phone, migration 039): an approval first when this is a yes or a no,
     else whichever has waited longest for their reply. */
  const answer = readAnswer(message.text);
  const kinds = answer ? ['approval', 'reply'] : ['reply'];
  const [waiting] = await sql`
    select id, state->'wait'->>'kind' as kind from automation_runs
    where status = 'waiting'
      and state->'wait'->>'numberId' = ${numberId}
      and state->'wait'->>'phone' = ${phone}
      and state->'wait'->>'kind' = any(${kinds})
      and state->'wait'->'answer' is null
    order by (state->'wait'->>'kind' = 'approval') desc, started_at
    limit 1
  `;
  if (waiting) {
    const given = waiting.kind === 'approval'
      ? { answer, text: String(message.text || '').slice(0, 500), at: new Date().toISOString() }
      : { text: String(message.text || '').slice(0, 4000), name: message.senderName || '',
          kind: message.kind || 'text', at: new Date(message.ts || Date.now()).toISOString() };
    const [woken] = await sql`
      update automation_runs
      set state = jsonb_set(state, '{wait,answer}', ${JSON.stringify(given)}::jsonb), resume_at = now()
      where id = ${waiting.id} and status = 'waiting' returning id
    `;
    if (woken) {
      workSoon(woken.id, host);
      return waiting.kind === 'approval' ? { consumed: true, approval: woken.id } : { consumed: true, reply: woken.id };
    }
  }

  /* `triggers: false` — the router says this sender is someone Jarvis talks
     to and the admin has not let automations see them: a wait that asked
     them something is still answered, but no listening automation may read
     (and swallow) their private messages. */
  if (!triggers) return { consumed: false, started: [] };

  /* Live automations listening on this number — only those whose publisher
     may use its connection. */
  const listening = await sql`
    select a.*
    from automations a
    join connections c
      on c.org_id = a.org_id and c.kind = 'whatsapp' and c.data->>'numberId' = ${numberId}
     and lower(c.name) = lower(a.published->'trigger'->'config'->>'connection')
    left join users pu on pu.id = coalesce(a.published_by, a.user_id)
    where a.enabled and a.published->'trigger'->>'type' = 'whatsapp'
      and (c.shared is not false or c.created_by = coalesce(a.published_by, a.user_id)
           or coalesce(pu.is_admin, false) or (pu.org_role = 'admin' and pu.org_id = c.org_id))
  `;
  let consumed = false;
  const started = [];
  for (const row of listening || []) {
    const config = (row.published.trigger && row.published.trigger.config) || {};
    if (!whatsappMatches(config, message)) continue;
    try {
      const runId = await startRun({
        row, mode: 'live', source: 'whatsapp', host,
        input: { from: phone, name: message.senderName || '', text: String(message.text || ''),
                 kind: message.kind || 'text', at: new Date(message.ts || Date.now()).toISOString() },
      });
      started.push(runId);
      workSoon(runId, host);
      if (!config.alsoChatbot) consumed = true;
    } catch (err) {
      console.error(`[automations] ${row.id} did not start on a WhatsApp message:`, err.message);
    }
  }
  return { consumed, started };
}

/* ─────────────────── a new row in a table ─────────────────── */

/**
 * A row was added to a table: start every live automation watching it.
 *
 * A row an automation added does not start that same automation again — a
 * flow that files what it receives must not feed itself forever.
 * Returns the runs it started; never throws.
 */
export async function onRowAdded({ table, row, writtenBy }) {
  try {
    const watching = (await sql`
      select a.*, h.host as last_host
      from automations a
      left join lateral (
        select host from automation_runs r
        where r.automation_id = a.id and r.host is not null order by r.started_at desc limit 1
      ) h on true
      where a.enabled and a.org_id = ${table.org_id}
        and a.published->'trigger'->>'type' = 'table'
        and a.published->'trigger'->'config'->>'table' = ${table.id}
    `) || [];
    const started = [];
    for (const auto of watching) {
      if (writtenBy === `automation:${auto.id}`) continue;
      /* A row written by another automation's run starts this one a level
         deeper (see startRun), so two that feed each other through a table
         stop after LIMITS.callDepth rounds instead of running forever. */
      try {
        started.push(await startRun({
          row: auto, mode: 'live', source: 'table', host: auto.last_host || null,
          input: { table: { id: table.id, name: table.name }, rowId: row.id, row: { id: row.id, ...(row.data || {}) }, addedBy: writtenBy },
        }));
      } catch (err) {
        console.error(`[automations] ${auto.id} did not start on a new row:`, err.message);
      }
    }
    return started;
  } catch (err) {
    console.error('[automations] table trigger:', err.message);
    return [];
  }
}

/* ─────────────────── a new email ─────────────────── */

/**
 * Looks in every watched mailbox for mail that arrived since the last look,
 * and starts a run for each message. Called by the cron, once a minute.
 *
 * What a trigger has already seen is kept on the automation
 * (`trigger_state.since`), written after each run it starts — so a failure
 * part-way is retried from the message that failed, never from the start —
 * and then moved past everything that was looked at (see pollMailbox).
 *
 * Each mailbox is locked while it is looked at (`trigger_state.polling`, one
 * UPDATE that only succeeds when nobody holds it or the holder has been gone
 * five minutes), so two overlapping ticks never start runs for the same mail.
 * Mailboxes are looked at side by side, least recently looked at first, each
 * call with its own timeout, and no new one is started once `budgetMs` is
 * spent.
 */
export async function pollEmailTriggers({ budgetMs = 90 * 1000, concurrency = 8 } = {}) {
  const until = Date.now() + budgetMs;
  const watching = await sql`
    select a.id
    from automations a
    where a.enabled and a.published is not null and a.published->'trigger'->>'type' = 'email'
    order by (a.trigger_state->>'polledAt') nulls first
    limit 100
  `;
  let started = 0;
  await eachLimited(watching || [], concurrency, async ({ id }) => {
    if (Date.now() > until) return;
    const [row] = await sql`
      update automations
      set trigger_state = coalesce(trigger_state, '{}'::jsonb) || jsonb_build_object('polling', now())
      where id = ${id} and enabled
        and (trigger_state->>'polling' is null or (trigger_state->>'polling')::timestamptz < now() - interval '5 minutes')
      returning *, (
        select host from automation_runs r
        where r.automation_id = automations.id and r.host is not null order by r.started_at desc limit 1
      ) as last_host
    `;
    if (!row) return;
    const config = (row.published && row.published.trigger && row.published.trigger.config) || {};
    const prior = row.trigger_state || {};
    const save = (next) => sql`
      update automations set trigger_state = ${JSON.stringify(next)}::jsonb where id = ${row.id}
    `.catch(() => {});
    if (!prior.since) {
      await save({ since: new Date().toISOString(), polledAt: new Date().toISOString() });
      return;
    }
    let since = prior.since;
    try {
      const conn = await useConnection({ orgId: row.org_id, name: config.connection, kinds: ['gmail', 'microsoft'],
                                         userId: row.published_by || row.user_id });
      const { messages, cursor } = await pollMailbox(conn, { since, query: config.query });
      for (const m of messages) {
        await startRun({ row, mode: 'live', source: 'email', host: row.last_host || null,
                         input: { id: m.id, from: m.from, fromName: m.fromName, to: m.to, subject: m.subject, text: m.text, date: m.date } });
        since = m.date;
        started++;
        await save({ since, polling: new Date().toISOString() });
      }
      if (cursor && new Date(cursor) > new Date(since)) since = cursor;
      await save({ since, polledAt: new Date().toISOString() });
    } catch (err) {
      await save({ since, polledAt: new Date().toISOString(), error: String(err.message || err).slice(0, 300) });
    }
  });
  return started;
}
