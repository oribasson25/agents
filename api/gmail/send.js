import { checkAuth } from '../_auth.js';
import { sendGmail, userOwnsAgent } from '../_gmail.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).end();

  const user = checkAuth(req, res);
  if (!user) return;

  const { agentId, to, subject, body } = req.body || {};
  if (!agentId) return res.status(400).json({ error: 'agentId is required' });
  if (!to || !subject) return res.status(400).json({ error: 'to and subject are required' });
  if (!(await userOwnsAgent(agentId, user))) return res.status(404).json({ error: 'Agent not found' });

  try {
    const result = await sendGmail({ agentId, to, subject, body });
    return res.json(result);
  } catch (err) {
    const status = err.code === 'NOT_CONNECTED' || err.code === 'TOKEN_EXPIRED' ? 403 : 500;
    return res.status(status).json({ error: err.message });
  }
}
