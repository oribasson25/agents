import { sql } from '../../../_db.js';
import { checkAdmin } from '../../../_auth.js';

export default async function handler(req, res) {
  const admin = checkAdmin(req, res);
  if (!admin) return;

  const { id } = req.query;

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
