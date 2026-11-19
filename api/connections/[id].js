import { requireSession } from '../_auth.js';
import { member, isOrgAdmin } from '../_access.js';
import { renameConnection, deleteConnection, setConnectionShared } from '../_connections.js';

/**
 * Change or remove one connection. The organization's admin only.
 *
 *   PUT     { name }      renames it
 *   PUT     { shared }    true: everyone who builds automations may use it;
 *                         false: only whoever added it and the admins
 *   DELETE                removes it
 */
export default async function handler(req, res) {
  const user = await requireSession(req, res);
  if (!user) return;
  const me = await member(user);
  if (!me || !me.orgId) return res.status(401).json({ error: 'unauthorized' });
  if (!me.isPlatformAdmin && !isOrgAdmin(me)) return res.status(403).json({ error: 'Only the organization\'s admin changes connections.' });
  const { id } = req.query;
  try {
    if (req.method === 'PUT') {
      const body = req.body || {};
      let out = { id };
      if (typeof body.shared === 'boolean') out = { ...out, ...(await setConnectionShared({ orgId: me.orgId, id, shared: body.shared })) };
      if (body.name !== undefined || typeof body.shared !== 'boolean') out = { ...out, ...(await renameConnection({ orgId: me.orgId, id, name: body.name })) };
      return res.json(out);
    }
    if (req.method === 'DELETE') return res.json(await deleteConnection({ orgId: me.orgId, id }));
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.code });
  }
  return res.status(405).end();
}
