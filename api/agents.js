import { sql } from './_db.js';
import { checkAuth } from './_auth.js';

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;

  if (req.method === 'GET') {
    const rows = await sql`select data from agents order by created_at desc`;
    return res.json(rows.map(r => r.data));
  }

  if (req.method === 'POST') {
    const agent = req.body;
    await sql`insert into agents (id, data) values (${agent.id}, ${JSON.stringify(agent)}::jsonb)`;
    return res.status(201).json(agent);
  }

  res.status(405).end();
}
