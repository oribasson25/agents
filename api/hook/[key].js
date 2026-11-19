import crypto from 'crypto';
import { waitUntil } from '@vercel/functions';
import { sql } from '../_db.js';
import { byHookKey, startRun, workRun } from '../_automations.js';
import { logError } from '../_errorLog.js';

/**
 * A webhook trigger's address: /api/hook/<key>.
 *
 * Anyone holding the address can fire the automation — the key in it is the
 * credential, 24 random bytes, and the trigger can ask for a secret header on
 * top. There is no session here and nothing of the account is shown: the
 * caller gets a run id, or (when the trigger is set to wait) what the
 * automation's Output step returned.
 *
 * What the run is handed is bounded: the headers a sender would use (the
 * platform's own, cookies and credentials are dropped), a body of at most
 * 256 KB, and no more than RATE_PER_MINUTE firings a minute per address. A
 * caller set to wait is answered within WAIT_MS; the run carries on after.
 */
const RATE_PER_MINUTE = 60;
const MAX_BODY_BYTES = 256 * 1024;
const WAIT_MS = 50 * 1000;
const CHAIN_HEADER = 'x-8legs-chain';

const same = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const KEEP = new Set(['content-type', 'content-length', 'content-encoding', 'user-agent', 'accept', 'accept-language',
                      'date', 'origin', 'referer', 'idempotency-key']);
const DROP = /^(x-vercel-|x-forwarded-|x-real-ip$|x-middleware-|x-hook-secret$|x-internal-secret$|x-8legs-|cf-|true-client-ip$|forwarded$)/;
const SENDER = /signature|hmac|webhook|event|delivery|request-id|timestamp|topic|hook/i;

/** The headers worth handing to a run: the standard ones, and a sender's own `x-…` and signature headers. */
export function hookHeaders(raw) {
  const out = {};
  for (const [name, value] of Object.entries(raw || {})) {
    const k = String(name).toLowerCase();
    if (DROP.test(k) || k === 'authorization' || k === 'cookie' || k === 'proxy-authorization') continue;
    if (!KEEP.has(k) && !k.startsWith('x-') && !SENDER.test(k)) continue;
    out[k] = String(Array.isArray(value) ? value.join(', ') : value ?? '').slice(0, 1000);
    if (Object.keys(out).length >= 50) break;
  }
  return out;
}

/* Postgres jsonb cannot hold a NUL character; it is dropped rather than failing the call. */
function withoutNul(value, depth = 0) {
  if (typeof value === 'string') return value.includes('\u0000') ? value.replace(/\u0000/g, '') : value;
  if (!value || typeof value !== 'object' || depth > 64) return value;
  if (Array.isArray(value)) return value.map(v => withoutNul(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[withoutNul(k)] = withoutNul(v, depth + 1);
  return out;
}

/** The body as the run will hold it; `ok: false` when it is too large to take. */
export function hookBody(body) {
  if (body === undefined || body === null) return { ok: true, value: null };
  let text;
  try { text = JSON.stringify(body); }
  catch { return { ok: false }; }
  if (text === undefined) return { ok: true, value: null };
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return { ok: false };
  return { ok: true, value: withoutNul(JSON.parse(text)) };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Hook-Secret');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const row = await byHookKey(req.query.key);
    const live = row && row.enabled && row.published && row.published.trigger.type === 'webhook';
    /* One answer for "no such address" and "not switched on", so the address
       says nothing about what exists. */
    if (!live) return res.status(404).json({ error: 'No automation is listening at this address' });

    const config = row.published.trigger.config || {};
    if (config.secret) {
      const want = (row.secrets || {})[config.secret];
      if (!want || !same(req.headers['x-hook-secret'], want)) {
        return res.status(401).json({ error: 'The X-Hook-Secret header is missing or wrong' });
      }
    }

    const [{ n } = { n: 0 }] = await sql`
      select count(*)::int as n from automation_runs
      where automation_id = ${row.id} and source = 'webhook' and started_at > now() - interval '1 minute'
    `;
    if (n >= RATE_PER_MINUTE) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ error: 'This address is being called too often. Try again in a minute.' });
    }

    const body = hookBody(req.body);
    if (!body.ok) return res.status(413).json({ error: `The body is larger than ${MAX_BODY_BYTES / 1024} KB` });

    const { key, ...query } = req.query;
    const input = { method: req.method, query, headers: hookHeaders(req.headers), body: body.value };
    /* An automation calling this address from its own HTTP step says how deep its chain is. */
    const depth = Math.max(0, Math.min(99, parseInt(req.headers[CHAIN_HEADER], 10) || 0));

    const runId = await startRun({ row, mode: 'live', source: 'webhook', input, host: req.headers.host, depth });
    if (config.respond === 'wait') {
      const run = await workRun(runId, { host: req.headers.host, budgetMs: WAIT_MS, hardBudgetMs: WAIT_MS + 30 * 1000 });
      if (run && run.status === 'done') return res.status(200).json(run.output ?? { ok: true });
      if (run && run.status === 'failed') return res.status(500).json({ error: 'The automation failed', runId });
      return res.status(202).json({ runId, status: run ? run.status : 'queued' });
    }
    waitUntil(workRun(runId, { host: req.headers.host }).catch((err) => console.error('[automations] hook run', runId, err.message)));
    return res.status(202).json({ runId, status: 'queued' });
  } catch (err) {
    /* A designed refusal (not published, invalid, too deep) is said as it is;
       anything else is logged here and the caller learns only that it failed. */
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message, code: err.code });
    console.error('[automations] hook', err);
    await logError({ source: 'automation', message: `webhook: ${err.message}`, context: { step: 'hook' } }).catch(() => {});
    return res.status(500).json({ error: 'The automation could not be started' });
  }
}
