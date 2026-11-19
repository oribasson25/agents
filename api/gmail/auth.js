import { requireSession } from '../_auth.js';
import { userOwnsAgent, appBaseUrl } from '../_gmail.js';
import { signState, startNonce } from '../_connections.js';

/**
 * Starts connecting one AI Chatbot's Gmail.
 *
 *   GET /api/gmail/auth?agentId=…
 *   Authorization: Bearer <session>
 *   → 200 { url }   Google's consent page; the browser goes there next
 *
 * The session travels in the header, never in the address. The state is
 * signed, expires in ten minutes, and is bound to this browser by a nonce
 * cookie the callback checks (see api/_connections.js).
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const user = await requireSession(req, res);
  if (!user) return;

  // Gmail is connected per agent, so the flow always names one.
  const agentId = String(req.query.agentId || '');
  if (!agentId) return res.status(400).json({ error: 'agentId is required' });
  if (!(await userOwnsAgent(agentId, user, 'edit'))) return res.status(404).json({ error: 'Agent not found' });

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.status(500).json({ error: 'GOOGLE_CLIENT_ID not configured' });

  const appUrl = appBaseUrl(req);
  const redirectUri = `${appUrl}/api/gmail/callback`;

  const nonce = startNonce();
  const state = signState({ userId: user.userId, agentId, ...nonce.state }, 'gmail-agent');

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'https://www.googleapis.com/auth/gmail.send email');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);

  res.setHeader('Set-Cookie', nonce.cookie);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ url: url.toString() });
}
