import { sql } from './_db.js';
import { checkAuth, hashPassword, verifyPassword } from './_auth.js';
import { sessionInfo } from './_session.js';

/**
 * The person signed in.
 *
 *   GET   → { username, isAdmin, orgId, orgName, orgRole, orgAccess, mustChangePassword, canCreate }
 *   POST  → { currentPassword, newPassword } — changes their own password. A
 *           temporary one, set by an admin, has to be replaced before anything
 *           else; this is how.
 */
export default async function handler(req, res) {
  const user = checkAuth(req, res);
  if (!user) return;

  if (req.method === 'GET') {
    const [row] = await sql`select username, is_admin from users where id = ${user.userId}`;
    if (!row) return res.status(401).json({ error: 'unauthorized' });
    return res.json({ username: row.username, isAdmin: !!row.is_admin, ...(await sessionInfo(user.userId)) });
  }

  if (req.method === 'POST') {
    const { currentPassword, newPassword } = req.body || {};
    const next = String(newPassword || '');
    if (next.length < 8) return res.status(400).json({ error: 'The new password needs at least 8 characters.' });
    const [row] = await sql`select password_hash from users where id = ${user.userId}`;
    if (!row || !verifyPassword(String(currentPassword || ''), row.password_hash)) {
      return res.status(403).json({ error: 'The current password is not right.' });
    }
    if (verifyPassword(next, row.password_hash)) {
      return res.status(400).json({ error: 'Choose a password different from the current one.' });
    }
    await sql`
      update users set password_hash = ${hashPassword(next)}, must_change_password = false
      where id = ${user.userId}
    `;
    return res.json({ ok: true, ...(await sessionInfo(user.userId)) });
  }

  return res.status(405).end();
}
