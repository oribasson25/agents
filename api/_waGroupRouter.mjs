import { getNumber } from './_waControl.js';
import {
  actionsLastHour, callsAgent, contextWindow, getGroup, groupSettingsOf, insertGroupMessage,
  describeClaudeError, logGroupEvent, messagesSince, resolveMentions, setSeen, turnMode, upsertGroup,
} from './_waGroups.js';
import { decideGroup } from './_waGroupBrain.js';
import { createProactive, resolveSpeaker } from './_waGroupProactive.mjs';

// Messages older than this (delivered after the number was offline) never trigger a turn.
const STALE_MS = 10 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The groups side of one linked number (ported from the Grois group bot):
 * stores every group message, decides when a group needs a turn, merges
 * bursts, and carries out what the group brain decides — a reply (optionally
 * quoting), a reaction, a poll or a recap someone asked for, or nothing. It
 * also sends what the admin scheduled (see _waGroupProactive.mjs). Every
 * action, and every refusal by a limit, goes to the admin's activity log.
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

  // Scheduled messages, greetings and the welcome: what it does without being asked.
  const proactive = createProactive(wa, numberId, { nameOf });

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
    const mode = turnMode(group.mode, s, new Date(), group.muted_until);
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
    const mode = turnMode(group.mode, s, new Date(), group.muted_until);
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
    const { agentRow, apiConfig, error } = await resolveSpeaker(n, group);
    if (error) {
      await logGroupEvent(numberId, jid, 'error', { message: error });
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

    if (decision.action === 'summary') {
      // "What did I miss?": written from the whole stretch they asked about, not just the context window.
      await wa.setTyping(jid, true);
      const stretch = await messagesSince(numberId, jid, Date.now() - decision.hours * 3600_000);
      decision.text = await proactive.compose(n, group,
        `Someone asked what they missed. Write a recap of the last ${decision.hours} hours of the group's conversation for them: the topics, what was decided, open questions and anything someone is waiting on, with who said what where it matters. Short lines, most important first. If very little happened, say so in a line.`,
        { rows: stretch, recap: true });
      decision.action = 'reply';
      decision.target = fresh.at(-1);
    }

    if (decision.action === 'poll') {
      const waId = await wa.sendPoll(jid, decision.text, decision.options);
      if (waId) {
        await insertGroupMessage(numberId, {
          chatJid: jid, waId, senderJid: wa.state.me?.id, fromMe: true, ts: Date.now(),
          text: `[poll: ${decision.text} | ${decision.options.join(' / ')}]`,
        });
      }
    } else if (decision.action === 'reply') {
      if (!addressed) {
        // Typing for a moment reads like a person, not an instant bot.
        await wa.setTyping(jid, true);
        await sleep(Math.min(800 + decision.text.length * 25, 3500));
      }
      // "@Name" in the reply becomes a real mention.
      const tagged = decision.text.includes('@') ? resolveMentions(decision.text, await proactive.rosterOf(jid)) : { text: decision.text, mentions: [] };
      const waId = await wa.sendText(jid, tagged.text, decision.target, tagged.mentions);
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
      text: (decision.action === 'poll' ? `${decision.text}\n${decision.options.map((o) => `▫️ ${o}`).join('\n')}` : decision.text) || undefined,
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

  return { handle, drain, runDue: proactive.runDue };
}

