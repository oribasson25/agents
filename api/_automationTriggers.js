/**
 * The triggers that are not a clock or an address: a WhatsApp message, a new
 * email, a new row in a table. Each ends the same way — `startRun` with what
 * happened as the run's input.
 *
 * Also here, because it arrives the same way a WhatsApp trigger does: the
 * reply to an approval question, which wakes the run that asked it.
 */
import { sql } from './_db.js';
import { startRun, workRun } from './_automations.js';
import { useConnection } from './_connections.js';
import { mailSince } from './_mail.js';
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
 * First, an approval: if a run is waiting for this person's yes or no on
 * this number and this is one, the run is woken with it. Otherwise, every
 * live automation listening on this number that the message matches is
 * started.
 *
 * Returns `{ consumed }` — true when the message was the automation's and
 * the number's chatbot or Jarvis should not also answer it.
 */
export async function onWhatsAppMessage({ numberId, message, baseUrl }) {
  const host = hostOf(baseUrl);
  const phone = message.senderPhone;
  if (!phone) return { consumed: false };

  const answer = readAnswer(message.text);
  if (answer) {
    const [waiting] = await sql`
      select id from automation_runs
      where status = 'waiting'
        and state->'wait'->>'kind' = 'approval'
        and state->'wait'->>'numberId' = ${numberId}
        and state->'wait'->>'phone' = ${phone}
        and state->'wait'->'answer' is null
      order by started_at limit 1
    `;
    if (waiting) {
      const given = { answer, text: String(message.text || '').slice(0, 500), at: new Date().toISOString() };
      const [woken] = await sql`
        update automation_runs
        set state = jsonb_set(state, '{wait,answer}', ${JSON.stringify(given)}::jsonb), resume_at = now()
        where id = ${waiting.id} and status = 'waiting' returning id
      `;
      if (woken) { workSoon(woken.id, host); return { consumed: true, approval: woken.id }; }
    }
  }

  const listening = await sql`
    select a.* from automations a
    join connections c
      on c.org_id = a.org_id and c.kind = 'whatsapp' and c.data->>'numberId' = ${numberId}
     and lower(c.name) = lower(a.published->'trigger'->'config'->>'connection')
    where a.enabled and a.published->'trigger'->>'type' = 'whatsapp'
  `;
  let consumed = false;
  const started = [];
  for (const row of listening) {
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
      select * from automations
      where enabled and org_id = ${table.org_id}
        and published->'trigger'->>'type' = 'table'
        and published->'trigger'->'config'->>'table' = ${table.id}
    `) || [];
    const started = [];
    for (const auto of watching) {
      if (writtenBy === `automation:${auto.id}`) continue;
      const [last] = (await sql`select host from automation_runs where automation_id = ${auto.id} and host is not null order by started_at desc limit 1`) || [];
      started.push(await startRun({
        row: auto, mode: 'live', source: 'table', host: last ? last.host : null,
        input: { table: { id: table.id, name: table.name }, rowId: row.id, row: { id: row.id, ...(row.data || {}) }, addedBy: writtenBy },
      }));
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
 * (`trigger_state.since`), moved forward only past messages a run was
 * actually started for — so a failure to start is retried on the next look
 * rather than skipped.
 */
export async function pollEmailTriggers() {
  const watching = await sql`
    select * from automations
    where enabled and published is not null and published->'trigger'->>'type' = 'email'
    limit 100
  `;
  let started = 0;
  for (const row of watching) {
    const config = (row.published.trigger && row.published.trigger.config) || {};
    const state = row.trigger_state || {};
    if (!state.since) {
      await sql`update automations set trigger_state = ${JSON.stringify({ since: new Date().toISOString() })}::jsonb where id = ${row.id}`;
      continue;
    }
    try {
      const conn = await useConnection({ orgId: row.org_id, name: config.connection, kinds: ['gmail', 'microsoft'] });
      const fresh = await mailSince(conn, { since: state.since, query: config.query });
      let since = state.since;
      const [last] = await sql`select host from automation_runs where automation_id = ${row.id} and host is not null order by started_at desc limit 1`;
      for (const m of fresh) {
        await startRun({ row, mode: 'live', source: 'email', host: last ? last.host : null,
                         input: { id: m.id, from: m.from, fromName: m.fromName, to: m.to, subject: m.subject, text: m.text, date: m.date } });
        since = m.date;
        started++;
      }
      if (since !== state.since || state.error) {
        await sql`update automations set trigger_state = ${JSON.stringify({ since })}::jsonb where id = ${row.id}`;
      }
    } catch (err) {
      if (state.error !== err.message) {
        await sql`update automations set trigger_state = ${JSON.stringify({ ...state, error: err.message })}::jsonb where id = ${row.id}`.catch(() => {});
      }
    }
  }
  return started;
}
