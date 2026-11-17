import { sql } from './_db.js';
import { resolveAgentApiConfig } from './_settings.js';
import { getNumber } from './_waControl.js';
import {
  LATE_MS, contextWindow, describeClaudeError, groupSettingsOf, insertGroupMessage, listDates, logGroupEvent,
  messagesSince, proactiveOf, resolveMentions,
} from './_waGroups.js';
import { holidaysOn, isAnniversary, localParts, nextRun, shabbatTimes, yearsSince } from './_waGroupCalendar.js';
import { composeGroupMessage } from './_waGroupBrain.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const userPart = (jid) => String(jid || '').split('@')[0].split(':')[0];
const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

// How far back a scheduled recap reads when it has not run before.
const RECAP_FIRST_MS = { daily: 24 * 3600_000, weekly: 7 * 24 * 3600_000, monthly: 7 * 24 * 3600_000, once: 24 * 3600_000 };
const RECAP_MAX_MS = 7 * 24 * 3600_000;
// A recap of less than this is not worth a message.
const RECAP_MIN_MESSAGES = 5;

/**
 * Who speaks in a group: its AI Chatbot (else the number's) and the owner's
 * Claude key. Returns { agentRow, apiConfig } or { error } in words for the log.
 */
export async function resolveSpeaker(number, group) {
  const agentId = group.agent_id || number.agent_id;
  const [agentRow] = agentId ? await sql`select id, data, user_id from agents where id = ${agentId} and user_id = ${number.owner_user_id}` : [];
  if (!agentRow) return { error: 'No AI Chatbot is set for this group or this number.' };
  const apiConfig = await resolveAgentApiConfig(agentRow);
  if (apiConfig.provider !== 'claude' || !apiConfig.apiKey) return { error: 'Groups need a Claude API key in the owner account’s Settings.' };
  return { agentRow, apiConfig };
}

/**
 * What a linked number does in its groups without being asked: scheduled
 * messages and reminders, birthday, holiday and Shabbat greetings, and the
 * welcome for people who join. Everything here was set up by an admin on the
 * group's page; `runDue()` is called every half minute by the worker session.
 */
export function createProactive(wa, numberId, { nameOf }) {
  let running = false;

  /** The group's members with every name known for them: from WhatsApp, and from the stored conversation. */
  async function rosterOf(jid, extra = []) {
    const members = await wa.groupMembers(jid).catch(() => []);
    const seen = await sql`
      select distinct on (sender_jid) sender_jid, sender_name from wa_group_messages
      where number_id = ${numberId} and jid = ${jid} and not from_me and sender_name is not null and sender_jid is not null
      order by sender_jid, id desc
    `;
    const names = new Map(seen.map((r) => [userPart(r.sender_jid), r.sender_name]));
    const roster = members.map((m) => ({ ...m, name: m.name || names.get(userPart(m.jid)) || null }));
    for (const r of seen) if (!roster.some((m) => userPart(m.jid) === userPart(r.sender_jid))) roster.push({ jid: r.sender_jid, name: r.sender_name, phone: null });
    return [...extra, ...roster];
  }

  /** Sends a message written with "@Name" tags and stores it as the number's own. */
  async function say(jid, written, roster) {
    const { text, mentions } = resolveMentions(written, roster);
    const waId = await wa.sendText(jid, text, null, mentions);
    if (waId) await insertGroupMessage(numberId, { chatJid: jid, waId, senderJid: wa.state.me?.id, text: written, fromMe: true, ts: Date.now() });
    return waId;
  }

  /** How a person from the dates list is tagged: their member jid when they are in the group. */
  function tagFor(person, members) {
    if (!person.phone) return null;
    const member = members.find((m) => m.phone === person.phone || userPart(m.jid) === person.phone);
    return member?.jid || `${person.phone}@s.whatsapp.net`;
  }

  async function compose(number, group, brief, { rows, recap = false } = {}) {
    const speaker = await resolveSpeaker(number, group);
    if (speaker.error) throw new Error(speaker.error);
    const s = groupSettingsOf(number);
    const context = rows || (await contextWindow(numberId, group.jid, 30));
    const { text } = await composeGroupMessage({
      apiConfig: speaker.apiConfig, agent: speaker.agentRow.data, ownerId: number.owner_user_id,
      group, settings: s, name: nameOf(s), rows: context, brief, recap,
    });
    return text;
  }

  /* ---------- scheduled messages ---------- */

  async function runSchedules(number, s) {
    const due = await sql`
      select sc.*, g.mode from wa_group_schedules sc
      join wa_groups g on g.number_id = sc.number_id and g.jid = sc.jid
      where sc.number_id = ${numberId} and (sc.run_now or (sc.enabled and sc.next_run_at <= now()))
      order by sc.next_run_at nulls first limit 20
    `;
    for (const row of due) {
      const now = new Date();
      const manual = row.run_now;
      let claimed;
      if (manual) {
        // "Send now" is an extra run: the schedule's own next time stays as it is.
        [claimed] = await sql`update wa_group_schedules set run_now = false where id = ${row.id} and run_now returning id`;
      } else {
        const next = nextRun(row, now, s.timezone);
        [claimed] = await sql`
          update wa_group_schedules set next_run_at = ${next ? next.toISOString() : null}
          where id = ${row.id} and next_run_at = ${new Date(row.next_run_at).toISOString()} returning id
        `;
      }
      if (!claimed) continue;

      const finish = (status) => sql`update wa_group_schedules set last_run_at = now(), last_status = ${status} where id = ${row.id}`;
      const title = row.title || row.body.slice(0, 60);
      if (row.mode === 'off') {
        await finish('Skipped: the group is switched off');
        continue;
      }
      if (!manual && now - new Date(row.next_run_at) > LATE_MS) {
        await finish('Skipped: the number was offline at the time');
        await logGroupEvent(numberId, row.jid, 'skipped', { title, reason: 'The number was offline when this was due, and it was too late to send it.' });
        continue;
      }
      try {
        const sent = await sendScheduled(number, row);
        await finish(sent.skipped || 'Sent');
        await logGroupEvent(numberId, row.jid, sent.skipped ? 'skipped' : 'scheduled', { title, kind: row.kind, text: sent.text, reason: sent.skipped });
      } catch (err) {
        const message = describeClaudeError(err);
        await finish(`Failed: ${message}`.slice(0, 300));
        await logGroupEvent(numberId, row.jid, 'error', { title, message });
      }
    }
  }

  async function sendScheduled(number, row) {
    const group = await groupOf(row.jid);
    if (row.kind === 'poll') {
      const options = Array.isArray(row.poll_options) ? row.poll_options : [];
      const waId = await wa.sendPoll(row.jid, row.body, options);
      const text = `[poll: ${row.body} | ${options.join(' / ')}]`;
      if (waId) await insertGroupMessage(numberId, { chatJid: row.jid, waId, senderJid: wa.state.me?.id, text, fromMe: true, ts: Date.now() });
      return { text };
    }
    const roster = await rosterOf(row.jid);
    if (row.kind === 'text') {
      await say(row.jid, row.body, roster);
      return { text: row.body };
    }
    if (row.kind === 'summary') {
      const firstMs = RECAP_FIRST_MS[row.repeat] || RECAP_FIRST_MS.daily;
      const since = Math.max(row.last_run_at ? new Date(row.last_run_at).getTime() : Date.now() - firstMs, Date.now() - RECAP_MAX_MS);
      const rows = await messagesSince(numberId, row.jid, since);
      if (rows.filter((r) => !r.from_me).length < RECAP_MIN_MESSAGES) return { skipped: 'Skipped: too little was said to recap' };
      const brief = `Write a recap of this stretch of the group's conversation for people who were away: the topics, what was decided, open questions and anything someone is waiting on, with who said what where it matters. Short lines, most important first.${row.body ? ` The admin adds: ${row.body}` : ''}`;
      const text = await compose(number, group, brief, { rows, recap: true });
      await say(row.jid, text, roster);
      return { text };
    }
    // 'ai': the admin's brief, written fresh each time.
    const text = await compose(number, group, `The message is about: ${row.body}`);
    await say(row.jid, text, roster);
    return { text };
  }

  async function groupOf(jid) {
    const [group] = await sql`select * from wa_groups where number_id = ${numberId} and jid = ${jid}`;
    return group;
  }

  /* ---------- once a day: birthdays, holidays, Shabbat ---------- */

  async function runDaily(number, s) {
    const groups = await sql`select * from wa_groups where number_id = ${numberId} and mode <> 'off'`;
    const today = localParts(new Date(), s.timezone);
    const nowMin = today.hh * 60 + today.mm;
    for (const group of groups) {
      const p = proactiveOf(group);
      const state = group.proactive_state || {};
      const jobs = [
        ['birthdays', () => sendBirthdays(number, group, p.birthdays, today)],
        ['holidays', () => sendHolidays(number, group, today)],
        ['shabbat', () => sendShabbat(number, group, p.shabbat, today, s.timezone)],
      ];
      for (const [key, job] of jobs) {
        if (!p[key].on || state[key] === today.date || nowMin < toMin(p[key].time)) continue;
        // Mark the day first, so a second session or a crash can never greet twice.
        const [claimed] = await sql`
          update wa_groups set proactive_state = proactive_state || ${JSON.stringify({ [key]: today.date })}::jsonb
          where number_id = ${numberId} and jid = ${group.jid} and coalesce(proactive_state->>${key}, '') <> ${today.date}
          returning jid
        `;
        if (!claimed || nowMin - toMin(p[key].time) > LATE_MS / 60000) continue;
        try {
          await job();
        } catch (err) {
          await logGroupEvent(numberId, group.jid, 'error', { title: key, message: describeClaudeError(err) });
        }
      }
    }
  }

  async function sendBirthdays(number, group, cfg, today) {
    const people = (await listDates(numberId, group.jid)).filter((d) => d.greeted_on !== today.date && isAnniversary(d, today));
    if (!people.length) return;
    // Marked before sending: a greeting that fails is logged, never sent twice.
    await sql`update wa_group_dates set greeted_on = ${today.date} where id = any(${people.map((d) => d.id)}::bigint[])`;
    const members = await wa.groupMembers(group.jid).catch(() => []);
    // Each person is tagged by the name on the list, whatever their WhatsApp profile says.
    const tagged = people.map((d) => ({ ...d, jid: tagFor(d, members), age: yearsSince(d, today) }));
    const roster = await rosterOf(group.jid, tagged.filter((d) => d.jid).map((d) => ({ jid: d.jid, name: d.name, phone: d.phone })));

    if (cfg.mode === 'fixed' && cfg.text.trim()) {
      for (const d of tagged) {
        const text = cfg.text.replaceAll('{name}', d.jid ? `@${d.name}` : d.name).replaceAll('{age}', d.age ?? '');
        await say(group.jid, text, roster);
        await logGroupEvent(numberId, group.jid, 'birthday', { title: d.name, text });
      }
      return;
    }
    const what = (d) => {
      const years = d.age ? ` (${d.kind === 'birthday' ? `turning ${d.age}` : `${d.age} years`})` : '';
      const kind = d.kind === 'birthday' ? 'birthday' : d.kind === 'anniversary' ? 'anniversary' : d.label || 'special day';
      return `- ${d.name}: ${kind}${years}${d.jid ? `; tag them as "@${d.name}"` : '; not in the group, so no tag'}${d.note ? `; note from the admin: ${d.note}` : ''}`;
    };
    const brief = `Today the group celebrates:\n${tagged.map(what).join('\n')}\nWrite one warm message of congratulations in this group's own style, personal to ${tagged.length > 1 ? 'each of them' : 'them'} where you know them from the chat.`;
    const text = await compose(number, group, brief);
    await say(group.jid, text, roster);
    await logGroupEvent(numberId, group.jid, 'birthday', { title: tagged.map((d) => d.name).join(', '), text });
  }

  async function sendHolidays(number, group, today) {
    const holidays = holidaysOn(today);
    if (!holidays.length) return;
    const brief = `Greet the group for the holiday: ${holidays.map((h) => `${h.he} (${h.en})`).join('; ')}. A short, warm holiday greeting in this group's style.`;
    const text = await compose(number, group, brief);
    await say(group.jid, text, await rosterOf(group.jid));
    await logGroupEvent(numberId, group.jid, 'holiday', { title: holidays.map((h) => h.he).join(', '), text });
  }

  async function sendShabbat(number, group, cfg, today, tz) {
    if (today.weekday !== 5) return;
    const t = shabbatTimes(today, cfg.city, tz);
    if (!t) return;
    const brief = `It is Friday: wish the group Shabbat shalom, briefly and in this group's style, and include these times for ${t.city.he} (${t.city.name}) exactly as given: candle lighting ${t.candles}, Shabbat ends ${t.ends}.`;
    const text = await compose(number, group, brief);
    await say(group.jid, text, await rosterOf(group.jid));
    await logGroupEvent(numberId, group.jid, 'shabbat', { title: `${t.candles} – ${t.ends}`, text });
  }

  /* ---------- welcome ---------- */

  async function onJoined({ chatJid, joined }) {
    const number = await getNumber(numberId);
    const group = await groupOf(chatJid);
    if (!number?.enabled || !group || group.mode === 'off') return;
    const cfg = proactiveOf(group).welcome;
    if (!cfg.on || !cfg.text.trim()) return;
    await sleep(3000); // WhatsApp shows "X was added" first
    if (wa.state.status !== 'open') return;
    const mentions = joined.map((p) => p.jid);
    const text = cfg.text.replaceAll('{name}', joined.map((p) => `@${userPart(p.jid)}`).join(' '));
    const waId = await wa.sendText(chatJid, text, null, cfg.text.includes('{name}') ? mentions : []);
    const stored = cfg.text.replaceAll('{name}', joined.map((p) => wa.nameOf(p.jid) || 'new member').join(', '));
    if (waId) await insertGroupMessage(numberId, { chatJid, waId, senderJid: wa.state.me?.id, text: stored, fromMe: true, ts: Date.now() });
    await logGroupEvent(numberId, chatJid, 'welcome', { text: stored });
  }

  wa.on('joined', (ev) => {
    onJoined(ev).catch((err) => console.warn(`[wa ${numberId}] welcome failed:`, err.message));
  });

  /** Sends whatever came due. Safe to call often; one run at a time. */
  async function runDue() {
    if (running || wa.state.status !== 'open') return;
    running = true;
    try {
      const number = await getNumber(numberId);
      if (!number || !number.enabled) return;
      const s = groupSettingsOf(number);
      await runSchedules(number, s);
      await runDaily(number, s);
    } finally {
      running = false;
    }
  }

  return { runDue, rosterOf, compose };
}
