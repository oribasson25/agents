import { sql } from '../../../_db.js';
import { requireAdmin } from '../../../_auth.js';
import { setTemporaryPassword } from '../../../_orgs.js';

/**
 * The platform admin gives any account a new temporary password. The same
 * implementation an organization's admin uses (api/_orgs.js): twelve evenly
 * drawn characters, replaced at the next sign-in, and every session and
 * access token the old password opened ends with it.
 */
export default async function handler(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  if (req.method !== 'POST') return res.status(405).end();

  const { userId } = req.query;

  const [user] = await sql`select id from users where id = ${userId}`;
  if (!user) return res.status(404).json({ error: 'user not found' });

  const tempPassword = await setTemporaryPassword(userId);
  return res.json({ tempPassword, temporaryPassword: tempPassword });
}
