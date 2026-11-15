import { checkAuthOrToken } from './_auth.js';
import { listApps, createApp, appUrl } from './_apps.js';

/** The account's apps, and making one. The CLI lists them here to find an id. */
export default async function handler(req, res) {
  const user = await checkAuthOrToken(req, res);
  if (!user) return;

  try {
    if (req.method === 'GET') {
      return res.json(await listApps(user.userId));
    }
    if (req.method === 'POST') {
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
