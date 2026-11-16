import { sql } from '../_db.js';
import { kickWorker, workerAuthorized } from '../_waControl.js';
import { pruneGroups } from '../_waGroups.js';

/**
 * Every minute: make sure each linked number has a worker session holding its
 * connection. Sessions normally chain one into the next on their own; this is
 * the safety net that brings a number back within a minute or two if a chain
 * breaks (a crash, a socket WhatsApp closed for good, a session cut off at
 * maxDuration once its lease runs out), with nobody signed in. A number
 * nobody linked yet only runs while an admin has its QR open; a disabled or
 * unlinked number is left alone.
 *
 * This request's own host is the deployment URL, which does not reach a
 * worker (Deployment Protection); kickWorker goes through the public address
 * the number's last worker published instead.
 */
export default async function handler(req, res) {
  if (!workerAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  const rows = await sql`
    select id from wa_numbers
    where enabled
      and (phone is not null or qr_wanted_until > now())
      and (lease_until is null or lease_until < now())
  `;
  const kicked = await Promise.all(rows.map(async (r) => ({ id: r.id, ok: await kickWorker(r.id, { via: req.headers.host }) })));

  // Only the last few days matter for spotting a redelivered message.
  await sql`delete from wa_seen where created_at < now() - interval '3 days'`.catch(() => {});
  // Group messages and the activity log are kept for 30 days; once an hour is enough.
  if (new Date().getUTCMinutes() === 0) await pruneGroups().catch(() => {});

  return res.json({ kicked });
}
