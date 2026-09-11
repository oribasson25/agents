import { sql } from './_db.js';

/**
 * Gmail is connected per agent: an agent's send_email tool sends from the
 * mailbox that agent is connected to. Tokens live in gmail_tokens keyed by
 * agent_id (see migrations/008-gmail-per-agent.sql).
 */

export async function userOwnsAgent(agentId, user) {
  if (!agentId) return false;
  const [row] = await sql`
    select 1 from agents
    where id = ${agentId} and (user_id = ${user.userId} or ${!!user.isAdmin})
  `;
  return !!row;
}

export async function getGmailStatus(agentId) {
  const [row] = await sql`select email from gmail_tokens where agent_id = ${agentId}`;
  return { connected: !!row, email: row?.email || null };
}

export async function disconnectGmail(agentId) {
  await sql`delete from gmail_tokens where agent_id = ${agentId}`;
}

function fail(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function refreshAccessToken(agentId, refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw fail(data.error_description || 'Failed to refresh Gmail token', 'REFRESH_FAILED');

  const expiry = Math.floor(Date.now() / 1000) + (data.expires_in || 3600);
  await sql`
    update gmail_tokens
    set access_token = ${data.access_token}, expiry = ${expiry}
    where agent_id = ${agentId}
  `;
  return data.access_token;
}

/**
 * Sends one plain-text email from the agent's connected mailbox.
 * Throws with `err.code` set to NOT_CONNECTED | TOKEN_EXPIRED |
 * REFRESH_FAILED | SEND_FAILED.
 */
export async function sendGmail({ agentId, to, subject, body }) {
  const [row] = await sql`select * from gmail_tokens where agent_id = ${agentId}`;
  if (!row) throw fail('Gmail is not connected for this agent. Connect it in the agent\'s Tools tab.', 'NOT_CONNECTED');

  let accessToken = row.access_token;
  if (row.expiry < Math.floor(Date.now() / 1000) + 60) {
    if (!row.refresh_token) {
      throw fail('Gmail token expired. Reconnect Gmail in the agent\'s Tools tab.', 'TOKEN_EXPIRED');
    }
    accessToken = await refreshAccessToken(agentId, row.refresh_token);
  }

  // Encode the header values that carry user text, so non-ASCII subjects
  // (Hebrew included) don't arrive mangled.
  const encodeHeader = (value) =>
    /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;

  const message = [
    `From: ${row.email}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(String(subject))}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body || '',
  ].join('\r\n');

  const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: Buffer.from(message, 'utf8').toString('base64url') }),
  });

  if (!sendRes.ok) {
    const err = await sendRes.json().catch(() => ({}));
    throw fail(err.error?.message || 'Failed to send email', 'SEND_FAILED');
  }

  return { ok: true, from: row.email, message: `Email sent to ${to}` };
}

/**
 * The base URL for the OAuth redirect.
 *
 * Whatever is in APP_URL came out of a deployment UI, so it can carry a
 * trailing newline, stray spaces or no scheme at all. A newline is the nasty
 * one: it survives into the redirect_uri Google is handed — which Google
 * rejects as `invalid_request`, "does not comply with the OAuth 2.0 policy" —
 * and it makes the callback's own Location header throw ERR_INVALID_CHAR, so
 * the function 500s instead of reporting the problem. Normalise it once, here.
 */
export function appBaseUrl(req) {
  const raw = (process.env.APP_URL || '').replace(/[\s\u0000-\u001f\u007f]+/g, '');
  const host = String((req && req.headers && req.headers.host) || '').replace(/[\s\u0000-\u001f\u007f]+/g, '');
  const base = raw || (host ? `https://${host}` : '');
  if (!base) return '';
  const withScheme = /^https?:\/\//i.test(base) ? base : `https://${base}`;
  return withScheme.replace(/\/+$/, '');
}
