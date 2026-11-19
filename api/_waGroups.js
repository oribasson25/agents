import { sql } from './_db.js';
import { nextRun, SHABBAT_CITIES } from './_waGroupCalendar.js';

/*
 * Settings and storage for the WhatsApp groups a linked number is in (see
 * migration 025). No Baileys here: the admin endpoints import this too.
 */

export const GROUP_MODES = ['off', 'mention', 'smart', 'always'];
export const LEVELS = ['low', 'medium', 'high'];

/** Settings shared by every group of a number (wa_numbers.group_settings). */
export const GROUP_DEFAULTS = {
  callName: '',              // the name people call it by; empty: its WhatsApp profile name
  triggerWords: [],          // other words that count as calling it
  timezone: 'Asia/Jerusalem',
  quietFrom: '',             // "23:30"; empty: no quiet hours
  quietTo: '',
  maxActionsPerHour: 20,     // replies and reactions, per group
  unsolicitedPerHour: 12,    // "decides by itself": turns nobody asked for, per group (0 = no limit)
  quietGap: 2,               // "decides by itself": messages by others since it last spoke
  debounceSeconds: 4,        // a quick burst of messages becomes one turn
  contextMessages: 60,       // how much of the conversation it reads
};

const NUMBER_LIMITS = {
  maxActionsPerHour: [0, 200],
  unsolicitedPerHour: [0, 100],
  quietGap: [0, 50],
  debounceSeconds: [1, 30],
  contextMessages: [10, 200],
};

export function groupSettingsOf(number) {
  return { ...GROUP_DEFAULTS, ...((number && number.group_settings) || {}) };
}

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** A clean group_settings object from an admin's patch, or { error }. */
export function sanitizeGroupSettings(patch = {}, current = {}) {
  const next = { ...GROUP_DEFAULTS, ...current };
  if (patch.callName !== undefined) next.callName = String(patch.callName || '').trim().slice(0, 40);
  if (patch.triggerWords !== undefined) {
    const list = Array.isArray(patch.triggerWords) ? patch.triggerWords : String(patch.triggerWords || '').split(',');
    next.triggerWords = list.map((w) => String(w).trim()).filter(Boolean).slice(0, 20).map((w) => w.slice(0, 40));
  }
  if (patch.timezone !== undefined) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: String(patch.timezone) });
      next.timezone = String(patch.timezone);
    } catch {
      return { error: 'Unknown time zone.' };
    }
  }
  for (const k of ['quietFrom', 'quietTo']) {
    if (patch[k] === undefined) continue;
    const v = String(patch[k] || '').trim();
    if (v && !HHMM.test(v)) return { error: 'Quiet hours are times like 23:30.' };
    next[k] = v;
  }
  for (const [k, [min, max]] of Object.entries(NUMBER_LIMITS)) {
    if (patch[k] === undefined) continue;
    const n = Number(patch[k]);
    if (!Number.isInteger(n) || n < min || n > max) return { error: `${k} must be a whole number from ${min} to ${max}.` };
    next[k] = n;
  }
  return { settings: next };
}

/** The per-group fields an admin may change, cleaned; or { error }. */
export function sanitizeGroupPatch(patch = {}) {
  const out = {};
  if (patch.mode !== undefined) {
    if (!GROUP_MODES.includes(patch.mode)) return { error: 'Unknown mode.' };
    out.mode = patch.mode;
  }
  if (patch.agentId !== undefined) out.agentId = patch.agentId ? String(patch.agentId) : null;
  if (patch.instructions !== undefined) out.instructions = String(patch.instructions || '').slice(0, 8000);
  for (const k of ['engagement', 'replyLength']) {
    if (patch[k] === undefined) continue;
    if (!LEVELS.includes(patch[k])) return { error: `Unknown ${k}.` };
    out[k] = patch[k];
  }
  if (patch.allowReactions !== undefined) out.allowReactions = !!patch.allowReactions;
  if (patch.muteHours !== undefined) {
    const h = Number(patch.muteHours);
    if (!Number.isFinite(h) || h < 0 || h > 24 * 30) return { error: 'Mute for up to 30 days.' };
    out.mutedUntil = h ? new Date(Date.now() + h * 3600_000).toISOString() : null;
  }
  return { patch: out };
}

/** Whether `now` falls in the number's quiet hours, read in its own time zone. */
export function inQuietHours(s, now = new Date()) {
  const toMin = (v) => {
    const m = HHMM.exec(v || '');
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const from = toMin(s.quietFrom);
  const to = toMin(s.quietTo);
  if (from === null || to === null || from === to) return false;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: s.timezone || 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now);
  const cur = Number(parts.find((p) => p.type === 'hour').value) * 60 + Number(parts.find((p) => p.type === 'minute').value);
  return from < to ? cur >= from && cur < to : cur >= from || cur < to;
}

/** "Decides by itself" and "every message" fall back to "only when addressed" in quiet hours. */
export function turnMode(mode, s, now = new Date(), mutedUntil = null) {
  if (mode !== 'smart' && mode !== 'always') return mode;
  if (inQuietHours(s, now)) return 'mention';
  // Muted by an admin: the same as quiet hours, until the time they chose.
  if (mutedUntil && new Date(mutedUntil) > now) return 'mention';
  return mode;
}

const stripGeresh = (v) => v.replace(/[׳'’`"״]/g, '');
const escapeRe = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True when the text calls it by name or a trigger word (Hebrew prefixes such as ו/ה/ש allowed). */
export function callsAgent(text, names) {
  const words = names.map((w) => stripGeresh(w || '').trim()).filter(Boolean);
  if (!words.length) return false;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])[והלשבכמ]{0,2}(?:${words.map(escapeRe).join('|')})(?![\\p{L}\\p{N}])`, 'iu');
  return re.test(stripGeresh(String(text || '')));
}

/** A Claude API error in words an admin can act on. */
/** A model call that failed, in words for the admin's activity log. (Named before models moved to OpenRouter.) */
export function describeClaudeError(err) {
  if (err?.code === 'NO_MODEL') return 'The platform has not chosen a model for this account yet.';
  if (err?.code === 'NO_PLATFORM_KEY') return 'The platform has no model key set up yet.';
  if (err?.status === 429) return 'The model is rate limited; try again in a minute.';
  return err?.message || String(err);
}

/* ---------- storage ---------- */

/** Records that the number is in a group. A new group starts switched off. */
export async function upsertGroup(numberId, jid, name = null) {
  await sql`
    insert into wa_groups (number_id, jid, name) values (${numberId}, ${jid}, ${name})
    on conflict (number_id, jid) do update
      set name = coalesce(excluded.name, wa_groups.name),
          updated_at = case when excluded.name is distinct from wa_groups.name and excluded.name is not null
                            then now() else wa_groups.updated_at end
  `;
}

export async function getGroup(numberId, jid) {
  const [row] = await sql`select * from wa_groups where number_id = ${numberId} and jid = ${jid}`;
  return row || null;
}

/** Stores one group message; returns its row, or null when it was already stored. */
export async function insertGroupMessage(numberId, m) {
  const [row] = await sql`
    insert into wa_group_messages (number_id, jid, wa_id, sender_jid, sender_name, text, from_me, quoted_wa_id, quoted_text, ts)
    values (${numberId}, ${m.chatJid}, ${m.waId}, ${m.senderJid || null}, ${m.senderName || null}, ${String(m.text || '')},
            ${!!m.fromMe}, ${m.quotedWaId || null}, ${m.quotedText || null}, ${new Date(m.ts || Date.now()).toISOString()})
    on conflict (number_id, jid, wa_id) do nothing
    returning id
  `;
  return row || null;
}

/** The last `size` messages of a group, oldest first. */
export async function contextWindow(numberId, jid, size) {
  const rows = await sql`
    select id, wa_id, sender_jid, sender_name, text, from_me, quoted_wa_id, quoted_text, ts
    from wa_group_messages where number_id = ${numberId} and jid = ${jid}
    order by id desc limit ${size}
  `;
  return rows.reverse().map((r) => ({ ...r, id: Number(r.id), ts: new Date(r.ts).getTime() }));
}

// The actions in which it actually said something in the group.
const SPOKE = ['reply', 'react', 'poll', 'scheduled', 'birthday', 'holiday', 'shabbat', 'welcome'];

export async function logGroupEvent(numberId, jid, action, details = {}, { unsolicited = false } = {}) {
  await sql`
    insert into wa_group_events (number_id, jid, action, unsolicited, details)
    values (${numberId}, ${jid}, ${action}, ${unsolicited}, ${JSON.stringify(details)})
  `;
  if (SPOKE.includes(action)) {
    await sql`update wa_groups set last_activity_at = now() where number_id = ${numberId} and jid = ${jid}`;
  }
}

/** Replies and reactions in the last hour; `unsolicited` counts only turns nobody asked for. */
export async function actionsLastHour(numberId, jid, { unsolicited = false } = {}) {
  const [row] = unsolicited
    ? await sql`
        select count(*)::int as n from wa_group_events
        where number_id = ${numberId} and jid = ${jid} and action in ('reply', 'react', 'poll')
          and at > now() - interval '1 hour' and unsolicited`
    : await sql`
        select count(*)::int as n from wa_group_events
        where number_id = ${numberId} and jid = ${jid} and action in ('reply', 'react', 'poll')
          and at > now() - interval '1 hour'`;
  return row.n;
}

export async function setSeen(numberId, jid, id) {
  await sql`update wa_groups set seen_message_id = ${id} where number_id = ${numberId} and jid = ${jid}`;
}

/** Group messages and the activity log are kept for 30 days. */
export async function pruneGroups() {
  await sql`delete from wa_group_messages where ts < now() - interval '30 days'`;
  await sql`delete from wa_group_events where at < now() - interval '30 days'`;
  // One-time messages that went out (or were missed) long ago.
  await sql`delete from wa_group_schedules where repeat = 'once' and next_run_at is null and created_at < now() - interval '30 days' and coalesce(last_run_at, created_at) < now() - interval '30 days'`;
}

/* ---------- what it does on its own (migration 030) ---------- */

export const SCHEDULE_KINDS = ['text', 'ai', 'summary', 'poll'];
export const SCHEDULE_REPEATS = ['once', 'daily', 'weekly', 'monthly'];
export const DATE_KINDS = ['birthday', 'anniversary', 'other'];
export const MAX_SCHEDULES = 60;
export const MAX_DATES = 1500;
// A scheduled message that could not go out on time is still sent this late; after that it is skipped.
export const LATE_MS = 3 * 60 * 60 * 1000;

/** The daily things a group can have switched on (wa_groups.proactive). */
export const PROACTIVE_DEFAULTS = {
  birthdays: { on: true, time: '09:00', mode: 'ai', text: '' },   // mode: ai | fixed; fixed text may hold {name} and {age}
  holidays: { on: false, time: '09:00' },
  shabbat: { on: false, time: '12:00', city: 'tel-aviv' },
  welcome: { on: false, text: '' },                               // may hold {name}
};

export function proactiveOf(group) {
  const p = (group && group.proactive) || {};
  const out = {};
  for (const [k, d] of Object.entries(PROACTIVE_DEFAULTS)) out[k] = { ...d, ...(p[k] || {}) };
  return out;
}

/** A clean proactive object from an admin's patch, or { error }. */
export function sanitizeProactive(patch = {}, group = null) {
  const next = proactiveOf(group);
  for (const k of Object.keys(PROACTIVE_DEFAULTS)) {
    const p = patch[k];
    if (!p || typeof p !== 'object') continue;
    if (p.on !== undefined) next[k].on = !!p.on;
    if (p.time !== undefined && 'time' in next[k]) {
      if (!HHMM.test(String(p.time))) return { error: 'Times look like 09:00.' };
      next[k].time = String(p.time).padStart(5, '0');
    }
    if (p.text !== undefined && 'text' in next[k]) next[k].text = String(p.text || '').slice(0, 2000);
  }
  if (patch.birthdays?.mode !== undefined) {
    if (!['ai', 'fixed'].includes(patch.birthdays.mode)) return { error: 'Unknown greeting mode.' };
    next.birthdays.mode = patch.birthdays.mode;
  }
  if (patch.shabbat?.city !== undefined) {
    if (!SHABBAT_CITIES[patch.shabbat.city]) return { error: 'Unknown city.' };
    next.shabbat.city = patch.shabbat.city;
  }
  if (next.birthdays.mode === 'fixed' && next.birthdays.on && !next.birthdays.text.trim()) return { error: 'Write the fixed greeting, or let it write its own.' };
  if (next.welcome.on && !next.welcome.text.trim()) return { error: 'Write the welcome message first.' };
  return { proactive: next };
}

/** Digits only, in international form: "050-123 4567" → "972501234567". Empty when it is not a phone. */
export function normalizePhone(v) {
  let d = String(v ?? '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10 && d.startsWith('0')) d = `972${d.slice(1)}`;
  if (d.length === 9 && d.startsWith('5')) d = `972${d}`; // a spreadsheet dropped the leading zero
  return d.length >= 8 && d.length <= 15 ? d : '';
}

/**
 * A schedule from an admin's form, with when it first runs; or { error }.
 * `current` is the stored row when editing.
 */
export function sanitizeSchedule(body = {}, tz, current = null, now = new Date()) {
  const pick = (k, col = k) => (body[k] !== undefined ? body[k] : current ? current[col] : undefined);
  const s = {
    title: String(pick('title') || '').trim().slice(0, 80),
    kind: pick('kind') || 'text',
    body: String(pick('body') || '').trim().slice(0, 4000),
    poll_options: pick('pollOptions', 'poll_options') || [],
    repeat: pick('repeat') || 'once',
    on_date: pick('onDate', 'on_date') || null,
    at_time: String(pick('atTime', 'at_time') || ''),
    weekdays: pick('weekdays') || [],
    month_day: pick('monthDay', 'month_day') ?? null,
    enabled: body.enabled !== undefined ? !!body.enabled : current ? current.enabled : true,
  };
  if (!SCHEDULE_KINDS.includes(s.kind)) return { error: 'Unknown kind of message.' };
  if (!SCHEDULE_REPEATS.includes(s.repeat)) return { error: 'Unknown repeat.' };
  if (!HHMM.test(s.at_time)) return { error: 'Choose a time, like 09:00.' };
  s.at_time = s.at_time.padStart(5, '0');
  if (s.kind === 'text' && !s.body) return { error: 'Write the message.' };
  if (s.kind === 'ai' && !s.body) return { error: 'Say what the message should be about.' };
  if (s.kind === 'poll') {
    if (!s.body) return { error: 'Write the poll’s question.' };
    s.poll_options = (Array.isArray(s.poll_options) ? s.poll_options : []).map((o) => String(o || '').trim().slice(0, 100)).filter(Boolean);
    s.poll_options = [...new Set(s.poll_options)].slice(0, 12);
    if (s.poll_options.length < 2) return { error: 'A poll needs at least two answers.' };
  } else {
    s.poll_options = [];
  }
  if (s.repeat === 'once') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s.on_date || ''))) return { error: 'Choose the day.' };
    s.weekdays = []; s.month_day = null;
  } else if (s.repeat === 'weekly') {
    s.weekdays = [...new Set((Array.isArray(s.weekdays) ? s.weekdays : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    if (!s.weekdays.length) return { error: 'Choose at least one day of the week.' };
    s.on_date = null; s.month_day = null;
  } else if (s.repeat === 'monthly') {
    s.month_day = Number(s.month_day);
    if (!Number.isInteger(s.month_day) || s.month_day < 1 || s.month_day > 31) return { error: 'Choose a day of the month, 1 to 31.' };
    s.on_date = null; s.weekdays = [];
  } else {
    s.on_date = null; s.weekdays = []; s.month_day = null;
  }
  const next = nextRun(s, now, tz);
  if (s.repeat === 'once' && !next && (!current || body.onDate !== undefined || body.atTime !== undefined)) {
    return { error: 'That time has already passed.' };
  }
  s.next_run_at = next ? next.toISOString() : null;
  return { schedule: s };
}

/** One yearly date from a form or a spreadsheet row; or { error }. */
export function sanitizeDate(row = {}) {
  const name = String(row.name || '').trim().slice(0, 80);
  if (!name) return { error: 'A name is missing.' };
  const day = Number(row.day), month = Number(row.month);
  if (!Number.isInteger(month) || month < 1 || month > 12) return { error: `${name}: the month is not 1–12.` };
  if (!Number.isInteger(day) || day < 1 || day > new Date(Date.UTC(2024, month, 0)).getUTCDate()) return { error: `${name}: no such day in that month.` };
  let year = row.year == null || row.year === '' ? null : Number(row.year);
  if (year !== null && (!Number.isInteger(year) || year < 1900 || year > new Date().getFullYear())) year = null;
  const kind = DATE_KINDS.includes(row.kind) ? row.kind : 'birthday';
  const hebrew = !!row.hebrew;
  if (hebrew && !year) return { error: `${name}: the Hebrew date needs the year.` };
  return {
    date: {
      name, day, month, year, kind, hebrew,
      phone: normalizePhone(row.phone) || null,
      label: String(row.label || '').trim().slice(0, 80),
      note: String(row.note || '').trim().slice(0, 300),
    },
  };
}

export async function listSchedules(numberId, jid) {
  const rows = await sql`
    select * from wa_group_schedules where number_id = ${numberId} and jid = ${jid}
    order by next_run_at nulls last, id
  `;
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

export async function getSchedule(numberId, jid, id) {
  const [row] = await sql`select * from wa_group_schedules where id = ${id} and number_id = ${numberId} and jid = ${jid}`;
  return row || null;
}

export async function saveSchedule(numberId, jid, s, id = null) {
  if (id) {
    await sql`
      update wa_group_schedules set title = ${s.title}, kind = ${s.kind}, body = ${s.body}, poll_options = ${JSON.stringify(s.poll_options)},
             repeat = ${s.repeat}, on_date = ${s.on_date}, at_time = ${s.at_time}, weekdays = ${JSON.stringify(s.weekdays)},
             month_day = ${s.month_day}, next_run_at = ${s.next_run_at}, enabled = ${s.enabled}
      where id = ${id} and number_id = ${numberId} and jid = ${jid}
    `;
    return id;
  }
  const [row] = await sql`
    insert into wa_group_schedules (number_id, jid, title, kind, body, poll_options, repeat, on_date, at_time, weekdays, month_day, next_run_at, enabled)
    values (${numberId}, ${jid}, ${s.title}, ${s.kind}, ${s.body}, ${JSON.stringify(s.poll_options)}, ${s.repeat}, ${s.on_date}, ${s.at_time},
            ${JSON.stringify(s.weekdays)}, ${s.month_day}, ${s.next_run_at}, ${s.enabled})
    returning id
  `;
  return Number(row.id);
}

export async function listDates(numberId, jid) {
  const rows = await sql`
    select id, name, phone, kind, label, day, month, year, hebrew, note, greeted_on from wa_group_dates
    where number_id = ${numberId} and jid = ${jid} order by month, day, name
  `;
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

export async function insertDate(numberId, jid, d) {
  const [row] = await sql`
    insert into wa_group_dates (number_id, jid, name, phone, kind, label, day, month, year, hebrew, note)
    values (${numberId}, ${jid}, ${d.name}, ${d.phone}, ${d.kind}, ${d.label}, ${d.day}, ${d.month}, ${d.year}, ${d.hebrew}, ${d.note})
    returning id
  `;
  return Number(row.id);
}

/** A group's messages since `since`, oldest first; the newest `limit` when there are more. */
export async function messagesSince(numberId, jid, since, limit = 600) {
  const rows = await sql`
    select id, wa_id, sender_jid, sender_name, text, from_me, quoted_wa_id, quoted_text, ts
    from wa_group_messages where number_id = ${numberId} and jid = ${jid} and ts > ${new Date(since).toISOString()}
    order by id desc limit ${limit}
  `;
  return rows.reverse().map((r) => ({ ...r, id: Number(r.id), ts: new Date(r.ts).getTime() }));
}

const userPart = (jid) => String(jid || '').split('@')[0].split(':')[0];
const EVERYONE = /(?<![\p{L}\p{N}@])@(everyone|all|כולם)(?![\p{L}\p{N}])/iu;

/**
 * Turns the "@Name" tags a message was written with into WhatsApp mentions.
 * @param {string} text
 * @param {{ jid: string, name?: string, phone?: string }[]} roster  the group's members, as far as they are known
 * @returns {{ text: string, mentions: string[] }}  the text to send ("@<number>") and the jids it tags
 */
export function resolveMentions(text, roster) {
  let out = String(text || '');
  const mentions = new Set();
  const named = roster.filter((m) => m.jid && m.name && m.name.trim().length > 1).sort((a, b) => b.name.length - a.name.length);
  for (const m of named) {
    const re = new RegExp(`@${m.name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'giu');
    if (!re.test(out)) continue;
    out = out.replace(re, `@${userPart(m.jid)}`);
    mentions.add(m.jid);
  }
  // A tag already written as a number ("@972501234567") counts when that number is a member.
  for (const m of roster) {
    if (m.jid && [userPart(m.jid), m.phone].some((u) => u && out.includes(`@${u}`))) {
      if (m.phone && out.includes(`@${m.phone}`) && userPart(m.jid) !== m.phone) out = out.replaceAll(`@${m.phone}`, `@${userPart(m.jid)}`);
      mentions.add(m.jid);
    }
  }
  if (EVERYONE.test(out)) for (const m of roster) if (m.jid) mentions.add(m.jid);
  return { text: out, mentions: [...mentions] };
}
