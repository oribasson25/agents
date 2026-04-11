import { sql } from '../_db.js';
import { checkAuth } from '../_auth.js';

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;

  const { id } = req.query;

  if (req.method === 'GET') {
    const [row] = await sql`select data from agents where id = ${id}`;
    return row ? res.json(row.data) : res.status(404).end();
  }

  if (req.method === 'PUT') {
    const agent = req.body;
    await sql`update agents set data = ${JSON.stringify(agent)}::jsonb, updated_at = now() where id = ${id}`;
    return res.json(agent);
  }

  if (req.method === 'DELETE') {
    await sql`delete from agents where id = ${id}`;
    return res.status(204).end();
  }

  res.status(405).end();
}
