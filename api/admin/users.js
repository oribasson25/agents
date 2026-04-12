import { sql } from '../_db.js';
import { checkAdmin } from '../_auth.js';

export default async function handler(req, res) {
  const admin = checkAdmin(req, res);
  if (!admin) return;

  if (req.method === 'GET') {
    const rows = await sql`
      select
        u.id,
        u.username,
        u.phone,
        u.is_admin,
        u.created_at,
        u.last_login_at,
        count(a.id)::int as agent_count
      from users u
      left join agents a on a.user_id = u.id
      group by u.id
      order by u.created_at desc
    `;
    return res.json(rows);
  }

  res.status(405).end();
}
