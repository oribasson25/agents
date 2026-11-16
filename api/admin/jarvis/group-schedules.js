import { sql } from '../../_db.js';
import { jarvisGate, numberInScope } from '../../_jarvisAccess.js';
import { getNumber } from '../../_waControl.js';
import { MAX_SCHEDULES, getGroup, getSchedule, groupSettingsOf, listSchedules, sanitizeSchedule, saveSchedule } from '../../_waGroups.js';
import { scheduleView } from './group.js';

/**
 * The messages a number sends to a group on a schedule: fixed text, a message
 * it writes fresh each time, a recap of the chat, or a poll. A one-time
 * reminder is a schedule that repeats 'once'. Admins only.
 *
 *   GET    ?numberId&jid       → { schedules }
 *   POST   ?numberId&jid       → { title, kind, body, pollOptions, repeat, onDate, atTime, weekdays, monthDay, enabled }
 *   PATCH  ?numberId&jid&id    → any of the same fields
 *   POST   ?numberId&jid&id    → { action: 'send' }: send it now, once, without moving its schedule
 *   DELETE ?numberId&jid&id
 *
 * Times are in the number's time zone. The worker holding the WhatsApp
 * connection does the sending, within half a minute of the time.
 */
export default async function handler(req, res) {
  const admin = await jarvisGate(req, res);
  if (!admin) return;

  const numberId = String(req.query.numberId || '');
  const jid = String(req.query.jid || '');
  const found = await getNumber(numberId);
  const number = (await numberInScope(admin, found)) ? found : null;
  const group = number && (await getGroup(numberId, jid));
  if (!group) return res.status(404).json({ error: 'No such group.' });
  const tz = groupSettingsOf(number).timezone;
  const list = async () => ({ schedules: (await listSchedules(numberId, jid)).map(scheduleView) });

  if (req.method === 'GET') return res.json(await list());

  const id = req.query.id ? Number(req.query.id) : null;
  const current = id ? await getSchedule(numberId, jid, id) : null;
  if (id && !current) return res.status(404).json({ error: 'No such scheduled message.' });

  if (req.method === 'POST' && id) {
    if (req.body?.action !== 'send') return res.status(400).json({ error: 'Unknown action.' });
    if (group.mode === 'off') return res.status(400).json({ error: 'The group is switched off: turn it on before sending.' });
    await sql`update wa_group_schedules set run_now = true where id = ${id}`;
    return res.json(await list());
  }

  if (req.method === 'POST') {
    const [{ n }] = await sql`select count(*)::int as n from wa_group_schedules where number_id = ${numberId} and jid = ${jid}`;
    if (n >= MAX_SCHEDULES) return res.status(400).json({ error: `A group can have up to ${MAX_SCHEDULES} scheduled messages.` });
    const { schedule, error } = sanitizeSchedule(req.body || {}, tz);
    if (error) return res.status(400).json({ error });
    await saveSchedule(numberId, jid, schedule);
    return res.status(201).json(await list());
  }

  if (req.method === 'PATCH') {
    const { schedule, error } = sanitizeSchedule(req.body || {}, tz, current);
    if (error) return res.status(400).json({ error });
    await saveSchedule(numberId, jid, schedule, id);
    return res.json(await list());
  }

  if (req.method === 'DELETE') {
    if (!id) return res.status(400).json({ error: 'Which one?' });
    await sql`delete from wa_group_schedules where id = ${id} and number_id = ${numberId} and jid = ${jid}`;
    return res.json(await list());
  }

  return res.status(405).end();
}
