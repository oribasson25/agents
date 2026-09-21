import { sql } from './_db.js';

/**
 * A soft brake on password guessing.
 *
 * Every rule here bends toward not locking out a real person:
 *  - it fails OPEN — any database error means the request proceeds, because a
 *    login that cannot check the brake is better than a login that cannot
 *    happen;
 *  - the window is short (WINDOW_MIN) and the lock is short (LOCK_MIN);
 *  - a correct password clears the record immediately (see clearThrottle);
 *  - the threshold is generous, so ordinary fumbling never trips it.
 *
 * It exists to make ten-thousand-guess runs expensive, not to punish a typo.
 */

const MAX_FAILS  = 10;   // failures allowed inside the window before a lock
const WINDOW_MIN = 15;   // the rolling window
const LOCK_MIN   = 15;   // how long a tripped bucket stays locked

/** The client's address, as Vercel forwards it. Best-effort. */
export function clientIp(req) {
  const fwd = (req && req.headers && req.headers['x-forwarded-for']) || '';
  return String(fwd).split(',')[0].trim() || 'unknown';
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

/**
 * Record one failure against a bucket and lock it if it has now failed too
 * many times inside the window. Never throws.
 */
export async function recordFailure(bucket) {
  try {
    await sql`
      insert into auth_throttle (bucket, fails, first_at)
      values (${bucket}, 1, now())
      on conflict (bucket) do update set
        -- a window that has fully elapsed starts fresh
        fails    = case when auth_throttle.first_at < now() - (${WINDOW_MIN} || ' minutes')::interval
                        then 1 else auth_throttle.fails + 1 end,
        first_at = case when auth_throttle.first_at < now() - (${WINDOW_MIN} || ' minutes')::interval
                        then now() else auth_throttle.first_at end
    `;
    await sql`
      update auth_throttle
        set locked_until = now() + (${LOCK_MIN} || ' minutes')::interval
      where bucket = ${bucket} and fails >= ${MAX_FAILS}
    `;
  } catch {
    /* fail open — a brake that cannot record is simply off */
  }
}

/** A correct password wipes the slate for these buckets. Never throws. */
export async function clearThrottle(buckets) {
  try {
    await sql`delete from auth_throttle where bucket = any(${buckets})`;
  } catch {
    /* nothing to do */
  }
}

/** The message a locked-out caller sees — no detail that helps a guesser. */
export const LOCKED_MESSAGE = 'Too many attempts. Wait a few minutes and try again.';
