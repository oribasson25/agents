import { checkAdmin } from '../../_auth.js';
import { revokeInvite } from '../../_invites.js';

/** Close an open code. A code already used is history and stays as it is. */
export default async function handler(req, res) {
  const admin = checkAdmin(req, res);
  if (!admin) return;
  if (req.method !== 'DELETE') return res.status(405).end();

  const ok = await revokeInvite(req.query.id);
  if (!ok) return res.status(409).json({ error: 'That code is already used, cancelled or gone.' });
  return res.json({ revoked: true });
}
