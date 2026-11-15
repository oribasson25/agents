import { checkAdmin } from '../_auth.js';
import { listOrgs, createOrg, errorReply } from '../_orgs.js';

/**
 * Organizations, for the platform admin.
 *
 *   GET   → every organization, with how many people and items it holds
 *   POST  → { name, adminUsername } — a new organization and its first admin.
 *           The admin's temporary password comes back once.
 */
export default async function handler(req, res) {
  const admin = checkAdmin(req, res);
  if (!admin) return;
  try {
    if (req.method === 'GET') return res.json({ orgs: await listOrgs() });
    if (req.method === 'POST') {
      const { name, adminUsername } = req.body || {};
      return res.status(201).json(await createOrg({ name, adminUsername, createdBy: admin.userId }));
    }
  } catch (err) {
    return errorReply(res, err);
  }
  return res.status(405).end();
}
