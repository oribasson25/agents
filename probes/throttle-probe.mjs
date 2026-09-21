/**
 * The login brake.
 *
 * Rules it must hold to: it locks a bucket after enough failures inside the
 * window; a correct password clears it; it never throws (a database error
 * leaves the door open, because a login that cannot check the brake beats one
 * that cannot happen); and login/register answer 429 once locked.
 */
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
let failed = 0;
const ok = (c, label, d = '') => { if (c) console.log(`✓ ${label}`); else { console.log(`✗ ${label}${d ? ' — ' + d : ''}`); failed++; } };

/* an in-memory stand-in for the auth_throttle table */
let store = new Map();
let throwNext = false;
const NOW = () => new Date();

globalThis.__db = (text, params) => {
  if (throwNext) { throwNext = false; throw new Error('db down'); }
  const q = text.replace(/\s+/g, ' ').trim();

  if (q.startsWith('select locked_until from auth_throttle')) {
    const r = store.get(params[0]);
    return r ? [{ locked_until: r.locked_until }] : [];
  }
  if (q.startsWith('insert into auth_throttle')) {
    const bucket = params[0];
    const r = store.get(bucket);
    // window is the last param interpolated? our stub joins literals with ? —
    // WINDOW_MIN is a bound param. Treat any existing row as inside-window here.
    if (!r) store.set(bucket, { fails: 1, first_at: NOW(), locked_until: null });
    else r.fails += 1;
    return [];
  }
  if (q.startsWith('update auth_throttle set locked_until')) {
    // params: [LOCK_MIN, bucket, MAX_FAILS] — lock if fails >= MAX_FAILS
    const [, bucket] = params;
    const max = params[params.length - 1];
    const r = store.get(bucket);
    if (r && r.fails >= max) r.locked_until = new Date(Date.now() + 15 * 60000);
    return [];
  }
  if (q.startsWith('delete from auth_throttle')) {
    const list = params[0] || [];
    for (const b of list) store.delete(b);
    return [];
  }
  return [];
};

const { isLocked, anyLocked, recordFailure, clearThrottle, clientIp } = await import(`${ROOT}/api/_throttle.js`);

ok(clientIp({ headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } }) === '1.2.3.4', 'client ip is the first forwarded hop');
ok(clientIp({ headers: {} }) === 'unknown', 'and falls back to unknown');

const B = 'user:victim';
ok(!(await isLocked(B)), 'a fresh bucket is open');

for (let i = 0; i < 9; i++) await recordFailure(B);
ok(!(await isLocked(B)), 'nine failures do not lock — ordinary fumbling is fine');
await recordFailure(B);
ok(await isLocked(B), 'the tenth failure locks it');
ok(await anyLocked(['ip:x', B]), 'anyLocked catches a locked member');

await clearThrottle([B]);
ok(!(await isLocked(B)), 'a correct password clears the lock');

/* fails open: a database error must never block a login */
throwNext = true;
ok((await isLocked(B)) === false, 'isLocked fails open on a db error');
throwNext = true;
let threw = false;
try { await recordFailure(B); } catch { threw = true; }
ok(!threw, 'recordFailure swallows a db error');

/* the handlers wire it in */
import fs from 'fs';
const login = fs.readFileSync(`${ROOT}/api/auth/login.js`, 'utf8');
ok(/anyLocked\(buckets\)/.test(login) && /status\(429\)/.test(login), 'login checks the brake and answers 429');
ok(login.indexOf('recordFailure') < login.indexOf('clearThrottle'), 'login records a failure and clears on success');
ok(/clearThrottle\(buckets\)/.test(login), 'a successful login clears both buckets');
const reg = fs.readFileSync(`${ROOT}/api/auth/register.js`, 'utf8');
ok(/isLocked\(regBucket\)/.test(reg) && /status\(429\)/.test(reg), 'register throttles per ip');
ok(/reg-ip:/.test(reg), 'register uses a bucket distinct from login, so it cannot lock sign-in');

console.log(failed ? `\n${failed} failed` : '\nall good');
process.exit(failed ? 1 : 0);
