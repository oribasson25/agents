import { sql } from '../../../_db.js';
import { checkAdmin } from '../../../_auth.js';
import { normalizePhone } from '../../../_waControl.js';
import { CAPABILITY_DEFAULTS, PROACTIVE_DEFAULTS } from '../../../_jarvis.js';

/**
 * One person's Jarvis settings. Admins only.
 *
 *   GET    → settings, plus counts of what is private to them
 *   PATCH  → any of { name, phone, active, prompt, callName, timezone,
 *                     capabilities, proactive, adminCanViewMemory }
 *   DELETE → takes them off the list and erases their Jarvis's data
 *
 * Their conversation is never returned: the admin sees how much there is, not
 * what it says. Their memory is returned only while adminCanViewMemory is on.
 */
const TIMEZONES = new Set(Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : ['Asia/Jerusalem']);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export default async function handler(req, res) {
  const admin = checkAdmin(req, res);
  if (!admin) return;

  const id = String(req.query.id || '');
  const [person] = await sql`select * from jarvis_people where id = ${id}`;
  if (!person) return res.status(404).json({ error: 'No such person.' });

  if (req.method === 'GET') return res.json(await detail(person));

  if (req.method === 'PATCH') {
    const b = req.body || {};
    const next = {
      name: b.name !== undefined ? String(b.name).trim().slice(0, 80) || person.name : person.name,
      active: b.active !== undefined ? !!b.active : person.active,
      prompt: b.prompt !== undefined ? String(b.prompt).slice(0, 8000) : person.prompt,
      call_name: b.callName !== undefined ? String(b.callName).trim().slice(0, 80) : person.call_name,
      timezone: b.timezone !== undefined && TIMEZONES.has(String(b.timezone)) ? String(b.timezone) : person.timezone,
      capabilities: { ...(person.capabilities || {}) },
      proactive: { ...(person.proactive || {}) },
      admin_can_view_memory: b.adminCanViewMemory !== undefined ? !!b.adminCanViewMemory : person.admin_can_view_memory,
      phone: person.phone,
    };
    if (b.phone !== undefined) {
      const phone = normalizePhone(b.phone);
      if (phone.length < 8 || phone.length > 15) return res.status(400).json({ error: 'That does not look like a phone number.' });
      const [taken] = await sql`select id from jarvis_people where number_id = ${person.number_id} and phone = ${phone} and id <> ${id}`;
      if (taken) return res.status(409).json({ error: 'This phone number is already on the list.' });
      next.phone = phone;
    }
    for (const [k, v] of Object.entries(b.capabilities || {})) {
      if (k in CAPABILITY_DEFAULTS) next.capabilities[k] = !!v;
    }
    for (const [k, v] of Object.entries(b.proactive || {})) {
      if (k in PROACTIVE_DEFAULTS) next.proactive[k] = !!v;
      else if ((k === 'briefTime' || k === 'quietFrom' || k === 'quietTo') && HHMM.test(String(v))) next.proactive[k] = String(v);
      else if (k === 'briefDays' && Array.isArray(v)) next.proactive[k] = v.filter((d) => DAYS.includes(d));
      else if (k === 'taskApp' && ['trello', 'monday', 'jira'].includes(v)) next.proactive[k] = v;
    }
    await sql`
      update jarvis_people set
        name = ${next.name}, phone = ${next.phone}, active = ${next.active}, prompt = ${next.prompt},
        call_name = ${next.call_name}, timezone = ${next.timezone},
        capabilities = ${JSON.stringify(next.capabilities)}, proactive = ${JSON.stringify(next.proactive)},
        admin_can_view_memory = ${next.admin_can_view_memory}, updated_at = now()
      where id = ${id}
    `;
    const [fresh] = await sql`select * from jarvis_people where id = ${id}`;
    return res.json(await detail(fresh));
  }

  if (req.method === 'DELETE') {
    await sql`delete from jarvis_people where id = ${id}`;
    return res.status(204).end();
  }

  res.status(405).end();
}

async function detail(p) {
  const [[counts], memory] = await Promise.all([
    sql`
      select
        (select count(*)::int from jarvis_memory where person_id = ${p.id}) as memory,
        (select count(*)::int from jarvis_reminders where person_id = ${p.id} and sent_at is null) as reminders,
        (select count(*)::int from jarvis_messages where person_id = ${p.id}) as messages,
        (select min(created_at) from jarvis_messages where person_id = ${p.id}) as since
    `,
    p.admin_can_view_memory
      ? sql`select id, fact, created_at from jarvis_memory where person_id = ${p.id} order by id`
      : Promise.resolve(null),
  ]);
  return {
    id: p.id,
    numberId: p.number_id,
    name: p.name,
    phone: p.phone,
    active: p.active,
    prompt: p.prompt,
    callName: p.call_name,
    timezone: p.timezone,
    capabilities: { ...CAPABILITY_DEFAULTS, ...(p.capabilities || {}) },
    proactive: { ...PROACTIVE_DEFAULTS, briefTime: '07:30', briefDays: ['sun', 'mon', 'tue', 'wed', 'thu'], quietFrom: '22:00', quietTo: '07:00', taskApp: 'trello', ...(p.proactive || {}) },
    adminCanViewMemory: p.admin_can_view_memory,
    lastMessageAt: p.last_message_at,
    // Not connected to Google yet: per-person Google sign-in is the next phase.
    connections: { google: 'not_connected', tasks: 'not_connected' },
    private: counts,
    memory,
  };
}
