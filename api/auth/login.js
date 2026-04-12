import { sql } from '../_db.js';
import { signJWT, hashPassword, verifyPassword } from '../_auth.js';
import crypto from 'crypto';

// Auto-initialize admin user on first ever login if no users exist yet.
async function ensureAdminExists() {
  const [{ count }] = await sql`select count(*)::int as count from users`;
  if (count > 0) return;

  const adminUsername = process.env.ADMIN_USERNAME || 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) return; // can't create without a password

  const adminId = crypto.randomUUID();
  await sql`
    insert into users (id, username, password_hash, is_admin)
    values (${adminId}, ${adminUsername}, ${hashPassword(adminPassword)}, true)
  `;

  // Assign all existing agents (no owner yet) to the admin
  await sql`update agents set user_id = ${adminId} where user_id is null`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }

  await ensureAdminExists();

  const [user] = await sql`select * from users where username = ${username}`;
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'invalid credentials' });
  }

  await sql`update users set last_login_at = now() where id = ${user.id}`;

  const token = signJWT({
    userId: user.id,
    username: user.username,
    isAdmin: user.is_admin,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7, // 7 days
  });

  return res.json({ token, username: user.username, isAdmin: user.is_admin });
}
