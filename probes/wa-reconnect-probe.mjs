/**
 * A linked WhatsApp number comes back by itself.
 *
 * A number's connection is held by a worker that is started over HTTP. In
 * production the cron's own address does not reach a worker (the deployment
 * URL is behind Deployment Protection, the production URL did not resolve),
 * and the address meant to fill in (wa_numbers.worker_host) was never
 * migrated. So a number whose worker went away stayed down until someone
 * opened its page, whose request came in on an address that works.
 *
 * Here the cron, the worker and the session run for real against an
 * in-memory wa_numbers; fetch plays Vercel's network with those three kinds
 * of address; the WhatsApp socket is a stand-in (wa-stubs.mjs). It holds to:
 *
 * - a number that loses its worker (a crash, a socket closed for good, a
 *   session cut off at maxDuration) is back on the next cron tick after its
 *   lease, with nobody signed in;
 * - a session that reaches its deadline hands over to the next;
 * - never two connections for one number;
 * - an unlinked or disabled number is never started;
 * - the connection itself retries a reconnect that failed.
 */
import { register } from 'node:module';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
let failed = 0;
const say = console.log;
const ok = (c, label, d = '') => { if (c) say(`✓ ${label}`); else { say(`✗ ${label}${d ? ' — ' + d : ''}`); failed++; } };

/* What the platform logs ("[wa …] session ended", failed kicks) is kept, and shown only if a check fails. */
const logs = [];
for (const level of ['log', 'warn', 'error']) {
  const original = console[level];
  console[level] = (...args) => (String(args[0]).startsWith('[wa') ? logs.push(args.join(' ')) : original(...args));
}

/* ── Vercel, as production has it ────────────────────────────────────────── */

const PUBLIC = 'www.8legs.example';            // the address people use; reaches production from inside Vercel
const OWN = 'agents-x1y2z3-probe.vercel.app';  // this deployment's own URL, behind Deployment Protection
process.env.CRON_SECRET = 'probe-secret';
process.env.VERCEL_ENV = 'production';
process.env.VERCEL_URL = OWN;
process.env.VERCEL_PROJECT_PRODUCTION_URL = 'unresolved.example'; // a domain whose DNS was never set up
delete process.env.APP_URL;
process.env.WA_LOG_LEVEL = 'silent';
process.env.BAILEYS_LOG_LEVEL = 'silent';

/* A clock the probe can move forward: leases and session deadlines both read Date.now(). */
let warp = 0;
const realNow = Date.now;
Date.now = () => realNow() + warp;

/* ── an in-memory wa_numbers / wa_auth ───────────────────────────────────── */

const PHONE = '972500000001';
const db = { numbers: new Map(), auth: new Map() };
let failAuthReads = 0;

function addNumber(id, { enabled = true, linked = true, host = null } = {}) {
  db.numbers.set(id, { id, enabled, phone: linked ? PHONE : null, state: host ? { host } : {}, qr_wanted_until: null, lease_token: null, lease_until: null, command: null });
  if (linked) db.auth.set(id, JSON.stringify({ me: { id: `${PHONE}:7@s.whatsapp.net` } }));
}
const leaseFree = (n) => n.lease_until == null || n.lease_until < Date.now();
const ttl = (interval) => parseInt(interval, 10); // "120000 milliseconds"
const STATE_SET = "update wa_numbers set state = jsonb_strip_nulls(jsonb_build_object('host', state->'host')) || ?::jsonb,";

globalThis.__db = (text, p) => {
  const t = text.replace(/\s+/g, ' ').trim();
  const row = (id) => db.numbers.get(id);

  if (t === 'select * from wa_numbers where id = ?') {
    const n = row(p[0]);
    return n ? [{ ...n, lease_until: n.lease_until && new Date(n.lease_until) }] : [];
  }
  if (t.startsWith(STATE_SET)) {
    const n = row(p[p.length - 1]);
    // jsonb_strip_nulls(jsonb_build_object('host', state->'host')) || payload
    n.state = { ...(n.state.host != null && { host: n.state.host }), ...JSON.parse(p[0]) };
    if (t.includes('phone = ?')) n.phone = p[1];
    else if (t.includes('phone = null')) n.phone = null;
    return [];
  }
  if (t === 'update wa_numbers set command = ?, updated_at = now() where id = ?') { row(p[1]).command = p[0]; return []; }
  if (t.startsWith('update wa_numbers n set command = null')) {
    const n = row(p[0]);
    if (!n?.command) return [];
    const command = n.command;
    n.command = null;
    return [{ command }];
  }
  if (t === 'update wa_numbers set lease_token = ?, lease_until = now() + ?::interval where id = ? and (lease_until is null or lease_until < now()) returning id') {
    const n = row(p[2]);
    if (!n || !leaseFree(n)) return [];
    n.lease_token = p[0];
    n.lease_until = Date.now() + ttl(p[1]);
    return [{ id: n.id }];
  }
  if (t === 'update wa_numbers set lease_until = now() + ?::interval where id = ? and lease_token = ? returning id') {
    const n = row(p[1]);
    if (!n || n.lease_token !== p[2]) return [];
    n.lease_until = Date.now() + ttl(p[0]);
    return [{ id: n.id }];
  }
  if (t === 'update wa_numbers set lease_token = null, lease_until = null where id = ? and lease_token = ?') {
    const n = row(p[0]);
    if (n && n.lease_token === p[1]) { n.lease_token = null; n.lease_until = null; }
    return [];
  }
  if (t === 'select (lease_until is not null and lease_until > now()) as held from wa_numbers where id = ?') {
    const n = row(p[0]);
    return n ? [{ held: !leaseFree(n) }] : [];
  }
  if (t === "select state->>'host' as host from wa_numbers where id = ?") {
    const n = row(p[0]);
    return n ? [{ host: n.state.host ?? null }] : [];
  }
  if (t === 'select id from wa_numbers where enabled and (phone is not null or qr_wanted_until > now()) and (lease_until is null or lease_until < now())') {
    return [...db.numbers.values()]
      .filter((n) => n.enabled && (n.phone != null || (n.qr_wanted_until && n.qr_wanted_until > Date.now())) && leaseFree(n))
      .map((n) => ({ id: n.id }));
  }
  if (t.startsWith('delete from wa_seen') || t.startsWith('delete from wa_group_messages') || t.startsWith('delete from wa_group_events')) return [];

  if (t === 'select v from wa_auth where number_id = ? and k = ?') {
    if (failAuthReads > 0) { failAuthReads--; return Promise.reject(new Error('probe: Connection terminated unexpectedly')); }
    const v = db.auth.get(p[0]);
    return v ? [{ v }] : [];
  }
  if (t.startsWith('insert into wa_auth (number_id, k, v) values')) { if (p[1] === 'creds') db.auth.set(p[0], p[2]); return []; }
  if (t === 'delete from wa_auth where number_id = ?') { db.auth.delete(p[0]); return []; }

  return Promise.reject(new Error('unrouted: ' + t.slice(0, 140)));
};

const probe = (globalThis.__wa ||= {});
probe.isLinked = (id) => !!db.auth.get(id);
probe.unlink = (id) => db.auth.delete(id);

register('./wa-loader.mjs', import.meta.url);

const { kickWorker, publicHost, LEASE_TTL_MS } = await import(`${ROOT}/api/_waControl.js`);
const { default: worker } = await import(`${ROOT}/api/wa/worker.mjs`);
const { default: cron } = await import(`${ROOT}/api/wa/cron.js`);
const { WhatsApp } = await import(`${ROOT}/api/_waConnection.mjs`);

/* fetch, as a function inside Vercel sees the network */
const fetched = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  fetched.push(u.host);
  if (u.host === OWN) {
    return new Response(null, { status: 302, headers: { location: `https://vercel.com/login?next=${encodeURIComponent(u.pathname)}` } });
  }
  if (u.host !== PUBLIC) {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${u.host}`), { code: 'ENOTFOUND' }) });
  }
  if (u.pathname !== '/api/wa/worker') return new Response('not found', { status: 404 });
  const res = mockRes();
  worker({ method: opts.method || 'GET', headers: { host: u.host, authorization: opts.headers?.authorization }, query: Object.fromEntries(u.searchParams) }, res);
  return new Response(JSON.stringify(res.payload ?? {}), { status: res.statusCode, headers: { 'content-type': 'application/json' } });
};

function mockRes() {
  return { statusCode: 200, payload: undefined,
    status(c) { this.statusCode = c; return this; }, json(v) { this.payload = v; return this; }, end() { return this; } };
}
async function runCron() {
  fetched.length = 0;
  const res = mockRes();
  await cron({ method: 'GET', headers: { host: OWN, authorization: `Bearer ${process.env.CRON_SECRET}` } }, res);
  return res.payload.kicked;
}
async function waitFor(cond, ms = 4000) {
  const until = realNow() + ms;
  while (!cond() && realNow() < until) await new Promise((r) => setTimeout(r, 25));
  return cond();
}
const live = (id) => probe.live.get(id) || 0;
const state = (id) => db.numbers.get(id).state;
const held = (id) => !leaseFree(db.numbers.get(id));
const current = (id) => probe.connections.filter((c) => c.numberId === id && !c.stopped).at(-1);
const gone = (id) => waitFor(() => live(id) === 0 && !current(id));

/* ── 1. the connection retries a reconnect that failed ───────────────────── */

db.auth.set('wan_sock', JSON.stringify({ me: { id: `${PHONE}:7@s.whatsapp.net` } })); // keys only: no worker runs it
const conn = new WhatsApp({ numberId: 'wan_sock' });
await conn.start();
probe.sockets.at(-1).ev.emit('connection.update', { connection: 'open' });
ok(conn.state.status === 'open', 'the connection opens');

failAuthReads = 1; // the first reconnect cannot load the keys
probe.sockets.at(-1).ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: Object.assign(new Error('Connection Closed'), { output: { statusCode: 428 } }) } });
ok(conn.state.status === 'connecting', 'a socket WhatsApp closed shows as reconnecting');
await waitFor(() => probe.sockets.length === 2, 10_000);
ok(probe.sockets.length === 2 && failAuthReads === 0, 'a reconnect that failed is tried again until a socket opens', `${probe.sockets.length} sockets`);
probe.sockets.at(-1).ev.emit('connection.update', { connection: 'open' });
ok(conn.state.status === 'open', 'and the number is back');

probe.sockets.at(-1).ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
await waitFor(() => conn.fatal === 'logout');
ok(conn.fatal === 'logout' && conn.state.status === 'logged_out' && !db.auth.has('wan_sock'),
  'a device the phone unlinked ends the session and forgets its keys instead of reconnecting');
await conn.stop();

/* ── 2. the outage: the cron's own addresses reach no worker ─────────────── */

addNumber('wan_a'); // linked and enabled, with no address remembered
let kicked = await runCron();
ok(kicked.length === 1 && kicked[0].ok === false && live('wan_a') === 0,
  'with no address remembered, nothing the cron has reaches a worker', JSON.stringify(kicked));
ok(!fetched.includes('vercel.com'), "the secret never follows Deployment Protection's redirect to Vercel's login");
ok(fetched.at(-1) === OWN, "the deployment's own URL is tried last", fetched.join(' → '));

/* ── 3. the number's page starts it, and the worker says where it was reached ─ */

ok(await kickWorker('wan_a', { via: PUBLIC }), "opening the number's page starts a worker through the address in use");
await waitFor(() => state('wan_a').status === 'open');
ok(live('wan_a') === 1 && state('wan_a').host === PUBLIC, 'the worker publishes the address it was reached on', JSON.stringify(state('wan_a')));

/* ── 4. a held number is left alone ──────────────────────────────────────── */

kicked = await runCron();
ok(kicked.length === 0 && live('wan_a') === 1, 'while a worker holds the lease, the cron starts no second one');

/* ── 5. the worker crashes ───────────────────────────────────────────────── */

current('wan_a').crash = true;
await gone('wan_a');
await waitFor(() => !held('wan_a'));
ok(live('wan_a') === 0 && !held('wan_a') && state('wan_a').status === 'open',
  'after a crash nothing holds the number, though its last state still reads "open"');
kicked = await runCron();
await waitFor(() => live('wan_a') === 1);
ok(kicked[0]?.ok === true && live('wan_a') === 1, 'the next cron tick brings it back, with nobody signed in', JSON.stringify(kicked));
ok(fetched[0] === PUBLIC, 'through the address the last worker published', fetched.join(' → '));

/* ── 6. WhatsApp closes the socket for good ──────────────────────────────── */

current('wan_a').fatal = 'replaced';
await gone('wan_a');
await waitFor(() => !held('wan_a'));
kicked = await runCron();
await waitFor(() => live('wan_a') === 1);
ok(kicked[0]?.ok === true && live('wan_a') === 1, 'a session WhatsApp ended is back on the next tick');

/* ── 7. the function is cut off at maxDuration, its lease left behind ────── */

current('wan_a').fatal = 'lost-lease'; // ends without releasing its lease, as a killed function would
await gone('wan_a');
ok(held('wan_a'), "the cut-off session's lease is still running");
kicked = await runCron();
ok(kicked.length === 0 && live('wan_a') === 0, 'the cron waits for that lease to run out instead of risking a second connection');
warp += LEASE_TTL_MS + 1000;
kicked = await runCron();
await waitFor(() => live('wan_a') === 1);
ok(kicked[0]?.ok === true && live('wan_a') === 1, 'once it has, the next tick brings the number back');

/* ── 8. a session that reaches its deadline hands over ───────────────────── */

const before = probe.connections.length;
warp += 800_000;
await waitFor(() => probe.connections.length === before + 1 && live('wan_a') === 1);
ok(probe.connections.length === before + 1 && live('wan_a') === 1, 'a session that reaches its deadline hands over to the next one');

/* ── 9. unlinked from the phone: never linked again by itself ────────────── */

current('wan_a').phoneUnlinked();
await gone('wan_a');
await waitFor(() => !held('wan_a'));
ok(db.numbers.get('wan_a').phone === null, 'a device the phone unlinked shows as unlinked');
kicked = await runCron();
ok(kicked.length === 0, 'the cron does not start an unlinked number');
let made = probe.connections.length;
await kickWorker('wan_a', { via: PUBLIC });
await waitFor(() => state('wan_a').status === 'unlinked');
ok(probe.connections.length === made && state('wan_a').status === 'unlinked',
  'a worker started for it anyway ends without connecting or showing a QR');

/* ── 10. a disabled number is left alone ─────────────────────────────────── */

addNumber('wan_off', { enabled: false, host: PUBLIC });
kicked = await runCron();
ok(!kicked.some((k) => k.id === 'wan_off'), 'the cron does not start a disabled number');
made = probe.connections.length;
await kickWorker('wan_off', { via: PUBLIC });
await waitFor(() => state('wan_off').status === 'paused');
ok(probe.connections.length === made && state('wan_off').status === 'paused', 'a worker started for it anyway ends without connecting');

/* ── 11. nothing remembered yet: APP_URL ─────────────────────────────────── */

process.env.APP_URL = ' https://www.8legs.example/\n'; // as pasted into a deployment UI
addNumber('wan_new');
kicked = await runCron();
await waitFor(() => live('wan_new') === 1);
ok(kicked.find((k) => k.id === 'wan_new')?.ok === true && live('wan_new') === 1,
  'with no address remembered, the cron reaches a worker through APP_URL');

/* ── the rules across all of it ──────────────────────────────────────────── */

ok(publicHost(OWN) === null && publicHost(PUBLIC) === PUBLIC,
  "a worker reached on the deployment's own URL does not publish it (it would pin the chain to that deployment)");
const most = [...probe.maxLive].filter(([id]) => id !== 'wan_sock');
ok(most.every(([, n]) => n <= 1), 'never two connections for one number at once', JSON.stringify(most));

/* shut every session down */
for (const c of probe.connections) if (!c.stopped) c.fatal = 'replaced';
await Promise.allSettled(probe.background);

if (failed) say(logs.join('\n'));
say(failed ? `\n${failed} check(s) failed` : '\nall WhatsApp reconnect checks passed');
process.exit(failed ? 1 : 0);
