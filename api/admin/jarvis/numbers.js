import { sql } from '../../_db.js';
import { jarvisGate, numberInScope, ownerInScope } from '../../_jarvisAccess.js';
import { newId } from '../../_waControl.js';

/**
 * WhatsApp numbers linked as a device, for the Jarvis screen. The platform
 * admin sees every number; an organization's admin sees its own organization's
 * (see _jarvisAccess.js). Members of an organization see none.
 *
 *   GET  → every number, with its routing and how many people are on its list
 *   POST → { label, ownerUserId } a new, not-yet-linked number
 */
export default async function handler(req, res) {
  const admin = await jarvisGate(req, res);
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
      where (${admin.isPlatformAdmin}::boolean or u.org_id = ${admin.orgId})
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
    if (!owner || !(await ownerInScope(admin, ownerUserId))) return res.status(400).json({ error: 'That account does not exist.' });
    const id = newId('wan');
    const [row] = await sql`
      insert into wa_numbers (id, label, owner_user_id) values (${id}, ${label}, ${ownerUserId})
      returning id, label, owner_user_id, mode, agent_id, enabled, phone, created_at
    `;
    return res.status(201).json(row);
  }

  res.status(405).end();
}
