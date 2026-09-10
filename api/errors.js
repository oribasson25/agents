import { checkAuth } from './_auth.js';
import { recentErrors } from './_errorLog.js';

/** Recent failures across the caller's agents, newest first. */
export default async function handler(req, res) {
  const user = checkAuth(req, res);
  if (!user) return;
  if (req.method !== 'GET') return res.status(405).end();

  const errors = await recentErrors(user.userId, {
    agentId: (req.query.agentId || '').trim() || null,
    source: (req.query.source || '').trim() || null,
    limit: req.query.limit,
  });
  return res.json({ errors });
}
