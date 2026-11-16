/**
 * Mail through a connection: send, search, and "what arrived since".
 *
 * One shape in and out whichever mailbox is behind it — a Gmail connection
 * or a Microsoft 365 one — so a step does not care which it was given:
 *
 *   message = { id, from, fromName, to, subject, text, date }
 */
import { accessToken } from './_connections.js';

const fail = (message) => new Error(message);
const clip = (text, max = 20000) => { const t = String(text || ''); return t.length > max ? t.slice(0, max) : t; };

const addresses = (value) => (Array.isArray(value) ? value : String(value || '').split(/[,;]/))
  .map(s => String(s).trim()).filter(Boolean);

/* Non-ASCII header text (a Hebrew subject) has to be encoded to arrive whole. */
const header = (value) => (/^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`);

async function call(url, token, init = {}, fetchImpl = fetch) {
  const res = await fetchImpl(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
  if (res.status === 202 || res.status === 204) return {};
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw fail((data.error && (data.error.message || data.error.code)) || `the mail server answered ${res.status}`);
  return data;
}

/* ─────────────────── Gmail ─────────────────── */

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

function gmailBody(payload) {
  const decode = (part) => (part && part.body && part.body.data ? Buffer.from(part.body.data, 'base64url').toString('utf8') : '');
  const find = (part, type) => {
    if (!part) return '';
    if (part.mimeType === type && part.body && part.body.data) return decode(part);
    for (const child of part.parts || []) { const hit = find(child, type); if (hit) return hit; }
    return '';
  };
  const plain = find(payload, 'text/plain');
  if (plain) return plain;
  const html = find(payload, 'text/html');
  return html ? html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '').replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
                    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim() : '';
}

function gmailMessage(m) {
  const h = Object.fromEntries(((m.payload && m.payload.headers) || []).map(x => [x.name.toLowerCase(), x.value]));
  const from = /<([^>]+)>/.exec(h.from || '');
  return {
    id: m.id,
    from: (from ? from[1] : (h.from || '')).trim(),
    fromName: from ? (h.from || '').replace(/<[^>]+>/, '').replace(/"/g, '').trim() : '',
    to: h.to || '',
    subject: h.subject || '',
    text: clip(gmailBody(m.payload) || m.snippet || ''),
    date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null,
  };
}

async function gmailList(token, q, limit, fetchImpl) {
  const list = await call(`${GMAIL}/messages?${new URLSearchParams({ q, maxResults: String(limit) })}`, token, {}, fetchImpl);
  const out = [];
  for (const { id } of list.messages || []) {
    out.push(gmailMessage(await call(`${GMAIL}/messages/${id}?format=full`, token, {}, fetchImpl)));
  }
  return out;
}

/* ─────────────────── Microsoft 365 ─────────────────── */

const GRAPH = 'https://graph.microsoft.com/v1.0/me';
const TEXT_BODY = { Prefer: 'outlook.body-content-type="text"' };
const GRAPH_FIELDS = 'id,subject,from,toRecipients,receivedDateTime,bodyPreview,body';

const graphMessage = (m) => ({
  id: m.id,
  from: ((m.from && m.from.emailAddress && m.from.emailAddress.address) || '').trim(),
  fromName: (m.from && m.from.emailAddress && m.from.emailAddress.name) || '',
  to: (m.toRecipients || []).map(r => r.emailAddress && r.emailAddress.address).filter(Boolean).join(', '),
  subject: m.subject || '',
  text: clip((m.body && m.body.content) || m.bodyPreview || ''),
  date: m.receivedDateTime || null,
});

/* ─────────────────── the three things a step does ─────────────────── */

export async function sendMail(connection, { to, subject, body, cc }, { fetchImpl = fetch } = {}) {
  const recipients = addresses(to);
  if (!recipients.length) throw fail('needs someone to send to');
  const copies = addresses(cc);
  const token = await accessToken(connection, { fetchImpl });

  if (connection.kind === 'gmail') {
    const raw = [
      `From: ${connection.account}`,
      `To: ${recipients.join(', ')}`,
      ...(copies.length ? [`Cc: ${copies.join(', ')}`] : []),
      `Subject: ${header(String(subject || ''))}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(String(body || ''), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
    ].join('\r\n');
    const sent = await call(`${GMAIL}/messages/send`, token, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: Buffer.from(raw, 'utf8').toString('base64url') }),
    }, fetchImpl);
    return { id: sent.id || null, from: connection.account, to: recipients };
  }

  const person = (address) => ({ emailAddress: { address } });
  await call(`${GRAPH}/sendMail`, token, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: {
      subject: String(subject || ''), body: { contentType: 'Text', content: String(body || '') },
      toRecipients: recipients.map(person), ccRecipients: copies.map(person),
    }, saveToSentItems: true }),
  }, fetchImpl);
  return { id: null, from: connection.account, to: recipients };
}

export async function searchMail(connection, { query, limit = 10 }, { fetchImpl = fetch } = {}) {
  const n = Math.max(1, Math.min(25, Number(limit) || 10));
  const token = await accessToken(connection, { fetchImpl });
  if (connection.kind === 'gmail') return gmailList(token, String(query || ''), n, fetchImpl);
  const q = String(query || '').trim();
  const params = q
    ? { $search: `"${q.replace(/"/g, '')}"`, $top: String(n), $select: GRAPH_FIELDS }
    : { $orderby: 'receivedDateTime desc', $top: String(n), $select: GRAPH_FIELDS };
  const data = await call(`${GRAPH}/messages?${new URLSearchParams(params)}`, token, { headers: TEXT_BODY }, fetchImpl);
  return (data.value || []).map(graphMessage);
}

/**
 * Mail that reached the inbox after `since` (an ISO time), oldest first, at
 * most ten at a time. `query` narrows it: Gmail's own search words for a
 * Gmail connection; for Microsoft 365, plain text looked for in the sender,
 * the subject and the body.
 */
export async function mailSince(connection, { since, query }, { fetchImpl = fetch } = {}) {
  const token = await accessToken(connection, { fetchImpl });
  const from = new Date(since);
  let found;
  if (connection.kind === 'gmail') {
    const q = `in:inbox after:${Math.floor(from.getTime() / 1000)} ${String(query || '')}`.trim();
    found = await gmailList(token, q, 10, fetchImpl);
  } else {
    const data = await call(`${GRAPH}/mailFolders/inbox/messages?${new URLSearchParams({
      $filter: `receivedDateTime gt ${from.toISOString()}`, $orderby: 'receivedDateTime asc', $top: '10', $select: GRAPH_FIELDS,
    })}`, token, { headers: TEXT_BODY }, fetchImpl);
    const needle = String(query || '').trim().toLowerCase();
    found = (data.value || []).map(graphMessage)
      .filter(m => !needle || `${m.from} ${m.fromName} ${m.subject} ${m.text}`.toLowerCase().includes(needle));
  }
  /* Gmail's `after:` is to the second and inclusive; the exact cut is made here. */
  return found.filter(m => m.date && new Date(m.date) > from).sort((a, b) => new Date(a.date) - new Date(b.date));
}
