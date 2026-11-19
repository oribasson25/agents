import { sql } from '../_db.js';
import { appBaseUrl, userOwnsAgent } from '../_gmail.js';
import { logError } from '../_errorLog.js';
import { readState, nonceMatches, clearNonce } from '../_connections.js';
import { finishConnection } from '../connections/callback.js';

export default async function handler(req, res) {
  // Anything that throws in here strands the user on a blank 500 halfway
  // through Google's flow, with nothing said and nothing logged. Send them
  // back to the app with a reason instead.
  try {
    /* An organization's Gmail connection for automations comes back through
       this same address — the one Google already has on file — and is told
       apart by its state, which only the connections flow can sign. */
    if (readState(req.query.state)) return await finishConnection(req, res);
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

  /* Signed here for this flow, under ten minutes old, started in this
     browser (the nonce cookie), and by someone who may still edit the
     chatbot — otherwise a consent link someone else started could put your
     mailbox behind their chatbot. */
  const stateData = readState(state, 'gmail-agent');
  if (stateData) res.setHeader('Set-Cookie', clearNonce(stateData));
  if (!stateData) {
    return res.redirect(302, `${appUrl}/?gmail_error=invalid_state`);
  }
  if (!nonceMatches(req, stateData)) {
    return res.redirect(302, `${appUrl}/?gmail_error=${encodeURIComponent('The sign-in did not start in this browser. Start it again from the chatbot.')}`);
  }

  const { agentId } = stateData;
  if (!agentId) {
    return res.redirect(302, `${appUrl}/?gmail_error=missing_agent`);
  }
  if (!(await userOwnsAgent(agentId, { userId: stateData.userId }, 'edit'))) {
    return res.redirect(302, `${appUrl}/?gmail_error=${encodeURIComponent('You can no longer change this chatbot.')}`);
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
    signal: AbortSignal.timeout(20000),
  });

  const tokens = await tokenRes.json();
  if (!tokenRes.ok) {
    return res.redirect(302, `${appUrl}/?gmail_error=${encodeURIComponent(tokens.error_description || 'token_exchange_failed')}`);
  }

  // Get Gmail address
  const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
    signal: AbortSignal.timeout(20000),
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
