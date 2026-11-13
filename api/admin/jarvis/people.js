import { sql } from '../../_db.js';
import { checkAdmin } from '../../_auth.js';
import { getNumber, newId, normalizePhone } from '../../_waControl.js';

/**
 * Puts a person on a number's Jarvis list. Admins only.
 *
 *   POST → { numberId, name, phone, prompt?, callName? }
 */
export default async function handler(req, res) {
  const admin = checkAdmin(req, res);
  if (!admin) return;
  if (req.method !== 'POST') return res.status(405).end();

  const body = req.body || {};
  const number = await getNumber(String(body.numberId || ''));
  if (!number) return res.status(404).json({ error: 'No such number.' });

  const phone = normalizePhone(body.phone);
  if (phone.length < 8 || phone.length > 15) return res.status(400).json({ error: 'That does not look like a phone number.' });
  if (number.phone && phone === number.phone) return res.status(400).json({ error: 'That is the number itself.' });

  const name = String(body.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'A name is required.' });

  const [taken] = await sql`select id from jarvis_people where number_id = ${number.id} and phone = ${phone}`;
  if (taken) return res.status(409).json({ error: 'This phone number is already on the list.' });

  const id = newId('jp');
  const [row] = await sql`
    insert into jarvis_people (id, number_id, name, phone, prompt, call_name)
    values (${id}, ${number.id}, ${name}, ${phone},
            ${String(body.prompt || '').slice(0, 8000)},
            ${String(body.callName || name.split(' ')[0]).slice(0, 80)})
    returning id, number_id, name, phone, active, created_at
  `;
  return res.status(201).json(row);
}
