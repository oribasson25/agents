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
import { claim, markSent, markFailed, requeueStuck, jidOfRecipient, SEND_GAP_MS } from './_waOutbox.js';

// Messages older than this (delivered after the number was offline) never trigger a turn.
const STALE_MS = 10 * 60 * 1000;
// A quick burst of messages from one person becomes one turn.
const DEBOUNCE_MS = 2500;
// Images and PDFs bigger than this are described, not read.
const MAX_MEDIA_BYTES = 5 * 1024 * 1024;
// A conversation with the number's AI Chatbot ends after this much silence.
const SESSION_IDLE_MS = 30 * 60 * 1000;

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
export function createRouter(wa, numberId, { baseUrl }) {
  const pending = new Map(); // chatJid -> { timer, msgs, route }
  const busy = new Set();
  const rerun = new Map();
  const inflight = new Set();
  let number = null;
  let numberAt = 0;
  let draining = false;

  async function currentNumber() {
    if (!number || Date.now() - numberAt > 10_000) {
      number = await getNumber(numberId);
      numberAt = Date.now();
    }
    return number;
  }

  // Groups have their own rules: modes, limits, a decision per turn (see _waGroupRouter.mjs).
  const groups = createGroupRouter(wa, numberId);

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

    /* An automation may be waiting for exactly this message — an answer to
       an approval it asked for, or the thing its trigger listens for. When it
       takes the message, nobody else answers it. */
    const taken = await onWhatsAppMessage({ numberId, message: m, baseUrl }).catch((err) => {
      console.error(`[wa ${numberId}] automations could not look at a message:`, err.message);
      return null;
    });
    if (taken && taken.consumed) return;

    const [person] = await sql`
      select * from jarvis_people
      where number_id = ${numberId} and phone = ${m.senderPhone} and active
    `;
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

  async function turn(chatJid, { msgs, route }) {
    if (wa.state.status !== 'open') return;
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
    if (reply) await wa.sendText(chatJid, reply);
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
      agent = { ...chosen.agent, apiConfig: agent.apiConfig };
    }
    agent.canEndConversation = true;

    const context = normalizeHistory([...stored, userMsg].slice(-20));

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
    await sql`
      insert into chat_sessions (id, agent_id, source, messages, branch_id, started_at, updated_at)
      values (${sessionId}, ${agentId}, 'whatsapp', ${JSON.stringify(exchange)}, ${branchId}, now(), now())
      on conflict (id) do update
        set messages   = chat_sessions.messages || excluded.messages,
            updated_at = now()
    `;
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
    const [last] = await sql`
      select id, messages, updated_at > now() - ${`${SESSION_IDLE_MS} milliseconds`}::interval as recent
      from chat_sessions
      where agent_id = ${agentId} and (id = ${prefix} or starts_with(id, ${`${prefix}_`}))
      order by started_at desc
      limit 1
    `;
    const messages = Array.isArray(last?.messages) ? last.messages : [];
    if (last && last.recent && !messages.at(-1)?.ended) return { sessionId: last.id, stored: messages };
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
  let sendingOutbox = false;
  let lastRequeue = 0;
  async function sendOutbox() {
    if (wa.state.status !== 'open' || sendingOutbox || draining) return;
    sendingOutbox = true;
    try {
      if (Date.now() - lastRequeue > 60_000) { lastRequeue = Date.now(); await requeueStuck(numberId); }
      const rows = await claim(numberId, 5);
      for (const r of rows) {
        try {
          await wa.sendText(jidOfRecipient(r.recipient), r.body);
          await markSent(r.id);
        } catch (err) {
          console.error(`[wa ${numberId}] outbox ${r.id} not sent:`, err.message);
          await markFailed(r.id, err.message).catch(() => {});
        }
        await sleep(SEND_GAP_MS);
      }
    } finally {
      sendingOutbox = false;
    }
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
    const deadline = Date.now() + timeoutMs;
    while ((inflight.size || rerun.size) && Date.now() < deadline) await Promise.race([...inflight, sleep(500)]);
    await groupsDone;
  }

  /** Everything that came due on this number: people's reminders, and what its groups have scheduled. */
  async function runDue() {
    await sendDueReminders().catch((err) => console.warn(`[wa ${numberId}] reminders failed:`, err.message));
    await groups.runDue().catch((err) => console.warn(`[wa ${numberId}] group schedules failed:`, err.message));
  }

  return { drain, sendDueReminders, sendOutbox, runDue };
}

// Claude requires strict user/assistant alternation; merge consecutive turns of one role.
function normalizeHistory(messages) {
  const start = messages.findIndex((m) => m.role === 'user');
  if (start === -1) return [];
  const merged = [];
  for (const m of messages.slice(start)) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content = `${last.content}\n${m.content}`;
    else merged.push({ role: m.role, content: m.content });
  }
  return merged;
}
