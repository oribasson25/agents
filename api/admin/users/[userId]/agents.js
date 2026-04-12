import { sql } from '../../../_db.js';
import { checkAdmin } from '../../../_auth.js';

export default async function handler(req, res) {
  const admin = checkAdmin(req, res);
  if (!admin) return;

  const { userId } = req.query;

  if (req.method === 'GET') {
    const rows = await sql`
      select data from agents
      where user_id = ${userId}
      order by created_at desc
    `;
    return res.json(rows.map(r => r.data));
  }

  res.status(405).end();
}
