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

/* Every call to a mail server gets this long, so one slow mailbox cannot hold a whole tick. */
const CALL_TIMEOUT_MS = 20000;

/* One address, nothing else: no spaces, no line breaks, nothing a header could be built from. */
const ONE_ADDRESS = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;

/**
 * The addresses in a To or Cc value: a list, or text split on , and ;.
 * "Name <a@b.co>" gives a@b.co. Anything that is not one plain address —
 * above all a line break, which would let the value write headers of its
 * own (a Bcc to anyone) — is refused, not cleaned.
 */
export function addresses(value) {
  const list = (Array.isArray(value) ? value : String(value ?? '').split(/[,;]/))
    .map(s => String(s ?? '').trim()).filter(Boolean);
  return list.map((raw) => {
    if (/[\r\n\u0000]/.test(raw)) throw fail(`"${raw.replace(/[\r\n\u0000]+/g, ' ').slice(0, 80)}" is not an email address`);
    const named = /^[^<>]*<([^<>]+)>$/.exec(raw);
    const address = (named ? named[1] : raw).trim();
    if (!ONE_ADDRESS.test(address) || address.length > 254) throw fail(`"${raw.slice(0, 80)}" is not an email address`);
    return address;
  });
}

/* Non-ASCII header text (a Hebrew subject) has to be encoded to arrive whole;
   anything with a control character in it is encoded too, so it can never
   end the header it is in. */
export const header = (value) => {
  const text = String(value ?? '');
  return /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text.replace(/[\r\n]+/g, ' '), 'utf8').toString('base64')}?=`;
};

async function call(url, token, init = {}, fetchImpl = fetch) {
  const res = await fetchImpl(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
    signal: init.signal || AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (res.status === 202 || res.status === 204) return {};
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw fail((data.error && (data.error.message || data.error.code)) || `the mail server answered ${res.status}`);
  return data;
}

/** Runs `fn` over `items`, at most `limit` at a time, keeping their order. */
async function eachLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
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

const gmailFetchAll = (token, ids, fetchImpl) =>
  eachLimited(ids, 5, async (id) => gmailMessage(await call(`${GMAIL}/messages/${id}?format=full`, token, {}, fetchImpl)));

async function gmailList(token, q, limit, fetchImpl) {
  const list = await call(`${GMAIL}/messages?${new URLSearchParams({ q, maxResults: String(limit) })}`, token, {}, fetchImpl);
  return gmailFetchAll(token, (list.messages || []).map(m => m.id), fetchImpl);
}

/** Every id a Gmail search finds (newest first), page after page, up to `cap`. */
async function gmailIds(token, q, cap, fetchImpl) {
  const ids = [];
  let pageToken = '';
  for (let page = 0; page < 10 && ids.length < cap; page++) {
    const params = new URLSearchParams({ q, maxResults: String(Math.min(100, cap - ids.length)) });
    if (pageToken) params.set('pageToken', pageToken);
    const list = await call(`${GMAIL}/messages?${params}`, token, {}, fetchImpl);
    for (const m of list.messages || []) ids.push(m.id);
    pageToken = list.nextPageToken || '';
    if (!pageToken) break;
  }
  return ids;
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
    let from = '';
    try { from = addresses(connection.account)[0] || ''; } catch { /* Gmail fills in the mailbox's own address */ }
    const raw = [
      ...(from ? [`From: ${from}`] : []),
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
 * What a new-mail trigger looks at: mail that reached the inbox after `since`
 * (an ISO time), oldest first, at most `max` of it — and `cursor`, the time
 * to look from next.
 *
 * The cursor moves past everything that was looked at, matching or not, so a
 * run of mail that does not match the query can never hold the trigger in
 * place; and it never moves past mail that matched but was left for next
 * time, so a burst bigger than `max` is never skipped.
 *
 * `query` narrows it: Gmail's own search words for a Gmail connection (Gmail
 * does the matching); for Microsoft 365, plain text looked for in the sender,
 * the subject and the body.
 */
export async function pollMailbox(connection, { since, query, max = 25 }, { fetchImpl = fetch } = {}) {
  const token = await accessToken(connection, { fetchImpl });
  const from = new Date(since);
  const newer = (m) => m.date && new Date(m.date) > from;

  if (connection.kind === 'gmail') {
    const q = `in:inbox after:${Math.floor(from.getTime() / 1000)} ${String(query || '')}`.trim();
    /* Gmail lists newest first: take the oldest `max` of everything found. */
    const ids = await gmailIds(token, q, 500, fetchImpl);
    const oldest = ids.slice(-max).reverse();
    const found = (await gmailFetchAll(token, oldest, fetchImpl)).filter(newer)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    const cursor = found.length ? found[found.length - 1].date : since;
    return { messages: found, cursor };
  }

  const needle = String(query || '').trim().toLowerCase();
  const messages = [];
  let cursor = since;
  let url = `${GRAPH}/mailFolders/inbox/messages?${new URLSearchParams({
    $filter: `receivedDateTime gt ${from.toISOString()}`, $orderby: 'receivedDateTime asc', $top: '50', $select: GRAPH_FIELDS,
  })}`;
  let scanned = 0;
  outer: for (let page = 0; url && page < 6; page++) {
    const data = await call(url, token, { headers: TEXT_BODY }, fetchImpl);
    for (const m of (data.value || []).map(graphMessage)) {
      if (!newer(m)) continue;
      scanned++;
      cursor = m.date;
      if (!needle || `${m.from} ${m.fromName} ${m.subject} ${m.text}`.toLowerCase().includes(needle)) {
        messages.push(m);
        if (messages.length >= max) break outer;
      }
    }
    url = data['@odata.nextLink'] || '';
    if (scanned >= 300) break;
  }
  return { messages, cursor };
}

/**
 * Mail that reached the inbox after `since` (an ISO time), oldest first, at
 * most ten at a time. See pollMailbox for what `query` means.
 */
export async function mailSince(connection, { since, query }, { fetchImpl = fetch } = {}) {
  return (await pollMailbox(connection, { since, query, max: 10 }, { fetchImpl })).messages;
}
