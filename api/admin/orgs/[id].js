import { checkAdmin } from '../../_auth.js';
import { member } from '../../_access.js';
import { getOrg, deleteOrg, errorReply } from '../../_orgs.js';

/**
 * Deleting an organization, for the platform admin. The name has to be echoed
 * back in ?confirm=, so a misplaced click cannot take a whole organization.
 * People in it are managed through /api/org/members?org=<id>.
 */
export default async function handler(req, res) {
  const admin = checkAdmin(req, res);
  if (!admin) return;
  if (req.method !== 'DELETE') return res.status(405).end();
  try {
    const { id } = req.query;
    const org = await getOrg(id);
    if (!org) return res.status(404).json({ error: 'No such organization.' });
    const me = await member(admin);
    if (me && me.orgId === id) return res.status(409).json({ error: 'You cannot delete your own organization.' });
    if ((req.query.confirm || '') !== org.name) {
      return res.status(400).json({ error: 'Confirmation does not match the organization\'s name.' });
    }
    await deleteOrg(id);
    return res.json({ ok: true, id, name: org.name });
  } catch (err) {
    return errorReply(res, err);
  }
}
