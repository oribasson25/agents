import crypto from 'crypto';
import { waitUntil } from '@vercel/functions';
import { byHookKey, startRun, workRun } from '../_automations.js';

/**
 * A webhook trigger's address: /api/hook/<key>.
 *
 * Anyone holding the address can fire the automation — the key in it is the
 * credential, 24 random bytes, and the trigger can ask for a secret header on
 * top. There is no session here and nothing of the account is shown: the
 * caller gets a run id, or (when the trigger is set to wait) what the
 * automation's Output step returned.
 */
const same = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Hook-Secret');
  if (req.method === 'OPTIONS') return res.status(204).end();

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

  const { key, ...query } = req.query;
  const headers = { ...req.headers };
  for (const h of ['authorization', 'cookie', 'x-hook-secret']) delete headers[h];
  const input = { method: req.method, query, headers, body: req.body ?? null };

  try {
    const runId = await startRun({ row, mode: 'live', source: 'webhook', input, host: req.headers.host });
    if (config.respond === 'wait') {
      const run = await workRun(runId, { host: req.headers.host });
      if (run && run.status === 'done') return res.status(200).json(run.output ?? { ok: true });
      if (run && run.status === 'failed') return res.status(500).json({ error: 'The automation failed', runId });
      return res.status(202).json({ runId, status: run ? run.status : 'queued' });
    }
    waitUntil(workRun(runId, { host: req.headers.host }).catch((err) => console.error('[automations] hook run', runId, err.message)));
    return res.status(202).json({ runId, status: 'queued' });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
}
