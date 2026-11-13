import crypto from 'crypto';
import { sql } from './_db.js';

/*
 * Coordination between the admin screens and the worker sessions that hold the
 * WhatsApp connections of linked numbers. They run in separate invocations, so
 * everything goes through the wa_numbers row: the worker publishes its state
 * there, the admin screen leaves commands there, and a lease on the row makes
 * sure only one session is connected per number at any moment.
 *
 * No Baileys in here — the admin endpoints import this file too.
 */

export const LEASE_TTL_MS = 120_000; // a crashed session blocks the next one for at most this long
export const QR_WINDOW_MS = 150_000; // an open QR screen keeps an unlinked worker alive this long

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
}

/** Digits only: "+972 54-555 0118" → "972545550118". A leading 0 is read as an Israeli number. */
export function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = '972' + d.slice(1);
  return d;
}

export async function getNumber(id) {
  const [row] = await sql`select * from wa_numbers where id = ${id}`;
  return row || null;
}

/* ---------- connection state (worker writes, admin reads) ---------- */

export async function publishState(numberId, state) {
  const payload = { ...state, updatedAt: Date.now() };
  const phone = state.status === 'open' && state.me?.id ? state.me.id.split('@')[0].split(':')[0] : undefined;
  if (phone) {
    await sql`
      update wa_numbers set state = ${JSON.stringify(payload)}, phone = ${phone}, updated_at = now()
      where id = ${numberId}
    `;
  } else if (state.status === 'logged_out') {
    await sql`update wa_numbers set state = ${JSON.stringify(payload)}, phone = null, updated_at = now() where id = ${numberId}`;
  } else {
    await sql`update wa_numbers set state = ${JSON.stringify(payload)}, updated_at = now() where id = ${numberId}`;
  }
}

/** The admin is looking at the QR: keep an unlinked worker running for a while. */
export async function markQrWanted(numberId) {
  await sql`
    update wa_numbers set qr_wanted_until = now() + ${`${QR_WINDOW_MS} milliseconds`}::interval
    where id = ${numberId}
  `;
}

/* ---------- commands (admin asks, worker performs) ---------- */

export async function setCommand(numberId, command) {
  await sql`update wa_numbers set command = ${command}, updated_at = now() where id = ${numberId}`;
}

export async function takeCommand(numberId) {
  const [row] = await sql`
    update wa_numbers n set command = null
    from (select id, command from wa_numbers where id = ${numberId} and command is not null) old
    where n.id = old.id
    returning old.command
  `;
  return row?.command || null;
}

/* ---------- the lease: at most one session per number ---------- */

export async function acquireLease(numberId, ttlMs = LEASE_TTL_MS) {
  const token = crypto.randomUUID();
  const [row] = await sql`
    update wa_numbers
       set lease_token = ${token},
           lease_until = now() + ${`${ttlMs} milliseconds`}::interval
     where id = ${numberId}
       and (lease_until is null or lease_until < now())
    returning id
  `;
  return row ? token : null;
}

export async function renewLease(numberId, token, ttlMs = LEASE_TTL_MS) {
  const [row] = await sql`
    update wa_numbers set lease_until = now() + ${`${ttlMs} milliseconds`}::interval
    where id = ${numberId} and lease_token = ${token}
    returning id
  `;
  return !!row;
}

export async function releaseLease(numberId, token) {
  await sql`
    update wa_numbers set lease_token = null, lease_until = null
    where id = ${numberId} and lease_token = ${token}
  `;
}

export async function leaseHeld(numberId) {
  const [row] = await sql`select (lease_until is not null and lease_until > now()) as held from wa_numbers where id = ${numberId}`;
  return !!row?.held;
}

/* ---------- starting worker sessions on Vercel ---------- */

export function workerAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  return !!secret && req.headers.authorization === `Bearer ${secret}`;
}

/**
 * Why a worker cannot be started on this deployment, in words an admin can
 * act on — or null when nothing is missing. Without it the QR screen just
 * waits forever for a code no worker will ever publish.
 */
export function workerSetupProblem() {
  if (!process.env.CRON_SECRET) {
    return 'CRON_SECRET is not set in this Vercel project, so the WhatsApp worker cannot start. Add it under Settings › Environment Variables (Production) and redeploy.';
  }
  if (!process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return 'VERCEL_PROJECT_PRODUCTION_URL is missing, so the WhatsApp worker cannot be started. Turn on "Automatically expose System Environment Variables" in the Vercel project settings and redeploy.';
  }
  return null;
}

/**
 * Starts a worker session for one number now instead of waiting for the next
 * cron tick. The worker answers 202 right away and keeps running on its own.
 *
 * `via` is the host the caller's own request came in on: a host that is known
 * to reach this deployment. The production URL alone is not enough — it is
 * often the bare domain (8legs.world), which a function inside Vercel cannot
 * reach at all ("fetch failed"), while www works. So: the caller's host first,
 * then the production URL's www form, then the production URL itself.
 */
export async function kickWorker(numberId, { via } = {}) {
  if (!process.env.CRON_SECRET) return false;
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const hosts = [...new Set([via, prod && !prod.startsWith('www.') ? `www.${prod}` : null, prod].filter(Boolean))];
  for (const host of hosts) {
    if (await kickAt(host, numberId)) return true;
  }
  return false;
}

/** One attempt at one host. True only when a production worker took the call. */
async function kickAt(host, numberId) {
  let url = new URL(`https://${host}/api/wa/worker?number=${encodeURIComponent(numberId)}`);
  try {
    // fetch drops the Authorization header on a redirect to another host (bare
    // domain → www), and the worker then refuses the call. So follow redirects
    // here, only within the same site, so the secret never goes anywhere else.
    for (let hop = 0; hop < 3; hop++) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (location) {
        const next = new URL(location, url);
        if (next.protocol !== 'https:' || sameSite(next.hostname) !== sameSite(url.hostname)) {
          console.error(`[wa] not following the worker redirect from ${url.host} to ${next.host}`);
          return false;
        }
        url = next;
        continue;
      }
      if (!res.ok) {
        console.error(`[wa] worker for ${numberId} answered ${res.status} at ${url.host}`);
        return false;
      }
      // A preview deployment answers 200 { skipped } and holds nothing.
      const body = await res.json().catch(() => ({}));
      return !!body.started;
    }
    console.error(`[wa] too many redirects starting a worker for ${numberId} at ${host}`);
    return false;
  } catch (err) {
    const cause = err.cause ? ` (${err.cause.code || err.cause.message})` : '';
    console.error(`[wa] could not start a worker for ${numberId} at ${url.host}: ${err.message}${cause}`);
    return false;
  }
}

const sameSite = (hostname) => hostname.toLowerCase().replace(/^www\./, '');
