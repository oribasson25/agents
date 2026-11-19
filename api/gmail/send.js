import { requireSession } from '../_auth.js';
import { sendGmail, userOwnsAgent, agentEmailEnabled } from '../_gmail.js';

/**
 * Sends one email from an AI Chatbot's connected Gmail, from the editor.
 *
 * Sending as the business is a change to the world, so it takes edit access
 * on the chatbot — and only while the chatbot's own send_email is switched
 * on, the same rule its tool follows when a conversation asks for it.
 */
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).end();

  const user = await requireSession(req, res);
  if (!user) return;

  const { agentId, to, subject, body } = req.body || {};
  if (!agentId) return res.status(400).json({ error: 'agentId is required' });
  if (!to || !subject) return res.status(400).json({ error: 'to and subject are required' });
  if (!(await userOwnsAgent(agentId, user, 'view'))) return res.status(404).json({ error: 'Agent not found' });
  if (!(await userOwnsAgent(agentId, user, 'edit'))) {
    return res.status(403).json({ error: 'You can view this AI Chatbot but not send email from it.', code: 'READ_ONLY' });
  }
  if (!(await agentEmailEnabled(agentId))) {
    return res.status(403).json({ error: 'Sending email is switched off for this AI Chatbot.', code: 'EMAIL_DISABLED' });
  }

  try {
    const result = await sendGmail({ agentId, to, subject, body });
    return res.json(result);
  } catch (err) {
    const status = err.code === 'BAD_ADDRESS' ? 400
      : err.code === 'NOT_CONNECTED' || err.code === 'TOKEN_EXPIRED' ? 403 : 500;
    return res.status(status).json({ error: err.message, code: err.code });
  }
}
