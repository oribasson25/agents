import { checkAuthOrToken } from './_auth.js';
import { listApps, createApp, appUrl } from './_apps.js';
import { member, canCreate } from './_access.js';

/** The account's apps, and making one. The CLI lists them here to find an id. */
export default async function handler(req, res) {
  const user = await checkAuthOrToken(req, res);
  if (!user) return;

  try {
    if (req.method === 'GET') {
      return res.json(await listApps(user));
    }
    if (req.method === 'POST') {
      if (!canCreate(await member(user))) {
        return res.status(403).json({ error: 'Only the organization\'s admin, or a member who can edit everything, can add an app.', code: 'READ_ONLY' });
      }
      const { name, description } = req.body || {};
      const app = await createApp({ user, name, description });
      return res.status(201).json({ ...app, url: appUrl(app, user) });
    }
  } catch (err) {
    if (err.code === 'BAD_NAME') return res.status(400).json({ error: err.message });
    return res.status(500).json({ error: err.message });
  }
  return res.status(405).end();
}
