import { manageableOrg, updateMember, resetPassword, removeMember, accessMap, setGrant, errorReply } from '../../_orgs.js';

/**
 * One member of an organization.
 *
 *   GET     → { member, items } — every AI Chatbot, Table and App in the
 *             organization, with what this member reaches on each
 *   PUT     → { orgRole?, orgAccess? }                   role and org-wide reach
 *   PATCH   → { kind, itemId, level: 'none'|'view'|'edit'|null }  one item; null
 *             goes back to the org-wide level
 *   POST    → { action: 'reset-password' }              a new temporary password
 *   DELETE  → removes them; their work passes to the admin doing it
 */
export default async function handler(req, res) {
  const scope = await manageableOrg(req, res);
  if (!scope) return;
  const { userId } = req.query;
  const { orgId, me } = scope;
  try {
    if (req.method === 'GET') return res.json(await accessMap(orgId, userId));
    if (req.method === 'PUT') {
      const { orgRole, orgAccess } = req.body || {};
      /* Anything but 'admin' is a demotion (updateMember reads any other value
         as member), so the guard looks at what it is not, not at one spelling. */
      if (userId === me.userId && orgRole !== undefined && orgRole !== 'admin') {
        return res.status(409).json({ error: 'You cannot take away your own admin role.', code: 'SELF' });
      }
      return res.json(await updateMember({ orgId, userId, orgRole, orgAccess, actor: me }));
    }
    if (req.method === 'PATCH') {
      const { kind, itemId, level } = req.body || {};
      return res.json(await setGrant({ orgId, userId, kind, itemId, level: level ?? null, grantedBy: me.userId }));
    }
    if (req.method === 'POST' && (req.body || {}).action === 'reset-password') {
      return res.json(await resetPassword({ orgId, userId, actor: me }));
    }
    if (req.method === 'DELETE') {
      if (userId === me.userId) return res.status(409).json({ error: 'You cannot remove yourself.', code: 'SELF' });
      return res.json(await removeMember({ orgId, userId, heirId: me.orgId === orgId ? me.userId : null }));
    }
  } catch (err) {
    return errorReply(res, err);
  }
  return res.status(405).end();
}
