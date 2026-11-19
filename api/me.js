import { sql } from './_db.js';
import { requireSession, hashPassword, verifyPassword, sessionToken } from './_auth.js';
import { sessionInfo } from './_session.js';

/**
 * The person signed in.
 *
 *   GET   → { username, isAdmin, orgId, orgName, orgRole, orgAccess, mustChangePassword, canCreate }
 *   POST  → { currentPassword, newPassword } — changes their own password. A
 *           temporary one, set by an admin, has to be replaced before anything
 *           else; this is how. Every other endpoint refuses a session that still
 *           holds a temporary password (MUST_CHANGE_PASSWORD), so these two are
 *           the only ones that let it through.
 *
 * A change ends every session signed before it (token_version), including the
 * one that asked — so the answer carries a fresh `token` for it, which the
 * interface merges into the stored session.
 */
export default async function handler(req, res) {
  const user = await requireSession(req, res, { allowPasswordChange: true });
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
      update users set password_hash = ${hashPassword(next)}, must_change_password = false,
                       token_version = token_version + 1
      where id = ${user.userId}
    `;
    const [fresh] = await sql`select id, username, is_admin, token_version from users where id = ${user.userId}`;
    const token = fresh ? sessionToken(fresh) : undefined;
    return res.json({ ok: true, ...(token ? { token } : {}), ...(await sessionInfo(user.userId)) });
  }

  return res.status(405).end();
}
