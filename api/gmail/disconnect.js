import { sql } from '../_db.js';
import { checkAuth } from '../_auth.js';

export default async function handler(req, res) {
  if (req.method !== 'DELETE') return res.status(405).end();
  const user = checkAuth(req, res);
  if (!user) return;

  await sql`delete from gmail_tokens where user_id = ${user.userId}`;
  res.json({ ok: true });
}
