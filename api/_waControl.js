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

/**
 * `host` is the address the publishing worker was reached on: one where a
 * production worker answers from inside Vercel, which kickWorker falls back
 * to when its own address fails. A state published without one keeps the
 * host already stored.
 */
export async function publishState(numberId, state, { host } = {}) {
  const payload = JSON.stringify({ ...state, ...(host && { host }), updatedAt: Date.now() });
  const phone = state.status === 'open' && state.me?.id ? state.me.id.split('@')[0].split(':')[0] : undefined;
  if (phone) {
    await sql`
      update wa_numbers
         set state = jsonb_strip_nulls(jsonb_build_object('host', state->'host')) || ${payload}::jsonb,
             phone = ${phone}, updated_at = now()
       where id = ${numberId}
    `;
  } else if (state.status === 'logged_out') {
    await sql`
      update wa_numbers
         set state = jsonb_strip_nulls(jsonb_build_object('host', state->'host')) || ${payload}::jsonb,
             phone = null, updated_at = now()
       where id = ${numberId}
    `;
  } else {
    await sql`
      update wa_numbers
         set state = jsonb_strip_nulls(jsonb_build_object('host', state->'host')) || ${payload}::jsonb,
             updated_at = now()
       where id = ${numberId}
    `;
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

/**
 * What the worker looks for while it holds a number, in one round trip: an
 * admin's command (taken, so it runs once) and whether automations left
 * messages to send. The worker asks less often while both stay empty.
 */
export async function poll(numberId) {
  const [row] = await sql`
    with taken as (
      update wa_numbers n set command = null
      from (select id, command from wa_numbers where id = ${numberId} and command is not null) old
      where n.id = old.id
      returning old.command
    )
    select (select command from taken) as command,
           /* A row a dead worker left in 'sending' counts too: otherwise it waits
              for the next queued message to wake the sender (requeueStuck runs
              there) and, on a quiet number, is never sent. Same window as
              requeueStuck. */
           exists (select 1 from wa_outbox where number_id = ${numberId}
                     and (status = 'queued'
                          or (status = 'sending' and created_at < now() - interval '3 minutes'
                              and created_at > now() - interval '1 hour'))) as outbox
  `;
  return { command: row?.command || null, outbox: !!row?.outbox };
}

/** A number WhatsApp refused for good (403) waits for an admin: the cron leaves it alone. */
export const isBlocked = (number) => number?.state?.status === 'blocked';

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
 * `via` is the host the caller's own request came in on. From the admin
 * screen and from a worker handing over, that is a public address that
 * reaches production. From the cron it is the deployment's own URL, which
 * Vercel's Deployment Protection answers with a redirect to its login page.
 * The production URL is no sure thing either: it can be a bare domain a
 * function inside Vercel cannot reach ("fetch failed"), or a domain added to
 * the project before its DNS was set up (it does not resolve at all).
 *
 * So, in order: the caller's host; the address the number's last worker was
 * reached on (wa_numbers.state.host, which every worker publishes); APP_URL;
 * the production URL's www form; the production URL; and only then this
 * deployment's own URL, which reaches this deployment alone and only when
 * Deployment Protection is off.
 *
 * The remembered address is what lets the cron bring a number back with
 * nobody signed in. It used to live in wa_numbers.worker_host (migration 027),
 * which production never got, so the cron had nothing that worked and a
 * dropped number stayed down until someone opened its page.
 */
export async function kickWorker(numberId, { via } = {}) {
  if (!process.env.CRON_SECRET) return false;
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const own = process.env.VERCEL_URL;
  const [row] = await sql`select state->>'host' as host from wa_numbers where id = ${numberId}`.catch(() => []);
  const hosts = [...new Set([
    via !== own ? via : null,
    row?.host,
    hostOf(process.env.APP_URL),
    prod && !prod.startsWith('www.') ? `www.${prod}` : null,
    prod,
    via,
  ].filter(Boolean))];
  for (const host of hosts) {
    if (await kickAt(host, numberId)) return true;
  }
  console.error(`[wa] no address started a worker for ${numberId} (tried ${hosts.join(', ') || 'none'})`);
  return false;
}

/**
 * The host to remember for a worker reached on `host`: null for this
 * deployment's own URL, which keeps pointing at this deployment after the
 * next one is promoted, so a chain started there would never run new code.
 */
export function publicHost(host) {
  return host && host !== process.env.VERCEL_URL ? host : null;
}

/** "https://www.8legs.world/" or "www.8legs.world\n" → "www.8legs.world"; null when unusable. */
function hostOf(url) {
  const raw = String(url || '').replace(/[\s\u0000-\u001f\u007f]+/g, '');
  if (!raw) return null;
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).host || null;
  } catch {
    return null;
  }
}

/** One attempt at one host: the host that answered when a production worker took the call, else null. */
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
          return null;
        }
        url = next;
        continue;
      }
      if (!res.ok) {
        console.error(`[wa] worker for ${numberId} answered ${res.status} at ${url.host}`);
        return null;
      }
      // A preview deployment answers 200 { skipped } and holds nothing.
      const body = await res.json().catch(() => ({}));
      return body.started ? url.host : null;
    }
    console.error(`[wa] too many redirects starting a worker for ${numberId} at ${host}`);
    return null;
  } catch (err) {
    const cause = err.cause ? ` (${err.cause.code || err.cause.message})` : '';
    console.error(`[wa] could not start a worker for ${numberId} at ${url.host}: ${err.message}${cause}`);
    return null;
  }
}

const sameSite = (hostname) => hostname.toLowerCase().replace(/^www\./, '');
