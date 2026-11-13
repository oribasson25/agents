import { waitUntil } from '@vercel/functions';
import { kickWorker, workerAuthorized } from '../_waControl.js';
import { runSession } from '../_waSession.mjs';

// Must match "api/wa/worker.mjs".maxDuration in vercel.json.
const MAX_DURATION_S = 800;
// Kept after the session's deadline for finishing turns, saving keys and starting the next session.
const RESERVE_MS = 75_000;

/**
 * Holds one linked number's WhatsApp connection for ~12 minutes, then hands
 * over to the next session. Started by the cron every minute (as a safety net),
 * by the previous session when it ends, and by the admin screen when someone
 * opens a QR code.
 *
 * Its own file, and an .mjs one, because Baileys is ESM-only: nothing else in
 * the app loads it.
 */
export default function handler(req, res) {
  if (!process.env.CRON_SECRET) return res.status(500).json({ error: 'CRON_SECRET is not set' });
  if (!workerAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
  // Preview deployments share the database; only production may hold a connection.
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') {
    return res.json({ skipped: 'the WhatsApp worker only runs in production' });
  }

  const numberId = String((req.query && req.query.number) || '');
  if (!numberId) return res.status(400).json({ error: 'number is required' });

  // The host this call reached, as the widget and the webhook use. kickWorker
  // follows the bare domain's redirect, so this is the canonical www host;
  // agent tools called back through the bare domain fail from inside Vercel.
  const host = req.headers.host || process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const deadline = Date.now() + MAX_DURATION_S * 1000 - RESERVE_MS;
  waitUntil(
    runSession({ numberId, deadline, baseUrl: `https://${host}` })
      .then(async (result) => {
        console.log(`[wa ${numberId}] session ended: ${result}`);
        if (result === 'done') await kickWorker(numberId);
      })
      .catch((err) => console.error(`[wa ${numberId}] session crashed:`, err)),
  );
  res.status(202).json({ started: true });
}
