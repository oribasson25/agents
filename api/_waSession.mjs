import * as control from './_waControl.js';
import { isLinked } from './_waAuth.mjs';
import { WhatsApp } from './_waConnection.mjs';
import { createRouter } from './_waRouter.mjs';

const RENEW_MS = 45_000;
const COMMAND_POLL_MS = 5_000;
const REMINDER_POLL_MS = 30_000;
// How often to look for messages automations asked this number to send.
const OUTBOX_POLL_MS = 2_000;
const DRAIN_MS = 45_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Holds one number's WhatsApp connection until `deadline`, then shuts down
 * cleanly so the next session can take over. The lease on the wa_numbers row
 * makes sure only one session is connected for a number at any moment.
 *
 * `host` (the public address this worker was reached on) goes out with every
 * state it publishes: the cron starts the next worker there when its own
 * address does not reach production.
 *
 * Returns why it ended: 'busy' (another session holds the lease), 'idle'
 * (nothing linked and nobody looking at the QR), 'disabled', 'done' (reached
 * the deadline), 'logout', 'replaced', 'lost-lease'.
 */
export async function runSession({ numberId, deadline, baseUrl, host = null }) {
  const token = await control.acquireLease(numberId);
  if (!token) return 'busy';

  let result = 'done';
  let wa;
  try {
    let number = await control.getNumber(numberId);
    if (!number || !number.enabled) return (result = 'disabled');
    const qrWanted = () => !!number.qr_wanted_until && new Date(number.qr_wanted_until) > new Date();
    if (!(await isLinked(numberId)) && !qrWanted()) return (result = 'idle');

    wa = new WhatsApp({ numberId });
    wa.on('state', (s) => {
      control.publishState(numberId, s, { host }).catch((err) => console.warn(`[wa ${numberId}] state publish failed:`, err.message));
    });
    const router = createRouter(wa, numberId, { baseUrl });
    await wa.start();

    let lastRenew = Date.now();
    let lastCommand = 0;
    let lastReminders = 0;
    let lastOutbox = 0;
    while (Date.now() < deadline) {
      await sleep(1000);
      if (Date.now() - lastOutbox >= OUTBOX_POLL_MS) {
        lastOutbox = Date.now();
        /* Not awaited: sending paces itself, and the loop has a lease to keep. */
        router.sendOutbox().catch((err) => console.warn(`[wa ${numberId}] outbox failed:`, err.message));
      }
      if (wa.fatal) {
        result = wa.fatal;
        break;
      }
      if (Date.now() - lastCommand >= COMMAND_POLL_MS) {
        lastCommand = Date.now();
        if ((await control.takeCommand(numberId)) === 'logout') {
          await wa.logout();
          result = 'logout';
          break;
        }
      }
      // Nothing new starts in the last minute: the next session picks it up instead of this one dropping it half-sent.
      if (Date.now() - lastReminders >= REMINDER_POLL_MS && deadline - Date.now() > 60_000) {
        lastReminders = Date.now();
        // Not awaited: a scheduled message may take a model call, and the lease must keep renewing.
        router.runDue().catch((err) => console.warn(`[wa ${numberId}] due jobs failed:`, err.message));
      }
      if (Date.now() - lastRenew >= RENEW_MS) {
        lastRenew = Date.now();
        if (!(await control.renewLease(numberId, token))) {
          result = 'lost-lease';
          break;
        }
        number = await control.getNumber(numberId);
        if (!number || !number.enabled) {
          result = 'disabled';
          break;
        }
        if (!wa.linked && !qrWanted()) {
          result = 'idle';
          break;
        }
      }
    }
    if (result === 'done') await router.drain(DRAIN_MS);
  } finally {
    await wa?.stop().catch((err) => console.warn(`[wa ${numberId}] stop failed:`, err.message));
    if (result !== 'lost-lease') await control.releaseLease(numberId, token);
    if (result === 'idle' || result === 'disabled') {
      await control.publishState(numberId, { status: result === 'idle' ? 'unlinked' : 'paused', qr: null }, { host }).catch(() => {});
    }
  }
  return result;
}
