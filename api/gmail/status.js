import { checkAuth } from '../_auth.js';
import { getGmailStatus, userOwnsAgent } from '../_gmail.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const user = checkAuth(req, res);
  if (!user) return;

  const agentId = req.query.agentId || '';
  if (!agentId) return res.status(400).json({ error: 'agentId is required' });
  if (!(await userOwnsAgent(agentId, user))) return res.status(404).json({ error: 'Agent not found' });

  return res.json(await getGmailStatus(agentId));
}
