import crypto from 'crypto';
import { sql } from '../_db.js';
import { appBaseUrl } from '../_gmail.js';
import { logError } from '../_errorLog.js';

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';

function verifyState(state) {
  try {
    const [payload, sig] = state.split('.');
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(payload).digest('base64url');
    if (sig !== expected) return null;
    return JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch { return null; }
}

export default async function handler(req, res) {
  // Anything that throws in here strands the user on a blank 500 halfway
  // through Google's flow, with nothing said and nothing logged. Send them
  // back to the app with a reason instead.
  try {
    return await connect(req, res);
  } catch (err) {
    await logError({ source: 'gmail', message: err.message, context: { step: 'oauth_callback' } });
    const back = appBaseUrl(req);
    return res.redirect(302, `${back}/?gmail_error=${encodeURIComponent(err.message.slice(0, 200))}`);
  }
}

async function connect(req, res) {
  const { code, state, error } = req.query;
  const appUrl = appBaseUrl(req);

  if (error) {
    return res.redirect(302, `${appUrl}/?gmail_error=${encodeURIComponent(error)}`);
  }

  const stateData = verifyState(state || '');
  if (!stateData) {
    return res.redirect(302, `${appUrl}/?gmail_error=invalid_state`);
  }

  const { agentId } = stateData;
  if (!agentId) {
    return res.redirect(302, `${appUrl}/?gmail_error=missing_agent`);
  }
  const redirectUri = `${appUrl}/api/gmail/callback`;

  // Exchange code for tokens
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  const tokens = await tokenRes.json();
  if (!tokenRes.ok) {
    return res.redirect(302, `${appUrl}/?gmail_error=${encodeURIComponent(tokens.error_description || 'token_exchange_failed')}`);
  }

  // Get Gmail address
  const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const profile = await profileRes.json();
  const gmailEmail = profile.email || '';

  const expiry = Math.floor(Date.now() / 1000) + (tokens.expires_in || 3600);

  await sql`
    insert into gmail_tokens (agent_id, email, access_token, refresh_token, expiry)
    values (${agentId}, ${gmailEmail}, ${tokens.access_token}, ${tokens.refresh_token || ''}, ${expiry})
    on conflict (agent_id) do update set
      email         = excluded.email,
      access_token  = excluded.access_token,
      refresh_token = case when excluded.refresh_token != '' then excluded.refresh_token
                          else gmail_tokens.refresh_token end,
      expiry        = excluded.expiry
  `;

  // Send the user back to the agent whose mailbox they just connected.
  res.redirect(302, `${appUrl}/?gmail_connected=1&agent=${encodeURIComponent(agentId)}`);
}
