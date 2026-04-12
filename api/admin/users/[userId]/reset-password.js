import { sql } from '../../../_db.js';
import { checkAdmin, hashPassword } from '../../../_auth.js';
import crypto from 'crypto';

export default async function handler(req, res) {
  const admin = checkAdmin(req, res);
  if (!admin) return;

  if (req.method !== 'POST') return res.status(405).end();

  const { userId } = req.query;

  const [user] = await sql`select id from users where id = ${userId}`;
  if (!user) return res.status(404).json({ error: 'user not found' });

  // Generate a random 10-char temporary password
  const tempPassword = crypto.randomBytes(5).toString('hex'); // e.g. "a3f9c21b4d"
  await sql`update users set password_hash = ${hashPassword(tempPassword)} where id = ${userId}`;

  return res.json({ tempPassword });
}
