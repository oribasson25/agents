import { sql } from './_db.js';

/**
 * Brakes on guessing and on spending, kept in one table (auth_throttle).
 *
 * The login brake (isLocked / recordFailure / hitLocked / refund):
 *  - it fails OPEN — a database error means the login proceeds, because the
 *    login itself needs the same database and a brake that cannot be read
 *    should not be what turns a blip into an outage;
 *  - the window is short (WINDOW_MIN) and the lock is short (LOCK_MIN);
 *  - the per-address count is taken atomically BEFORE the password is
 *    checked (hitLocked), so fifty guesses sent at once are fifty, not one;
 *  - a correct password refunds its own attempt but never wipes the address's
 *    record, so an account of your own cannot launder guesses at others'
 *    (password spraying);
 *  - a username is never locked out by strangers: its record only slows the
 *    answer down (see api/auth/login.js).
 *
 * rateLimit() is the general form for anything else a stranger can repeat at
 * the platform's expense (the widget, app backends, webhooks). It fails
 * CLOSED unless asked otherwise, because there the thing being protected is
 * money.
 */

const MAX_FAILS  = 10;   // attempts allowed inside the window before a lock
const WINDOW_MIN = 15;   // the rolling window
const LOCK_MIN   = 15;   // how long a tripped bucket stays locked

/** The client's address, as Vercel forwards it. Best-effort. */
export function clientIp(req) {
  const h = (req && req.headers) || {};
  /* Vercel sets x-real-ip and rewrites x-forwarded-for itself, so neither can
     be supplied by the caller there. */
  const real = String(h['x-real-ip'] || '').trim();
  if (real) return real;
  const fwd = h['x-forwarded-for'] || '';
  return String(fwd).split(',')[0].trim() || 'unknown';
}

/* Old rows are swept now and then as the table is written, so it never needs a cron. */
function sweepSometimes() {
  if (Math.random() > 0.02) return;
  sql`
    delete from auth_throttle
    where first_at < now() - interval '1 day' and (locked_until is null or locked_until < now())
  `.catch(() => {});
}

/**
 * True when this bucket is currently locked out. Never throws — a failure to
 * read the table returns false (open).
 */
export async function isLocked(bucket) {
  try {
    const [row] = await sql`select locked_until from auth_throttle where bucket = ${bucket}`;
    return !!(row && row.locked_until && new Date(row.locked_until) > new Date());
  } catch {
    return false;
  }
}

/** True if any of the given buckets is locked. */
export async function anyLocked(buckets) {
  for (const b of buckets) {
    if (await isLocked(b)) return true;
  }
  return false;
}

/*
 * One more against a bucket, in one statement: the count, the window and the
 * lock all move together, and the row as it is after this attempt comes back.
 */
async function bump(bucket, max, windowSeconds, lockSeconds) {
  const [row] = await sql`
    insert into auth_throttle (bucket, fails, first_at, locked_until)
    values (${bucket}, 1, now(), case when 1 > ${max}::int then now() + ${lockSeconds}::int * interval '1 second' end)
    on conflict (bucket) do update set
      -- a window that has fully elapsed starts fresh
      fails    = case when auth_throttle.first_at < now() - ${windowSeconds}::int * interval '1 second'
                      then 1 else auth_throttle.fails + 1 end,
      first_at = case when auth_throttle.first_at < now() - ${windowSeconds}::int * interval '1 second'
                      then now() else auth_throttle.first_at end,
      locked_until = case
        when (case when auth_throttle.first_at < now() - ${windowSeconds}::int * interval '1 second'
                   then 1 else auth_throttle.fails + 1 end) > ${max}::int
          then greatest(coalesce(auth_throttle.locked_until, now()), now() + ${lockSeconds}::int * interval '1 second')
        else auth_throttle.locked_until end
    returning fails, locked_until
  `;
  sweepSometimes();
  return row || null;
}

/**
 * Counts this attempt against `bucket` before anything is checked, and says
 * whether it is over the line. Never throws (fails open).
 */
export async function hitLocked(bucket) {
  try {
    const row = await bump(bucket, MAX_FAILS, WINDOW_MIN * 60, LOCK_MIN * 60);
    return !!(row && row.locked_until && new Date(row.locked_until) > new Date());
  } catch {
    return false;
  }
}

/** Gives back one attempt counted by hitLocked, for an attempt that succeeded. Never throws. */
export async function refund(bucket) {
  try {
    await sql`update auth_throttle set fails = greatest(fails - 1, 0) where bucket = ${bucket}`;
  } catch {
    /* nothing to do */
  }
}

/**
 * Record one failure against a bucket and lock it if it has now failed too
 * many times inside the window. Never throws.
 */
export async function recordFailure(bucket) {
  try {
    await bump(bucket, MAX_FAILS - 1, WINDOW_MIN * 60, LOCK_MIN * 60);
  } catch {
    /* fail open — a brake that cannot record is simply off */
  }
}

/** Wipes these buckets (a username's record after its own correct password). Never throws. */
export async function clearThrottle(buckets) {
  try {
    await sql`delete from auth_throttle where bucket = any(${buckets})`;
  } catch {
    /* nothing to do */
  }
}

/**
 * A plain rate limit: at most `limit` calls per `windowSeconds` for `key`.
 *
 *   if (!(await rateLimit(`widget-ip:${clientIp(req)}`, 30, 60))) return res.status(429)…
 *
 * Returns true when this call may go ahead. Counts atomically, so parallel
 * calls cannot slip past together. On a database error it answers false
 * (closed) unless `{ failOpen: true }`. Keys share the table with the login
 * brake; prefix them with what they protect.
 */
export async function rateLimit(key, limit, windowSeconds, { failOpen = false } = {}) {
  try {
    const row = await bump(`rl:${key}`, Math.max(1, Number(limit) || 1), Math.max(1, Number(windowSeconds) || 60), Math.max(1, Number(windowSeconds) || 60));
    return !(row && row.locked_until && new Date(row.locked_until) > new Date());
  } catch (err) {
    console.error('[throttle] rate limit could not be checked:', err.message);
    return !!failOpen;
  }
}

/** The message a locked-out caller sees — no detail that helps a guesser. */
export const LOCKED_MESSAGE = 'Too many attempts. Wait a few minutes and try again.';
