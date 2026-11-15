import { manageableOrg, listMembers, createMember, getOrg, errorReply } from '../_orgs.js';

/**
 * The people in an organization, for its admin (or the platform admin, with
 * ?org=<id>).
 *
 *   GET   → { org, members }
 *   POST  → { username, orgRole, orgAccess } — a new member, and once, their
 *           temporary password
 */
export default async function handler(req, res) {
  const scope = await manageableOrg(req, res);
  if (!scope) return;
  try {
    if (req.method === 'GET') {
      return res.json({ org: await getOrg(scope.orgId), members: await listMembers(scope.orgId) });
    }
    if (req.method === 'POST') {
      const { username, orgRole, orgAccess } = req.body || {};
      const made = await createMember({ orgId: scope.orgId, username, orgRole, orgAccess, createdBy: scope.me.username });
      return res.status(201).json(made);
    }
  } catch (err) {
    return errorReply(res, err);
  }
  return res.status(405).end();
}
