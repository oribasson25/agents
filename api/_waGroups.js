import { sql } from './_db.js';

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
export function turnMode(mode, s, now = new Date()) {
  if ((mode === 'smart' || mode === 'always') && inQuietHours(s, now)) return 'mention';
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
export function describeClaudeError(err) {
  const status = err?.status;
  if (status === 401) return 'The Claude API key in the owner account’s Settings was refused.';
  if (status === 403) return 'The Claude API key may not use this model.';
  if (status === 404) return 'The model was not found for this Claude API key.';
  if (status === 429) return 'Claude rate limit reached; try again in a minute.';
  if (status === 400 && /credit balance/i.test(err.message || '')) return 'The Claude credit has run out.';
  if (status === 529 || status === 503) return 'Claude is overloaded right now; try again in a minute.';
  return err?.error?.error?.message || err?.message || String(err);
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

export async function logGroupEvent(numberId, jid, action, details = {}, { unsolicited = false } = {}) {
  await sql`
    insert into wa_group_events (number_id, jid, action, unsolicited, details)
    values (${numberId}, ${jid}, ${action}, ${unsolicited}, ${JSON.stringify(details)})
  `;
  if (action === 'reply' || action === 'react') {
    await sql`update wa_groups set last_activity_at = now() where number_id = ${numberId} and jid = ${jid}`;
  }
}

/** Replies and reactions in the last hour; `unsolicited` counts only turns nobody asked for. */
export async function actionsLastHour(numberId, jid, { unsolicited = false } = {}) {
  const [row] = unsolicited
    ? await sql`
        select count(*)::int as n from wa_group_events
        where number_id = ${numberId} and jid = ${jid} and action in ('reply', 'react')
          and at > now() - interval '1 hour' and unsolicited`
    : await sql`
        select count(*)::int as n from wa_group_events
        where number_id = ${numberId} and jid = ${jid} and action in ('reply', 'react')
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
}
