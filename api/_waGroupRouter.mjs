import { sql } from './_db.js';
import { resolveAgentApiConfig } from './_settings.js';
import { getNumber } from './_waControl.js';
import {
  actionsLastHour, callsAgent, contextWindow, getGroup, groupSettingsOf, insertGroupMessage,
  describeClaudeError, logGroupEvent, setSeen, turnMode, upsertGroup,
} from './_waGroups.js';
import { decideGroup } from './_waGroupBrain.js';

// Messages older than this (delivered after the number was offline) never trigger a turn.
const STALE_MS = 10 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The groups side of one linked number (ported from the Grois group bot):
 * stores every group message, decides when a group needs a turn, merges
 * bursts, and carries out what the group brain decides — a reply (optionally
 * quoting), a reaction, or nothing. Every action, and every refusal by a
 * limit, goes to the admin's activity log.
 *
 * One lives for one worker session; drain() finishes what is in flight.
 */
export function createGroupRouter(wa, numberId) {
  const pending = new Map(); // group jid -> { timer, addressed }
  const busy = new Set();
  const rerun = new Map();   // group jid -> addressed, for turns asked for while one was running
  const inflight = new Set();
  let draining = false;
  let queue = Promise.resolve(); // messages are stored one at a time, so ids follow arrival order
  let number = null;
  let numberAt = 0;

  async function currentNumber() {
    if (!number || Date.now() - numberAt > 10_000) {
      number = await getNumber(numberId);
      numberAt = Date.now();
    }
    return number;
  }

  /** The name it goes by in groups: the admin's choice, else the WhatsApp profile name. */
  function nameOf(s) {
    return s.callName || wa.state.me?.name || 'Assistant';
  }
  wa.selfName = () => (number ? nameOf(groupSettingsOf(number)) : wa.state.me?.name || null);

  wa.on('groups', (groups) => {
    queue = queue
      .then(async () => { for (const g of groups) await upsertGroup(numberId, g.jid, g.name); })
      .catch((err) => console.warn(`[wa ${numberId}] could not record groups:`, err.message));
  });

  function handle(m) {
    queue = queue.then(() => store(m)).catch((err) => console.error(`[wa ${numberId}] group message failed:`, err.message));
    return queue;
  }

  async function store(m) {
    const known = await getGroup(numberId, m.chatJid);
    if (!known) {
      await upsertGroup(numberId, m.chatJid, null);
      wa.refreshGroup?.(m.chatJid);
    }
    const row = await insertGroupMessage(numberId, m);
    if (!row || m.fromMe || !m.live || Date.now() - m.ts > STALE_MS) return;

    const n = await currentNumber();
    if (!n || !n.enabled) return;
    const group = known || (await getGroup(numberId, m.chatJid));
    const s = groupSettingsOf(n);
    const mode = turnMode(group.mode, s);
    if (mode === 'off') return;
    const addressed = !!(m.mentionsMe || m.repliesToMe || callsAgent(m.text, [nameOf(s), ...s.triggerWords]));
    if (mode === 'mention' && !addressed) return;

    const p = pending.get(m.chatJid) || { addressed: false };
    p.addressed ||= addressed;
    clearTimeout(p.timer);
    if (draining) {
      pending.delete(m.chatJid);
      runTurn(m.chatJid, p.addressed);
      return;
    }
    p.timer = setTimeout(() => {
      pending.delete(m.chatJid);
      runTurn(m.chatJid, p.addressed);
    }, s.debounceSeconds * 1000);
    pending.set(m.chatJid, p);
  }

  function runTurn(jid, addressed) {
    if (busy.has(jid)) {
      rerun.set(jid, rerun.get(jid) || addressed);
      return;
    }
    busy.add(jid);
    const job = (async () => {
      try {
        await turn(jid, addressed);
      } catch (err) {
        console.error(`[wa ${numberId}] group turn failed:`, err.message);
        await logGroupEvent(numberId, jid, 'error', { message: describeClaudeError(err) }).catch(() => {});
      } finally {
        await wa.setTyping(jid, false);
        busy.delete(jid);
        if (rerun.has(jid)) {
          const again = rerun.get(jid);
          rerun.delete(jid);
          runTurn(jid, again);
        }
      }
    })();
    inflight.add(job);
    job.finally(() => inflight.delete(job));
  }

  async function turn(jid, addressed) {
    if (wa.state.status !== 'open') return;
    const n = await currentNumber();
    const group = await getGroup(numberId, jid);
    if (!n || !n.enabled || !group) return;
    const s = groupSettingsOf(n);
    const mode = turnMode(group.mode, s);
    if (mode === 'off' || (mode === 'mention' && !addressed)) return;

    if (s.maxActionsPerHour && (await actionsLastHour(numberId, jid)) >= s.maxActionsPerHour) {
      await logGroupEvent(numberId, jid, 'limited', { reason: `Reached the limit of ${s.maxActionsPerHour} actions an hour` });
      return;
    }
    // Turns nobody asked for get hard limits too, so restraint does not depend on
    // the model alone. Skipped quietly: in a busy group they would flood the log.
    const unsolicited = mode === 'smart' && !addressed;
    if (unsolicited && s.unsolicitedPerHour && (await actionsLastHour(numberId, jid, { unsolicited: true })) >= s.unsolicitedPerHour) return;

    const rows = await contextWindow(numberId, jid, s.contextMessages);
    if (unsolicited && s.quietGap) {
      const lastMine = rows.findLastIndex((r) => r.from_me);
      if (lastMine >= 0 && rows.length - 1 - lastMine < s.quietGap) return;
    }
    const lastId = rows.at(-1)?.id || 0;
    const newFromId = group.seen_message_id != null ? Number(group.seen_message_id) + 1 : lastId;
    const fresh = rows.filter((r) => r.id >= newFromId && !r.from_me);
    if (!fresh.length) return;

    // Who answers: the group's AI Chatbot, else the number's. Only the owner's own.
    const agentId = group.agent_id || n.agent_id;
    const [agentRow] = agentId ? await sql`select id, data, user_id from agents where id = ${agentId} and user_id = ${n.owner_user_id}` : [];
    if (!agentRow) {
      await logGroupEvent(numberId, jid, 'error', { message: 'No AI Chatbot is set for this group or this number.' });
      return;
    }
    const apiConfig = await resolveAgentApiConfig(agentRow);
    if (apiConfig.provider !== 'claude' || !apiConfig.apiKey) {
      await logGroupEvent(numberId, jid, 'error', { message: 'Groups need a Claude API key in the owner account’s Settings.' });
      return;
    }

    if (addressed) await wa.setTyping(jid, true);
    const started = Date.now();
    const name = nameOf(s);
    const decision = await decideGroup({
      apiConfig, agent: agentRow.data, agentId: agentRow.id, ownerId: n.owner_user_id,
      group, settings: s, name, rows, newFromId, mode, addressed,
    });
    await setSeen(numberId, jid, lastId);

    if (decision.action === 'reply') {
      if (!addressed) {
        // Typing for a moment reads like a person, not an instant bot.
        await wa.setTyping(jid, true);
        await sleep(Math.min(800 + decision.text.length * 25, 3500));
      }
      const waId = await wa.sendText(jid, decision.text, decision.target);
      if (waId) {
        await insertGroupMessage(numberId, {
          chatJid: jid, waId, senderJid: wa.state.me?.id, text: decision.text, fromMe: true,
          quotedWaId: decision.target?.wa_id, quotedText: decision.target?.text, ts: Date.now(),
        });
      }
    } else if (decision.action === 'react' && decision.target) {
      await wa.react(jid, decision.target, decision.emoji);
    }

    await logGroupEvent(numberId, jid, decision.action, {
      text: decision.text || undefined,
      emoji: decision.emoji || undefined,
      trigger: fresh.at(-1).text.slice(0, 160),
      triggerFrom: fresh.at(-1).sender_name || undefined,
      addressed,
      mode,
      why: decision.why || undefined,
      model: decision.model,
      ms: Date.now() - started,
    }, { unsolicited: unsolicited && decision.action !== 'silent' });
  }

  /** End of session: run merged turns now and wait up to `timeoutMs` for running ones. */
  async function drain(timeoutMs) {
    draining = true;
    await queue;
    for (const [jid, p] of pending) {
      clearTimeout(p.timer);
      pending.delete(jid);
      runTurn(jid, p.addressed);
    }
    const deadline = Date.now() + timeoutMs;
    while ((inflight.size || rerun.size) && Date.now() < deadline) await Promise.race([...inflight, sleep(500)]);
  }

  return { handle, drain };
}

