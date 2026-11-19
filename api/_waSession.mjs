import * as control from './_waControl.js';
import { isLinked } from './_waAuth.mjs';
import { WhatsApp } from './_waConnection.mjs';
import { createRouter } from './_waRouter.mjs';

const RENEW_MS = 45_000;
// A renewal that has not answered in this long is given up on; the next one tries again.
const RENEW_TIMEOUT_MS = 15_000;
// The socket is closed this long before the lease would run out, renewals failing:
// past that point the next session may already be connecting the same number.
const LEASE_MARGIN_MS = 30_000;
/* How often to look for an admin's command and for messages automations
   asked this number to send: often right after there was something, then
   less and less while there is nothing (an idle number used to cost ~60,000
   queries a day). */
const POLL_STEPS_MS = [2_000, 5_000, 10_000, 15_000];
const REMINDER_POLL_MS = 30_000;
// How often the number's own row is read again (switched off, unlinked).
const NUMBER_CHECK_MS = 45_000;
const DRAIN_MS = 45_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (promise, ms) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`no answer in ${ms / 1000}s`)), ms).unref?.()),
]);

/**
 * Holds one number's WhatsApp connection until `deadline`, then shuts down
 * cleanly so the next session can take over. The lease on the wa_numbers row
 * makes sure only one session is connected for a number at any moment: it is
 * renewed on a timer of its own (a slow query in the loop cannot starve it),
 * and when renewals keep failing the socket is closed before the lease runs
 * out, never after.
 *
 * `host` (the public address this worker was reached on) goes out with every
 * state it publishes: the cron starts the next worker there when its own
 * address does not reach production.
 *
 * Returns why it ended: 'busy' (another session holds the lease), 'idle'
 * (nothing linked and nobody looking at the QR), 'disabled', 'blocked'
 * (WhatsApp refused the device; an admin has to look), 'done' (reached the
 * deadline), 'logout', 'replaced', 'lost-lease'.
 */
export async function runSession({ numberId, deadline, baseUrl, host = null }) {
  const token = await control.acquireLease(numberId);
  if (!token) return 'busy';

  let result = 'done';
  let wa;
  let renewTimer = null;
  try {
    let number = await control.getNumber(numberId);
    if (!number || !number.enabled) return (result = 'disabled');
    const qrWanted = () => !!number.qr_wanted_until && new Date(number.qr_wanted_until) > new Date();
    if (control.isBlocked(number) && !qrWanted()) return (result = 'blocked');
    if (!(await isLinked(numberId)) && !qrWanted()) return (result = 'idle');

    /* Lease bookkeeping runs on the monotonic clock, not Date.now(). */
    let leaseOkAt = performance.now();
    let leaseLost = false;
    let renewing = false;
    renewTimer = setInterval(() => {
      if (renewing || leaseLost) return;
      renewing = true;
      withTimeout(control.renewLease(numberId, token), RENEW_TIMEOUT_MS)
        .then((ok) => { if (ok) leaseOkAt = performance.now(); else leaseLost = true; })
        .catch((err) => console.warn(`[wa ${numberId}] lease renewal failed:`, err.message))
        .finally(() => {
          renewing = false;
          if (!leaseLost && performance.now() - leaseOkAt > control.LEASE_TTL_MS - LEASE_MARGIN_MS) leaseLost = true;
          if (leaseLost) wa?.stop().catch(() => {});
        });
    }, RENEW_MS);
    renewTimer.unref?.();

    wa = new WhatsApp({ numberId });
    wa.on('state', (s) => {
      control.publishState(numberId, s, { host }).catch((err) => console.warn(`[wa ${numberId}] state publish failed:`, err.message));
    });
    const router = createRouter(wa, numberId, { baseUrl, deadline });
    await wa.start();

    let lastPoll = 0;
    let pollStep = 0;
    let lastReminders = 0;
    let lastNumber = Date.now();
    while (Date.now() < deadline) {
      await sleep(1000);
      if (leaseLost) {
        result = 'lost-lease';
        break;
      }
      if (wa.fatal) {
        result = wa.fatal;
        break;
      }
      if (Date.now() - lastPoll >= POLL_STEPS_MS[pollStep]) {
        lastPoll = Date.now();
        let found = { command: null, outbox: false };
        try {
          found = await control.poll(numberId);
        } catch (err) {
          console.warn(`[wa ${numberId}] poll failed:`, err.message);
        }
        if (found.command === 'logout') {
          await wa.logout();
          result = 'logout';
          break;
        }
        if (found.outbox) {
          /* Not awaited: sending paces itself, and the loop has a number to watch. */
          Promise.resolve(router.sendOutbox?.()).catch((err) => console.warn(`[wa ${numberId}] outbox failed:`, err.message));
        }
        pollStep = found.outbox || found.command ? 0 : Math.min(pollStep + 1, POLL_STEPS_MS.length - 1);
      }
      // Nothing new starts in the last minute: the next session picks it up instead of this one dropping it half-sent.
      if (Date.now() - lastReminders >= REMINDER_POLL_MS && deadline - Date.now() > 60_000) {
        lastReminders = Date.now();
        // Not awaited: a scheduled message may take a model call.
        Promise.resolve(router.runDue?.()).catch((err) => console.warn(`[wa ${numberId}] due jobs failed:`, err.message));
      }
      if (Date.now() - lastNumber >= NUMBER_CHECK_MS) {
        lastNumber = Date.now();
        try {
          number = (await control.getNumber(numberId)) || null;
        } catch (err) {
          console.warn(`[wa ${numberId}] could not read the number:`, err.message);
          continue;
        }
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
    if (renewTimer) clearInterval(renewTimer);
    await wa?.stop().catch((err) => console.warn(`[wa ${numberId}] stop failed:`, err.message));
    if (result !== 'lost-lease') await control.releaseLease(numberId, token);
    if (result === 'idle' || result === 'disabled') {
      await control.publishState(numberId, { status: result === 'idle' ? 'unlinked' : 'paused', qr: null }, { host }).catch(() => {});
    }
  }
  return result;
}
