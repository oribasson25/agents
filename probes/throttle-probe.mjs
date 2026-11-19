/**
 * The brakes.
 *
 * Rules they must hold to: a bucket locks after enough attempts inside the
 * window; counting is atomic (one statement increments and decides); the
 * login brake never throws (a database error leaves the door open); the
 * general rate limit fails closed; and the login handler counts an address's
 * attempt before it looks at the password, never refuses a username outright,
 * and never wipes an address's record on success.
 */
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
let failed = 0;
const ok = (c, label, d = '') => { if (c) console.log(`✓ ${label}`); else { console.log(`✗ ${label}${d ? ' — ' + d : ''}`); failed++; } };

/* an in-memory stand-in for the auth_throttle table */
let store = new Map();
let throwNext = false;
const clock = Date.now();

globalThis.__db = (text, params) => {
  if (throwNext) { throwNext = false; throw new Error('db down'); }
  const q = text.replace(/\s+/g, ' ').trim();

  if (q.startsWith('select locked_until from auth_throttle')) {
    const r = store.get(params[0]);
    return r ? [{ locked_until: r.locked_until }] : [];
  }
  if (q.startsWith('insert into auth_throttle')) {
    /* params: bucket, max, lockSeconds, windowSeconds… — one statement does it all */
    const [bucket, max, lockSec, windowSec] = params;
    let r = store.get(bucket);
    if (!r || r.first_at < clock - windowSec * 1000) {
      r = { fails: 1, first_at: clock, locked_until: r ? r.locked_until : null };
    } else r = { ...r, fails: r.fails + 1 };
    if (r.fails > max) r.locked_until = new Date(Math.max(r.locked_until ? +r.locked_until : clock, clock + lockSec * 1000));
    store.set(bucket, r);
    return [{ fails: r.fails, locked_until: r.locked_until }];
  }
  if (q.startsWith('update auth_throttle set fails = greatest')) {
    const r = store.get(params[0]); if (r) r.fails = Math.max(r.fails - 1, 0);
    return [];
  }
  if (q.startsWith('delete from auth_throttle where bucket')) {
    for (const b of params[0] || []) store.delete(b);
    return [];
  }
  if (q.startsWith('delete from auth_throttle')) return [];
  return [];
};

const { isLocked, anyLocked, recordFailure, clearThrottle, clientIp, hitLocked, refund, rateLimit } = await import(`${ROOT}/api/_throttle.js`);

ok(clientIp({ headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } }) === '1.2.3.4', 'client ip is the first forwarded hop');
ok(clientIp({ headers: {} }) === 'unknown', 'and falls back to unknown');
ok(clientIp({ headers: { 'x-real-ip': '9.9.9.9', 'x-forwarded-for': '1.2.3.4' } }) === '9.9.9.9', 'x-real-ip (set by Vercel) wins');

const B = 'user:victim';
ok(!(await isLocked(B)), 'a fresh bucket is open');

for (let i = 0; i < 9; i++) await recordFailure(B);
ok(!(await isLocked(B)), 'nine failures do not lock — ordinary fumbling is fine');
await recordFailure(B);
ok(await isLocked(B), 'the tenth failure locks it');
ok(await anyLocked(['ip:x', B]), 'anyLocked catches a locked member');

await clearThrottle([B]);
ok(!(await isLocked(B)), 'clearing a bucket opens it');

/* fails open: a database error must never block a login */
throwNext = true;
ok((await isLocked(B)) === false, 'isLocked fails open on a db error');
throwNext = true;
let threw = false;
try { await recordFailure(B); } catch { threw = true; }
ok(!threw, 'recordFailure swallows a db error');
throwNext = true;
ok((await hitLocked('ip:z')) === false, 'hitLocked fails open on a db error');

/* the address brake counts every attempt, before the password is checked */
const IP = 'ip:1.1.1.1';
let locked = false;
for (let i = 0; i < 10; i++) locked = locked || await hitLocked(IP);
ok(!locked, 'ten attempts from one address go through');
ok(await hitLocked(IP), 'the eleventh is refused');
await refund(IP);
ok(store.get(IP).fails === 10, 'a successful attempt gives back only its own count', JSON.stringify(store.get(IP)));
{ const r = store.get(IP); r.first_at -= 16 * 60000; r.locked_until = new Date(+r.locked_until - 16 * 60000); }
ok(!(await hitLocked(IP)), 'after the window and the lock, the address is open again');

/* the general rate limit */
for (let i = 0; i < 3; i++) await rateLimit('widget:a', 3, 60);
ok(!(await rateLimit('widget:a', 3, 60)), 'a rate limit refuses the call past its limit');
ok(await rateLimit('widget:b', 3, 60), 'per key');
throwNext = true;
ok((await rateLimit('widget:c', 3, 60)) === false, 'and fails CLOSED on a db error');
throwNext = true;
ok((await rateLimit('widget:c', 3, 60, { failOpen: true })) === true, 'unless asked to fail open');

/* the handlers wire it in */
import fs from 'fs';
const login = fs.readFileSync(`${ROOT}/api/auth/login.js`, 'utf8');
ok(/hitLocked\(ipBucket\)/.test(login) && /status\(429\)/.test(login), 'login counts the address and answers 429');
ok(login.indexOf('hitLocked(ipBucket)') < login.indexOf('verifyPassword(String(password)'), 'the address is counted before the password is checked');
ok(!/anyLocked|status\(429\)[^]*userBucket[^]*status\(429\)/.test(login), 'a locked username is never refused outright');
ok(/clearThrottle\(\[userBucket\]\)/.test(login) && !/clearThrottle\(\[[^\]]*ipBucket/.test(login), 'a success clears the username, never the address');
ok(/refund\(ipBucket\)/.test(login), 'a success gives back its own attempt');
ok(/verifyAgainstNothing/.test(login), 'an unknown username costs the same scrypt as a wrong password');
const reg = fs.readFileSync(`${ROOT}/api/auth/register.js`, 'utf8');
ok(/isLocked\(regBucket\)/.test(reg) && /status\(429\)/.test(reg), 'register throttles per ip');
ok(/reg-ip:/.test(reg), 'register uses a bucket distinct from login, so it cannot lock sign-in');

console.log(failed ? `\n${failed} failed` : '\nall good');
process.exit(failed ? 1 : 0);
