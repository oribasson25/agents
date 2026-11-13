import { sql } from '../../_db.js';
import { checkAdmin } from '../../_auth.js';
import { newId } from '../../_waControl.js';

/**
 * WhatsApp numbers linked as a device, for the Jarvis screen. Admins only:
 * nobody else sees or configures a number.
 *
 *   GET  → every number, with its routing and how many people are on its list
 *   POST → { label, ownerUserId } a new, not-yet-linked number
 */
export default async function handler(req, res) {
  const admin = checkAdmin(req, res);
  if (!admin) return;

  if (req.method === 'GET') {
    const rows = await sql`
      select n.id, n.label, n.owner_user_id, u.username as owner_username,
             n.mode, n.agent_id, a.data->>'name' as agent_name,
             n.enabled, n.phone, n.created_at,
             n.state->>'status' as status, n.state->>'error' as error,
             (n.state->>'updatedAt')::bigint as state_at,
             (n.lease_until is not null and n.lease_until > now()) as running,
             count(p.id)::int as people,
             coalesce(json_agg(json_build_object('name', p.name) order by p.created_at)
                      filter (where p.id is not null), '[]') as people_names
      from wa_numbers n
      join users u on u.id = n.owner_user_id
      left join agents a on a.id = n.agent_id
      left join jarvis_people p on p.number_id = n.id and p.active
      group by n.id, u.username, a.data
      order by n.created_at
    `;
    return res.json(rows);
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const label = String(body.label || '').trim().slice(0, 80) || 'WhatsApp number';
    const ownerUserId = String(body.ownerUserId || admin.userId);
    const [owner] = await sql`select id from users where id = ${ownerUserId}`;
    if (!owner) return res.status(400).json({ error: 'That account does not exist.' });
    const id = newId('wan');
    const [row] = await sql`
      insert into wa_numbers (id, label, owner_user_id) values (${id}, ${label}, ${ownerUserId})
      returning id, label, owner_user_id, mode, agent_id, enabled, phone, created_at
    `;
    return res.status(201).json(row);
  }

  res.status(405).end();
}
