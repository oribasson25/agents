import { sql } from '../_db.js';
import { checkAuth } from '../_auth.js';

async function refreshToken(userId, refreshToken) {
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
  if (!res.ok) throw new Error(data.error_description || 'Failed to refresh token');
  const expiry = Math.floor(Date.now() / 1000) + (data.expires_in || 3600);
  await sql`update gmail_tokens set access_token = ${data.access_token}, expiry = ${expiry} where user_id = ${userId}`;
  return data.access_token;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).end();

  const user = checkAuth(req, res);
  if (!user) return;

  const { to, subject, body } = req.body || {};
  if (!to || !subject) return res.status(400).json({ error: 'to and subject are required' });

  const [row] = await sql`select * from gmail_tokens where user_id = ${user.userId}`;
  if (!row) return res.status(403).json({ error: 'Gmail not connected. Connect in Settings → Integrations.' });

  let accessToken = row.access_token;
  if (row.expiry < Math.floor(Date.now() / 1000) + 60) {
    if (!row.refresh_token) return res.status(403).json({ error: 'Gmail token expired. Reconnect in Settings.' });
    accessToken = await refreshToken(user.userId, row.refresh_token);
  }

  const message = [
    `From: ${row.email}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body || '',
  ].join('\r\n');

  const encoded = Buffer.from(message).toString('base64url');

  const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: encoded }),
  });

  if (!sendRes.ok) {
    const err = await sendRes.json();
    return res.status(500).json({ error: err.error?.message || 'Failed to send email' });
  }

  return res.json({ ok: true, message: `Email sent to ${to}` });
}
