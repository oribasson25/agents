import { sql } from './_db.js';
import { runAgentTurn, dlpMessages } from './_agentRunner.js';
import { resolveAgentApiConfig } from './_settings.js';
import { branchForSession, loadForConversation } from './_branches.js';
import { logError } from './_errorLog.js';
import { isStopped, stopMessage } from './_llm.js';
import { getNumber } from './_waControl.js';
import { runJarvisTurn, capabilityOn, recordAssistantMessage } from './_jarvis.js';
import { createGroupRouter } from './_waGroupRouter.mjs';
import { onWhatsAppMessage } from './_automationTriggers.js';
import { claim, markSent, markFailed, requeue, requeueStuck, retryableSendError, jidOfRecipient, SEND_GAP_MS } from './_waOutbox.js';
import { appendExchange, normalizeHistory, likePrefix, HISTORY_TURNS } from './_waHistory.js';

// Messages older than this (delivered after the number was offline) never trigger a turn.
const STALE_MS = 10 * 60 * 1000;
// A quick burst of messages from one person becomes one turn.
const DEBOUNCE_MS = 2500;
// Images and PDFs bigger than this are described, not read.
const MAX_MEDIA_BYTES = 5 * 1024 * 1024;
// A conversation with the number's AI Chatbot ends after this much silence.
const SESSION_IDLE_MS = 30 * 60 * 1000;
// How long the number's settings are trusted before they are read again.
const NUMBER_TTL_MS = 60_000;
/* Brakes on private chats. A linked number is somebody's real WhatsApp
   account: one that answers without end gets banned, and two bots answering
   each other run up model costs all night. */
const CHAT_REPLIES_MAX = 15;          // replies to one chat in CHAT_WINDOW_MIN minutes
const CHAT_WINDOW_MIN = 10;
const NUMBER_REPLIES_PER_HOUR = 300;  // replies in private chats, the whole number
// The other side answering this fast this many times in a row is a bot, not a person.
const LOOP_REPLY_MS = 5000;
const LOOP_STREAK = 4;
const LOOP_PAUSE_MS = 30 * 60 * 1000;
// No new outbox batch this close to the session's end: the next session sends it.
const OUTBOX_END_MS = 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jidOf = (phone) => `${phone}@s.whatsapp.net`;

/**
 * Wires one linked number's messages to whoever should answer them:
 *
 *   sender on the number's Jarvis list → that person's private Jarvis
 *   anyone else, number in 'agent' mode → the number's AI Chatbot
 *   anyone else, number in 'jarvis' mode → nobody
 *
 * One router lives for one worker session; drain() finishes what is in flight
 * before the session hands the connection over.
 */
export function createRouter(wa, numberId, { baseUrl, deadline = null }) {
  const pending = new Map(); // chatJid -> { timer, msgs, route }
  const busy = new Set();
  const rerun = new Map();
  const inflight = new Set();
  const pace = new Map();    // chatJid -> { repliedAt, awaiting, streak, pausedUntil }
  let number = null;
  let numberAt = 0;
  let draining = false;

  async function currentNumber() {
    if (!number || Date.now() - numberAt > NUMBER_TTL_MS) {
      number = await getNumber(numberId);
      numberAt = Date.now();
    }
    return number;
  }

  // Groups have their own rules: modes, limits, a decision per turn (see _waGroupRouter.mjs).
  const groups = createGroupRouter(wa, numberId, { currentNumber });

  wa.on('message', (m) => {
    if (m.isGroup) return void groups.handle(m);
    handle(m).catch((err) => {
      console.error(`[wa ${numberId}] could not handle a message:`, err.message);
    });
  });

  async function handle(m) {
    if (m.fromMe || !m.live || Date.now() - m.ts > STALE_MS) return;
    if (!m.senderPhone) return; // a LID WhatsApp would not map to a number: nobody to route by

    const [fresh] = await sql`
      insert into wa_seen (number_id, wa_id) values (${numberId}, ${m.waId})
      on conflict do nothing returning wa_id
    `;
    if (!fresh) return;

    const n = await currentNumber();
    if (!n || !n.enabled) return;

    const [person] = await sql`
      select * from jarvis_people
      where number_id = ${numberId} and phone = ${m.senderPhone} and active
    `;

    /* An automation may be waiting for exactly this message — an answer to
       an approval it asked for, or the thing its trigger listens for. When it
       takes the message, nobody else answers it. A person on the Jarvis list
       talks to their own private Jarvis: an automation that asked them
       something still gets the answer, but a trigger listening to every
       message on the number does not see theirs, unless an admin chose that
       for the number (group_settings.automationsSeeJarvis). */
    const triggers = !person || n.group_settings?.automationsSeeJarvis === true;
    const taken = await onWhatsAppMessage({ numberId, message: m, baseUrl, triggers }).catch((err) => {
      console.error(`[wa ${numberId}] automations could not look at a message:`, err.message);
      return null;
    });
    if (taken && taken.consumed) return;

    if (loopSuspected(m)) return;

    let route;
    if (person) route = { kind: 'jarvis', personId: person.id };
    else if (n.mode === 'agent' && n.agent_id) route = { kind: 'agent', agentId: n.agent_id };
    else return;

    const p = pending.get(m.chatJid) || { msgs: [] };
    p.msgs.push(m);
    p.route = route;
    clearTimeout(p.timer);
    if (draining) {
      pending.delete(m.chatJid);
      runTurn(m.chatJid, p);
      return;
    }
    p.timer = setTimeout(() => {
      pending.delete(m.chatJid);
      runTurn(m.chatJid, p);
    }, DEBOUNCE_MS);
    pending.set(m.chatJid, p);
  }

  function runTurn(chatJid, p) {
    if (busy.has(chatJid)) {
      const r = rerun.get(chatJid) || { msgs: [] };
      r.msgs.push(...p.msgs);
      r.route = p.route;
      rerun.set(chatJid, r);
      return;
    }
    busy.add(chatJid);
    const job = (async () => {
      try {
        await turn(chatJid, p);
      } catch (err) {
        console.error(`[wa ${numberId}] turn failed:`, err.message);
        await logError({
          agentId: p.route.kind === 'agent' ? p.route.agentId : null,
          source: 'whatsapp-linked',
          message: err.message,
          context: { numberId, route: p.route.kind },
        }).catch(() => {});
      } finally {
        await wa.setTyping(chatJid, false);
        busy.delete(chatJid);
        const again = rerun.get(chatJid);
        if (again) {
          rerun.delete(chatJid);
          runTurn(chatJid, again);
        }
      }
    })();
    inflight.add(job);
    job.finally(() => inflight.delete(job));
  }

  /**
   * Whether this message looks like the far side is a bot answering ours.
   * Only the first message after each reply counts, so a person sending a
   * quick burst is not mistaken for one. A suspected loop pauses the chat.
   */
  function loopSuspected(m) {
    const p = pace.get(m.chatJid);
    if (!p) return false;
    if (p.pausedUntil > Date.now()) return true;
    if (!p.awaiting) return false;
    // Written before our reply reached them (timestamps are whole seconds): not an answer to it.
    const after = m.ts - p.repliedAt;
    if (after < -1000) return false;
    p.awaiting = false;
    p.streak = after < LOOP_REPLY_MS ? p.streak + 1 : 0;
    if (p.streak < LOOP_STREAK) return false;
    p.streak = 0;
    p.pausedUntil = Date.now() + LOOP_PAUSE_MS;
    console.warn(`[wa ${numberId}] ${m.chatJid} answers every reply within seconds — pausing that chat`);
    logError({
      agentId: null, source: 'whatsapp-linked',
      message: `A private chat answered every reply within ${LOOP_REPLY_MS / 1000} seconds, ${LOOP_STREAK} times in a row, like another bot. The number stopped answering that chat for ${LOOP_PAUSE_MS / 60000} minutes.`,
      context: { numberId, chat: m.senderPhone },
    }).catch(() => {});
    return true;
  }

  /** Whether one more reply may go to this chat, by the chat's and the number's limits. */
  async function mayReply(chatJid, route) {
    const [row] = await sql`
      select count(*) filter (where chat = ${chatJid} and at > now() - ${`${CHAT_WINDOW_MIN} minutes`}::interval)::int as chat,
             count(*)::int as number
      from wa_dm_replies
      where number_id = ${numberId} and at > now() - interval '1 hour'
    `;
    const reason = row.chat >= CHAT_REPLIES_MAX
      ? `${CHAT_REPLIES_MAX} replies to one chat in ${CHAT_WINDOW_MIN} minutes`
      : row.number >= NUMBER_REPLIES_PER_HOUR ? `${NUMBER_REPLIES_PER_HOUR} replies in private chats in an hour` : null;
    if (!reason) return true;
    const p = pace.get(chatJid) || {};
    if (!p.limitedLogged || Date.now() - p.limitedLogged > 10 * 60 * 1000) {
      p.limitedLogged = Date.now();
      pace.set(chatJid, p);
      await logError({
        agentId: route.kind === 'agent' ? route.agentId : null, source: 'whatsapp-linked',
        message: `The number reached its limit of ${reason} and is not answering for now.`,
        context: { numberId },
      }).catch(() => {});
    }
    return false;
  }

  async function noteReply(chatJid) {
    const p = pace.get(chatJid) || { streak: 0, pausedUntil: 0 };
    p.repliedAt = Date.now();
    p.awaiting = true;
    pace.set(chatJid, p);
    await sql`insert into wa_dm_replies (number_id, chat) values (${numberId}, ${chatJid})`
      .catch((err) => console.warn(`[wa ${numberId}] could not count a reply:`, err.message));
  }

  async function turn(chatJid, { msgs, route }) {
    if (wa.state.status !== 'open') return;
    if (!(await mayReply(chatJid, route))) return;
    await wa.markRead(msgs.at(-1).raw);
    await wa.setTyping(chatJid, true);

    let reply;
    if (route.kind === 'jarvis') {
      const [person] = await sql`select * from jarvis_people where id = ${route.personId} and active`;
      if (!person) return;
      const n = await currentNumber();
      const attachments = await readAttachments(person, msgs);
      reply = await runJarvisTurn({
        person,
        number: n,
        texts: msgs.map((m) => m.text).filter(Boolean),
        attachments,
      });
    } else {
      reply = await agentTurn(route.agentId, msgs);
    }
    if (reply) {
      await wa.sendText(chatJid, reply);
      await noteReply(chatJid);
    }
  }

  /** Images and PDFs, read as the model's own input when this person's Jarvis may read them. */
  async function readAttachments(person, msgs) {
    if (!capabilityOn(person, 'docs')) return [];
    const out = [];
    for (const m of msgs) {
      if (m.kind !== 'image' && m.kind !== 'document') continue;
      const media = m.raw.message?.imageMessage || m.raw.message?.documentMessage
        || m.raw.message?.documentWithCaptionMessage?.message?.documentMessage;
      const mime = media?.mimetype || '';
      const size = Number(media?.fileLength || 0);
      const readable = mime.startsWith('image/') || mime === 'application/pdf';
      if (!readable || size > MAX_MEDIA_BYTES) continue;
      try {
        const buf = await wa.downloadMedia(m.raw);
        out.push({ mime: mime.split(';')[0], data: buf.toString('base64') });
      } catch (err) {
        console.warn(`[wa ${numberId}] could not download media:`, err.message);
      }
    }
    return out;
  }

  /** One turn of the number's AI Chatbot, stored like any other WhatsApp conversation. */
  async function agentTurn(agentId, msgs) {
    const [agentRow] = await sql`select id, data, user_id from agents where id = ${agentId}`;
    if (!agentRow) return null;
    let agent = { ...agentRow.data, apiConfig: await resolveAgentApiConfig(agentRow) };

    const text = msgs.map((m) => m.text).filter(Boolean).join('\n');
    if (!text.trim()) return null;
    const userMsg = { role: 'user', content: text };

    const { sessionId, stored } = await currentSession(agentId, msgs[0].senderPhone);
    const branchId = await branchForSession(agentId, sessionId);
    if (branchId) {
      const chosen = await loadForConversation(agentId, branchId);
      // A branch may run another model than main.
      agent = { ...chosen.agent, apiConfig: await resolveAgentApiConfig(agentRow, chosen.agent) };
    }
    agent.canEndConversation = true;

    const context = normalizeHistory([...stored, userMsg]);

    let reply;
    let ended = false;
    try {
      const result = await runAgentTurn({ agent, agentId, messages: context, baseUrl });
      ended = !!result.ended;
      reply = typeof result.text === 'string' ? result.text.trim() : '';
      if (!reply) {
        await logError({ agentId, source: 'whatsapp-linked', message: 'The provider returned an empty reply', context: { numberId } });
        reply = 'Sorry, I could not generate a reply. Please try again.';
      }
    } catch (err) {
      // "fetch failed" alone says nothing: the reason is on err.cause.
      const cause = err.cause ? ` (${err.cause.code || err.cause.message || err.cause})` : '';
      await logError({ agentId, source: 'whatsapp-linked', message: `${err.message}${cause}`, context: { code: err.code || null, numberId, baseUrl } });
      reply = isStopped(err) ? await stopMessage(userMsg.content)
        : err.code === 'NO_API_KEY'
        ? "This agent isn't fully configured yet. Please contact the owner."
        : 'Sorry, something went wrong. Please try again in a moment.';
    }

    // `ended` on the last message closes the session: the next message opens a new one.
    const exchange = [
      ...dlpMessages([userMsg], agent.dlp || {}),
      { role: 'assistant', content: reply, ...(ended ? { ended: true } : {}) },
    ];
    if (!(await appendExchange({ sessionId, agentId, branchId, exchange }))) {
      await logError({ agentId, source: 'whatsapp-linked', message: 'A conversation with this id belongs to something else; this exchange was not stored', context: { numberId, sessionId } });
    }
    return reply;
  }

  /**
   * The conversation a message belongs to. One person has a series of sessions
   * with the number's AI Chatbot: a new one starts after SESSION_IDLE_MS of
   * silence, or after the agent ended the last one (end_conversation).
   * Ids are `wal_<number>_<agent>_<phone>_<start ms>`; the bare
   * `wal_<number>_<agent>_<phone>` is the single session from before sessions ended.
   */
  async function currentSession(agentId, phone) {
    const prefix = `wal_${numberId}_${agentId}_${phone}`;
    /* Only the last HISTORY_TURNS messages leave the database, and the LIKE on
       (agent_id, id text_pattern_ops) — migration 038 — finds this person's
       sessions without reading every conversation of the chatbot. */
    const [last] = await sql`
      select id,
             updated_at > now() - ${`${SESSION_IDLE_MS} milliseconds`}::interval as recent,
             coalesce(((messages -> -1) ->> 'ended')::boolean, false) as ended,
             case when jsonb_typeof(messages) = 'array' then coalesce((
               select jsonb_agg(t.e order by t.i)
               from jsonb_array_elements(messages) with ordinality as t(e, i)
               where t.i > jsonb_array_length(messages) - ${HISTORY_TURNS}
             ), '[]'::jsonb) else '[]'::jsonb end as tail
      from chat_sessions
      where agent_id = ${agentId} and source = 'whatsapp'
        and (id = ${prefix} or id like ${likePrefix(`${prefix}_`)})
      order by started_at desc
      limit 1
    `;
    if (last && last.recent && !last.ended) return { sessionId: last.id, stored: Array.isArray(last.tail) ? last.tail : [] };
    return { sessionId: `${prefix}_${Date.now()}`, stored: [] };
  }

  /** Reminders that came due, sent to the people on this number. */
  async function sendDueReminders() {
    if (wa.state.status !== 'open') return;
    const due = await sql`
      update jarvis_reminders r set sent_at = now()
      from jarvis_people p
      where r.person_id = p.id
        and p.number_id = ${numberId}
        and p.active
        and r.sent_at is null
        and r.due_at <= now()
      returning r.id, r.text, r.person_id, p.phone
    `;
    for (const r of due) {
      const text = `⏰ ${r.text}`;
      try {
        await wa.sendText(jidOf(r.phone), text);
        await recordAssistantMessage(r.person_id, text);
      } catch (err) {
        console.error(`[wa ${numberId}] reminder ${r.id} not sent:`, err.message);
        await sql`update jarvis_reminders set sent_at = null where id = ${r.id}`;
      }
    }
  }

  /**
   * Messages automations asked this number to send, a few at a time and with
   * a pause between: a number that fires off a burst is a number that gets
   * banned.
   */
  let outboxJob = null;
  let lastRequeue = 0;
  const maySend = () => wa.state.status === 'open' && !draining && !(deadline && deadline - Date.now() < OUTBOX_END_MS);

  /** Sends one batch; resolves with how many messages it claimed (0: nothing to do, or not now). */
  function sendOutbox() {
    if (outboxJob) return Promise.resolve(0);
    outboxJob = sendBatch().finally(() => { outboxJob = null; });
    return outboxJob;
  }

  async function sendBatch() {
    if (!maySend()) return 0;
    if (Date.now() - lastRequeue > 60_000) { lastRequeue = Date.now(); await requeueStuck(numberId); }
    const rows = await claim(numberId, 5);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      /* The session is ending or the socket went away: what is left goes back
         to the queue for the next session, instead of failing for good. */
      if (!maySend()) {
        await requeue(rows.slice(i).map((x) => x.id)).catch(() => {});
        break;
      }
      try {
        await wa.sendText(jidOfRecipient(r.recipient), r.body);
      } catch (err) {
        console.error(`[wa ${numberId}] outbox ${r.id} not sent:`, err.message);
        if (retryableSendError(err) || wa.state.status !== 'open') {
          await requeue(rows.slice(i).map((x) => x.id)).catch(() => {});
          break;
        }
        await markFailed(r.id, err.message).catch(() => {});
        continue;
      }
      await markSent(r.id).catch((err) => console.warn(`[wa ${numberId}] outbox ${r.id} sent, not marked:`, err.message));
      if (i < rows.length - 1) await sleep(SEND_GAP_MS);
    }
    return rows.length;
  }

  /** End of session: run debounced turns now and wait up to `timeoutMs` for running ones. */
  async function drain(timeoutMs) {
    draining = true;
    const groupsDone = groups.drain(timeoutMs);
    for (const [jid, p] of pending) {
      clearTimeout(p.timer);
      pending.delete(jid);
      runTurn(jid, p);
    }
    const until = Date.now() + timeoutMs;
    while ((inflight.size || rerun.size) && Date.now() < until) await Promise.race([...inflight, sleep(500)]);
    // A batch already sending finishes its current message and puts the rest back.
    if (outboxJob) await Promise.race([outboxJob.catch(() => {}), sleep(Math.max(0, until - Date.now()))]);
    await groupsDone;
  }

  /** Everything that came due on this number: people's reminders, and what its groups have scheduled. */
  async function runDue() {
    await sendDueReminders().catch((err) => console.warn(`[wa ${numberId}] reminders failed:`, err.message));
    await groups.runDue().catch((err) => console.warn(`[wa ${numberId}] group schedules failed:`, err.message));
  }

  return { drain, sendDueReminders, sendOutbox, runDue };
}
