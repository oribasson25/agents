import crypto from 'crypto';
import { verifyJWT } from '../_auth.js';
import { userOwnsAgent } from '../_gmail.js';

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';

function signState(data) {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  // Token passed as query param since this is a browser redirect (can't set headers)
  const token = req.query.token || '';
  const user = verifyJWT(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  // Gmail is connected per agent, so the flow always names one.
  const agentId = req.query.agentId || '';
  if (!agentId) return res.status(400).json({ error: 'agentId is required' });
  if (!(await userOwnsAgent(agentId, user))) return res.status(404).json({ error: 'Agent not found' });

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.status(500).json({ error: 'GOOGLE_CLIENT_ID not configured' });

  const appUrl = process.env.APP_URL || `https://${req.headers.host}`;
  const redirectUri = `${appUrl}/api/gmail/callback`;

  const state = signState({ userId: user.userId, agentId });

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'https://www.googleapis.com/auth/gmail.send email');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);

  res.redirect(302, url.toString());
}
