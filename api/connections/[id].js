import { checkAuth } from '../_auth.js';
import { member, isOrgAdmin } from '../_access.js';
import { renameConnection, deleteConnection } from '../_connections.js';

/** Rename or remove one connection. The organization's admin only. */
export default async function handler(req, res) {
  const user = checkAuth(req, res);
  if (!user) return;
  const me = await member(user);
  if (!me || !me.orgId) return res.status(401).json({ error: 'unauthorized' });
  if (!me.isPlatformAdmin && !isOrgAdmin(me)) return res.status(403).json({ error: 'Only the organization\'s admin changes connections.' });
  const { id } = req.query;
  try {
    if (req.method === 'PUT') return res.json(await renameConnection({ orgId: me.orgId, id, name: (req.body || {}).name }));
    if (req.method === 'DELETE') return res.json(await deleteConnection({ orgId: me.orgId, id }));
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.code });
  }
  return res.status(405).end();
}
