import { sql } from '../_db.js';
import { signJWT, hashPassword } from '../_auth.js';
import { seedDefaultAgent } from '../_defaultAgent.js';
import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { username, password, phone } = req.body || {};
  if (!username || !password || !phone) {
    return res.status(400).json({ error: 'username, password and phone required' });
  }

  // Check if username already taken
  const [existing] = await sql`select id from users where username = ${username}`;
  if (existing) {
    return res.status(409).json({ error: 'Username already taken' });
  }

  const id = crypto.randomUUID();
  await sql`
    insert into users (id, username, password_hash, phone, is_admin)
    values (${id}, ${username}, ${hashPassword(password)}, ${phone}, false)
  `;

  // A new account starts with a copy of the starter agent. This never throws,
  // so a missing or broken template cannot fail the sign-up.
  await seedDefaultAgent(id);

  const token = signJWT({
    userId: id,
    username,
    isAdmin: false,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
  });

  return res.status(201).json({ token, username, isAdmin: false });
}
