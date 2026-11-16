import { checkAuthOrToken } from './_auth.js';
import { listAutomations, createAutomation } from './_automations.js';
import { member, canCreate } from './_access.js';

/** The organization's automations, and making one. */
export default async function handler(req, res) {
  const user = await checkAuthOrToken(req, res);
  if (!user) return;

  try {
    if (req.method === 'GET') return res.json(await listAutomations(user));
    if (req.method === 'POST') {
      if (!canCreate(await member(user))) {
        return res.status(403).json({ error: 'Only the organization\'s admin, or a member who can edit everything, can add an automation.', code: 'READ_ONLY' });
      }
      const { name, trigger, data } = req.body || {};
      return res.status(201).json(await createAutomation({ user, name, trigger, data }));
    }
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.code });
  }
  return res.status(405).end();
}
