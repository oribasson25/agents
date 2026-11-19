/**
 * Automations, attacked: every check here tries something that used to work
 * and must not any more, or a bug that used to bite.
 *
 *   node --import ./probes/stub-db.mjs probes/automation-security-probe.mjs
 *
 * No database and no network: queries go to globalThis.__db, requests to a
 * fake transport.
 */
import assert from 'node:assert/strict';

let passed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; }
  catch (err) { console.error(`✗ ${name}\n  ${err.stack || err.message}`); process.exitCode = 1; }
};

/* Every query is answered by the current handler; each test sets its own. */
let onQuery = () => [];
const queries = [];
globalThis.__db = (text, params) => { queries.push({ text, params }); return onQuery(text, params); };

const { nextCron, nextRunAfter, parseCron } = await import('../api/_schedule.js');
const { addresses, header, sendMail, pollMailbox } = await import('../api/_mail.js');
const { sendGmail } = await import('../api/_gmail.js');
const C = await import('../api/_connections.js');
const { advance, freshState, changesTheWorld } = await import('../api/_automationEngine.js');
const { checkAutomation } = await import('../api/_automationSpec.js');
const A = await import('../api/_automations.js');
const T = await import('../api/_automationTriggers.js');
const { hookHeaders, hookBody } = await import('../api/hook/[key].js');

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const step = (id, type, config = {}, more = {}) => ({ id, type, name: '', config, ...more });
const edge = (from, to, port = 'out') => ({ from, to, port });
const auto = (steps, edges) => ({ name: 'T', trigger: { type: 'manual', config: {} }, steps, edges });

async function run(def, { state = freshState(), ctx = {} } = {}) {
  const { automation, errors } = checkAutomation(def);
  assert.deepEqual(errors, [], errors.join('; '));
  const log = [];
  const result = await advance({ definition: automation, input: {}, state, ctx: {
    secrets: {}, baseUrl: 'https://platform.test', allowPrivate: true,
    fetch: async () => { throw new Error('no network in this probe'); },
    recordStep: async (r) => { log.push(r); }, saveState: async () => {},
    now: () => 1_000_000, sleep: async () => {}, ...ctx } });
  return { result, log, state };
}

/* ─────────────────── schedules (O5) ─────────────────── */

await check('cron: 7 is Sunday inside a range too, and 0-7 is every day', () => {
  assert.deepEqual([...parseCron('0 9 * * 0-7').weekdays].sort(), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...parseCron('0 9 * * 5-7').weekdays].sort(), [0, 5, 6]);
  assert.deepEqual([...parseCron('0 9 * * 7').weekdays], [0]);
});

await check('cron: day-of-month and day-of-week both set means either', () => {
  /* "the 1st, or any Monday": from Tue 17 Nov 2026 the next is Mon 23 Nov, not 1 Dec (and not "a Monday the 1st"). */
  assert.equal(nextCron('0 9 1 * 1', new Date('2026-11-17T10:00:00Z')).toISOString(), '2026-11-23T07:00:00.000Z');
  /* one of them '*': the other alone decides, as before */
  assert.equal(nextCron('0 9 * * 1', new Date('2026-11-17T10:00:00Z')).toISOString(), '2026-11-23T07:00:00.000Z');
  assert.equal(nextCron('0 9 1 * *', new Date('2026-11-17T10:00:00Z')).toISOString(), '2026-12-01T07:00:00.000Z');
});

await check('the hour the clocks go back fires once', () => {
  /* Israel, 25 Oct 2026: 02:00 IDT becomes 01:00 IST, so 01:30 happens at 22:30Z and again at 23:30Z. */
  const first = nextCron('30 1 * * *', new Date('2026-10-24T22:00:00Z'));
  assert.equal(first.toISOString(), '2026-10-24T22:30:00.000Z');
  assert.equal(nextCron('30 1 * * *', first).toISOString(), '2026-10-25T23:30:00.000Z', 'not again at 23:30Z the same night');
});

await check('an interval counts from its slot, and a late one skips to the next slot ahead', () => {
  const cfg = { mode: 'every', every: 15, unit: 'minutes' };
  assert.equal(nextRunAfter(cfg, new Date('2026-11-16T10:00:00Z'), new Date('2026-11-16T10:00:50Z')).toISOString(), '2026-11-16T10:15:00.000Z');
  assert.equal(nextRunAfter(cfg, new Date('2026-11-16T10:00:00Z'), new Date('2026-11-16T10:47:00Z')).toISOString(), '2026-11-16T11:00:00.000Z');
  assert.equal(nextRunAfter({ mode: 'cron', cron: '0 9 * * *' }, new Date('2026-11-16T07:00:00Z'), new Date('2026-11-16T07:00:30Z')).toISOString(),
               '2026-11-17T07:00:00.000Z');
});

await check('a cron that never matches is answered quickly', () => {
  const t = Date.now();
  assert.equal(nextCron('0 0 30 2 *', new Date('2026-11-16T10:00:00Z')), null);
  assert.ok(Date.now() - t < 1500, `took ${Date.now() - t} ms`);
});

/* ─────────────────── mail headers (R4) ─────────────────── */

await check('an address with a line break is refused, not cleaned', async () => {
  assert.throws(() => addresses('x@y.com\r\nBcc: everyone@list.com'), /not an email address/);
  assert.throws(() => addresses('x@y.com\nBcc: a@b.co'), /not an email address/);
  assert.throws(() => addresses('not an address'), /not an email address/);
  assert.deepEqual(addresses('Dana <dana@example.com>; noa@example.com'), ['dana@example.com', 'noa@example.com']);
  const box = { id: 'c1', kind: 'gmail', name: 'S', account: 's@example.com',
                data: { sealed: C.seal({ access_token: 't', refresh_token: 'r', expires_at: Date.now() + 3600e3 }) } };
  let sent = false;
  await assert.rejects(sendMail(box, { to: 'a@b.co\r\nBcc: evil@x.co', subject: 's', body: 'b' },
    { fetchImpl: async () => { sent = true; return jsonResponse({}); } }), /not an email address/);
  assert.equal(sent, false, 'nothing went out');
  await assert.rejects(sendGmail({ agentId: 'a1', to: 'a@b.co\r\nBcc: evil@x.co', subject: 's', body: 'b' }),
    (err) => err.code === 'BAD_ADDRESS');
});

await check('a subject cannot end its header', () => {
  const h = header('Hi\r\nBcc: evil@x.co');
  assert.ok(!/[\r\n]/.test(h));
  assert.ok(h.startsWith('=?UTF-8?B?'));
  assert.equal(header('Plain'), 'Plain');
});

/* ─────────────────── new-mail trigger (B4) ─────────────────── */

const mailbox = (kind) => ({ id: 'c1', kind, name: 'S', account: 's@example.com',
                             data: { sealed: C.seal({ access_token: 'tok', refresh_token: 'r', expires_at: Date.now() + 3600e3 }) } });

await check('Microsoft: mail that does not match still moves the trigger on', async () => {
  const since = '2026-11-16T10:00:00.000Z';
  const value = Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, subject: i === 11 ? 'Invoice 7' : 'Hello',
    from: { emailAddress: { address: 'a@x.co' } }, receivedDateTime: new Date(Date.parse(since) + (i + 1) * 60e3).toISOString(), body: { content: 'x' } }));
  const { messages, cursor } = await pollMailbox(mailbox('microsoft'), { since, query: 'invoice', max: 25 },
    { fetchImpl: async () => jsonResponse({ value }) });
  assert.deepEqual(messages.map(m => m.id), ['m11']);
  assert.equal(cursor, value[11].receivedDateTime);
  const none = await pollMailbox(mailbox('microsoft'), { since, query: 'nothing-like-this', max: 25 },
    { fetchImpl: async () => jsonResponse({ value }) });
  assert.equal(none.messages.length, 0);
  assert.equal(none.cursor, value[11].receivedDateTime, 'ten unrelated mails no longer hold it in place');
});

await check('Gmail: a burst bigger than one look is taken oldest first, none skipped', async () => {
  const since = new Date(1_800_000_000_000).toISOString();
  const all = Array.from({ length: 40 }, (_, i) => ({ id: `g${i}`, at: 1_800_000_000_000 + (i + 1) * 1000 }));
  const api = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/messages')) {
      const start = Number(u.searchParams.get('pageToken') || 0);
      const page = [...all].reverse().slice(start, start + 15);   /* newest first, 15 a page */
      return jsonResponse({ messages: page.map(m => ({ id: m.id })), ...(start + 15 < all.length ? { nextPageToken: String(start + 15) } : {}) });
    }
    const m = all.find(x => u.pathname.endsWith(`/messages/${x.id}`));
    return jsonResponse({ id: m.id, internalDate: String(m.at), payload: { headers: [{ name: 'From', value: 'a@x.co' }] } });
  };
  const first = await pollMailbox(mailbox('gmail'), { since, query: '', max: 25 }, { fetchImpl: api });
  assert.deepEqual(first.messages.map(m => m.id), all.slice(0, 25).map(m => m.id), 'the 25 oldest, in order');
  assert.equal(first.cursor, first.messages[24].date, 'the cursor stops at the last one taken');
});

/* ─────────────────── OAuth state (O9 / M7) ─────────────────── */

await check('a sign-in state is for one flow, one browser, ten minutes', () => {
  const nonce = C.startNonce();
  assert.match(nonce.cookie, /HttpOnly; Secure; SameSite=Lax; Path=\/api; Max-Age=600/);
  const state = C.signState({ orgId: 'o1', userId: 'u1', provider: 'gmail', ...nonce.state });
  const data = C.readState(state);
  assert.equal(data.orgId, 'o1');
  assert.equal(C.readState(state, 'gmail-agent'), null, 'a connection state is not a chatbot-Gmail state');
  const value = nonce.cookie.split(';')[0];
  assert.equal(C.nonceMatches({ headers: { cookie: `a=b; ${value}` } }, data), true);
  assert.equal(C.nonceMatches({ headers: { cookie: '' } }, data), false, 'another browser has no cookie');
  const other = C.startNonce().cookie.split(';')[0].split('=')[1];
  assert.equal(C.nonceMatches({ headers: { cookie: `oauth_${data.nid}=${other}` } }, data), false, 'someone else\'s nonce');
  assert.match(C.clearNonce(data), /Max-Age=0/);
  const realNow = Date.now;
  Date.now = () => realNow() + 11 * 60 * 1000;
  try { assert.equal(C.readState(state), null, 'expired'); } finally { Date.now = realNow; }
});

await check('sealed secrets: round trip, and a cut or changed tag is refused', () => {
  const sealed = C.encryptSecret({ creds: { noiseKey: 'k' } });
  assert.ok(C.isSealed(sealed));
  assert.deepEqual(C.decryptSecret(sealed), { creds: { noiseKey: 'k' } });
  const [v, iv, tag, body] = sealed.split('.');
  const shortTag = Buffer.from(tag, 'base64url').subarray(0, 4).toString('base64url');
  assert.throws(() => C.decryptSecret([v, iv, shortTag, body].join('.')), (e) => e.code === 'UNREADABLE');
  assert.equal(C.isSealed('{"plain":true}'), false);
});

/* ─────────────────── connections (M4) ─────────────────── */

await check('an unshared connection is only for whoever added it and the admins', async () => {
  const conn = { id: 'c1', org_id: 'o1', kind: 'gmail', name: 'Boss inbox', shared: false, created_by: 'admin1', data: {} };
  const users = { m1: { is_admin: false, org_id: 'o1', org_role: 'member' }, admin2: { is_admin: false, org_id: 'o1', org_role: 'admin' } };
  onQuery = (text, params) => {
    if (text.includes('from connections')) return [conn];
    if (text.includes('from users')) return users[params[0]] ? [users[params[0]]] : [];
    return [];
  };
  await assert.rejects(C.useConnection({ orgId: 'o1', name: 'Boss inbox', kinds: ['gmail'], userId: 'm1' }), (e) => e.code === 'NOT_SHARED');
  await assert.rejects(C.useConnection({ orgId: 'o1', name: 'Boss inbox', kinds: ['gmail'], userId: null }), (e) => e.code === 'NOT_SHARED');
  assert.equal((await C.useConnection({ orgId: 'o1', name: 'Boss inbox', kinds: ['gmail'], userId: 'admin1' })).id, 'c1');
  assert.equal((await C.useConnection({ orgId: 'o1', name: 'Boss inbox', kinds: ['gmail'], userId: 'admin2' })).id, 'c1');
  conn.shared = true;
  assert.equal((await C.useConnection({ orgId: 'o1', name: 'Boss inbox', kinds: ['gmail'], userId: 'm1' })).id, 'c1');
  onQuery = () => [];
});

await check('a step uses a connection as the person the run acts for', async () => {
  const { CONNECTED_RUNNERS } = await import('../api/_automationConnected.js');
  onQuery = (text, params) => {
    if (text.includes('from connections')) return [{ id: 'c1', org_id: 'o1', kind: 'whatsapp', name: 'Office', shared: false, created_by: 'admin1', data: { numberId: 'n1' } }];
    if (text.includes('from users')) return [{ is_admin: false, org_id: 'o1', org_role: 'member' }];
    return [];
  };
  await assert.rejects(CONNECTED_RUNNERS.whatsapp({ connection: 'Office', to: '972500000001', text: 'hi' },
    { orgId: 'o1', ownerId: 'admin1', actorId: 'm1', automationId: 'a1' }), /has not been shared/);
  onQuery = () => [];
});

/* ─────────────────── never twice (B6) ─────────────────── */

await check('a step cut off mid-way is not sent again when the run is picked up', async () => {
  const def = auto([step('mail', 'http', { method: 'POST', url: 'https://api.test/send' }), step('after', 'set')],
                   [edge('trigger', 'mail'), edge('mail', 'after')]);
  const state = freshState();
  state.inflight = { stepId: 'mail', at: 1 };
  let calls = 0;
  const { result, log } = await run(def, { state, ctx: { fetch: async () => { calls++; return jsonResponse({}); } } });
  assert.equal(calls, 0, 'the request was not made again');
  assert.equal(result.status, 'failed');
  assert.match(result.error, /cut off/);
  assert.equal(log[0].status, 'failed');
});

await check('a side effect is marked and saved before it starts, and cleared after', async () => {
  const def = auto([step('mail', 'http', { method: 'POST', url: 'https://api.test/send' })], [edge('trigger', 'mail')]);
  const saves = [];
  const { result } = await run(def, { ctx: {
    fetch: async () => jsonResponse({ ok: 1 }),
    saveState: async (st) => { saves.push(st.inflight ? st.inflight.stepId : null); } } });
  assert.equal(result.status, 'done');
  assert.deepEqual(saves, ['mail', null]);
  assert.equal(changesTheWorld(step('g', 'http', { method: 'GET' }), def), false, 'a GET is safe to repeat');
});

await check('Stop is obeyed: a save that touches no row ends the run', async () => {
  const def = auto([step('a', 'set'), step('b', 'http', { method: 'POST', url: 'https://api.test/x' })],
                   [edge('trigger', 'a'), edge('a', 'b')]);
  let calls = 0;
  const { result } = await run(def, { ctx: { fetch: async () => { calls++; return jsonResponse({}); }, saveState: async () => false } });
  assert.equal(result.status, 'stopped');
  assert.equal(calls, 0, 'nothing was sent after the stop');
});

await check('a loop is not retried (it would send its items again), and retries stop at the deadline', async () => {
  let hits = 0;
  const def = auto([step('l', 'loop', { items: '[1,2,3]' }, { retries: 3 }),
                    step('call', 'http', { method: 'POST', url: 'https://api.test/x' })],
                   [edge('trigger', 'l'), edge('l', 'call', 'each')]);
  const { result } = await run(def, { ctx: { fetch: async () => { hits++; return hits === 3 ? jsonResponse({}, 500) : jsonResponse({}); } } });
  assert.equal(result.status, 'failed');
  assert.equal(hits, 3, 'items 1 and 2 were not sent a second time');

  let tries = 0;
  const late = auto([step('c', 'http', { url: 'https://api.test/x' }, { retries: 3 })], [edge('trigger', 'c')]);
  await run(late, { ctx: { hardDeadline: 1_000_500, fetch: async () => { tries++; return jsonResponse({}, 503); } } });
  assert.equal(tries, 1, 'no retry that would end past the deadline');
});

/* ─────────────────── HTTP step (R5 / M5) ─────────────────── */

await check('an HTTP step: inside addresses refused, credentials not carried to another site, chain counted', async () => {
  await assert.rejects(run(auto([step('c', 'http', { url: 'http://[::ffff:169.254.169.254]/latest' })], [edge('trigger', 'c')]),
    { ctx: { allowPrivate: false, fetch: async () => { throw new Error('must not be reached'); } } })
    .then(({ result }) => { if (result.status === 'failed' && /inside the platform/.test(result.error)) throw new Error('refused'); }), /refused/);
  const seen = [];
  const { result } = await run(auto([step('c', 'http', { url: 'https://a.test/1', auth: { type: 'bearer', token: 'secret-token' } })], [edge('trigger', 'c')]), {
    ctx: { depth: 2, fetch: async (url, init) => {
      seen.push({ url, h: new Headers(init.headers) });
      return seen.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://evil.test/2' } }) : jsonResponse({ ok: 1 });
    } } });
  assert.equal(result.status, 'done');
  assert.equal(seen[0].h.get('authorization'), 'Bearer secret-token');
  assert.equal(seen[1].h.get('authorization'), null, 'dropped on the way to another site');
  assert.equal(seen[0].h.get('x-8legs-chain'), '3');
});

await check('an answer too large is refused while it is read', async () => {
  const big = 'x'.repeat(1024 * 1024 + 10);
  const { result } = await run(auto([step('c', 'http', { url: 'https://a.test/big' })], [edge('trigger', 'c')]),
    { ctx: { fetch: async () => new Response(big, { headers: { 'content-type': 'text/plain' } }) } });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /larger than 1 MB/);
});

/* ─────────────────── chains (B3 / M6) ─────────────────── */

const publishedRow = { id: 'auto1', org_id: 'o1', data: auto([], []), published: auto([], []) };

await check('a run started inside another is one deeper; past the limit it is refused', async () => {
  const inserts = [];
  onQuery = (text, params) => { if (text.includes('insert into automation_runs')) inserts.push(params); return []; };
  await A.runScope.run({ runId: 'parent', depth: 1, orgId: 'o1' }, () => A.startRun({ row: publishedRow }));
  const params = inserts[0];
  assert.ok(params.includes(2) && params.includes('parent'), 'depth 2, parent recorded');
  await assert.rejects(A.runScope.run({ runId: 'p', depth: 4, orgId: 'o1' }, () => A.startRun({ row: publishedRow })), (e) => e.code === 'TOO_DEEP');
  await assert.rejects(A.startRun({ row: publishedRow, depth: 5 }), (e) => e.code === 'TOO_DEEP', 'a webhook\'s chain header counts');
  onQuery = () => [];
});

await check('two automations feeding each other through a table stop', async () => {
  const watching = [{ ...publishedRow, id: 'B', enabled: true }];
  onQuery = (text) => (text.includes('from automations a') ? watching : []);
  const started = await A.runScope.run({ runId: 'deep', depth: 4, orgId: 'o1' },
    () => T.onRowAdded({ table: { id: 't1', org_id: 'o1', name: 'T' }, row: { id: 'r1', data: {} }, writtenBy: 'automation:A' }));
  assert.deepEqual(started, [], 'refused at the limit, and the trigger did not throw');
  onQuery = () => [];
});

await check('the queue takes organizations in turn', async () => {
  queries.length = 0;
  onQuery = () => [{ id: 'r1' }];
  await A.dueRuns(20);
  assert.match(queries[0].text, /partition by org_id/);
  onQuery = () => [];
});

/* ─────────────────── Stop (B2) ─────────────────── */

await check('a stopped run is not brought back by the worker that held it', async () => {
  const runRow = { id: 'run1', automation_id: 'auto1', mode: 'live', status: 'running', reclaims: 0, depth: 0,
                   definition: checkAutomation(auto([step('a', 'set'), step('b', 'set')], [edge('trigger', 'a'), edge('a', 'b')])).automation,
                   input: {}, state: freshState() };
  const finalWrites = [];
  onQuery = (text) => {
    if (text.includes("set status = 'running'")) return [runRow];
    if (text.includes('from automations where id')) return [{ id: 'auto1', org_id: 'o1', user_id: 'u1', secrets: {}, samples: {} }];
    if (text.includes('update automation_runs set state')) return [];              /* Stop was pressed: no row is ours */
    if (text.includes('set status =') && text.includes('claim_id')) { finalWrites.push(text); return []; }
    if (text.includes('select * from automation_runs')) return [{ ...runRow, status: 'stopped' }];
    return [];
  };
  const after = await A.workRun('run1');
  assert.equal(after.status, 'stopped');
  assert.equal(finalWrites.length, 0, 'no final write over the stop');
  onQuery = () => [];
});

await check('every write after the claim is conditional on holding it', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../api/_automations.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export async function workRun'), src.indexOf('/** A Run automation step'));
  const writes = body.match(/update automation_runs[\s\S]*?returning/g) || [];
  assert.ok(writes.length >= 5);
  for (const w of writes.slice(1)) assert.match(w, /claim_id = \$\{claim\} and status = 'running'/);
});

/* ─────────────────── WhatsApp trigger (perf #14, M4) ─────────────────── */

await check('one look finds the run waiting on a sender', async () => {
  queries.length = 0;
  onQuery = (text) => {
    if (text.includes("state->'wait'->>'kind' = any(")) return [{ id: 'w1', kind: 'approval' }];
    if (text.includes('update automation_runs')) return [{ id: 'w1' }];
    return [];
  };
  const r = await T.onWhatsAppMessage({ numberId: 'n1', message: { senderPhone: '972500000001', text: 'כן' }, baseUrl: 'https://x.test' });
  assert.equal(r.approval, 'w1');
  assert.equal(queries.filter(q => q.text.includes('from automation_runs')).length, 1);
  onQuery = () => [];
});

await check('with triggers off, a wait is still answered but no listening automation reads the message', async () => {
  let looked = false;
  onQuery = (text) => {
    if (text.includes('from automations a')) { looked = true; return [{ id: 'x' }]; }
    return [];
  };
  const r = await T.onWhatsAppMessage({ numberId: 'n1', message: { senderPhone: '972500000002', text: 'private' }, baseUrl: 'https://x.test', triggers: false });
  assert.equal(r.consumed, false, 'Jarvis still answers');
  assert.equal(looked, false);
  onQuery = () => [];
});

await check('only automations whose publisher may use the number\'s connection listen', async () => {
  let text = '';
  onQuery = (t) => { if (t.includes('from automations a')) text = t; return []; };
  await T.onWhatsAppMessage({ numberId: 'n1', message: { senderPhone: '972500000003', text: 'hi' }, baseUrl: 'https://x.test' });
  assert.match(text, /c\.shared is not false or c\.created_by/);
  onQuery = () => [];
});

/* ─────────────────── webhooks (O14) ─────────────────── */

await check('a webhook hands on the sender\'s headers, not the platform\'s or credentials', () => {
  const h = hookHeaders({ 'content-type': 'application/json', authorization: 'Bearer x', cookie: 'c=1', 'x-vercel-id': 'v',
                          'x-forwarded-for': '1.2.3.4', 'x-real-ip': '1.2.3.4', 'x-github-event': 'push', 'stripe-signature': 's',
                          'x-hook-secret': 'k', 'x-internal-secret': 'i', host: 'www.8legs.world', 'x-8legs-chain': '2' });
  assert.deepEqual(Object.keys(h).sort(), ['content-type', 'stripe-signature', 'x-github-event']);
});

await check('a webhook body is bounded, and a NUL does not break it', () => {
  assert.equal(hookBody({ a: 'x'.repeat(300 * 1024) }).ok, false);
  assert.deepEqual(hookBody({ 'k\u0000': 'a\u0000b', n: [1, '\u0000'] }).value, { k: 'ab', n: [1, ''] });
  assert.deepEqual(hookBody('a\\u0000b'), { ok: true, value: 'a\\u0000b' }, 'a backslash that only looks like an escape is kept');
});

console.log(`automation-security-probe: ${passed} checks passed${process.exitCode ? ' — with failures above' : ''}`);
