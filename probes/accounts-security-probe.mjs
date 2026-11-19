/**
 * Accounts, sessions and the code runner: every way in that the 2026-11-19
 * reviews found open, tried, and expected to be refused.
 *
 *   - a session ends when its account's token_version moves (reset, change);
 *   - a temporary password opens nothing but its own replacement;
 *   - admin rights are read from the database, not from the token;
 *   - personal access tokens expire, and die with a password reset;
 *   - registration holds to the same username and password rules as the rest;
 *   - a username that strangers hammered still lets its owner in;
 *   - the Python runner takes the platform's secret and nothing else, never a
 *     constant one, and runs code with none of the platform's environment;
 *   - the file extractor needs a session, and refuses a zip bomb unopened;
 *   - /api/tool-run lets a viewer run only what is saved, an editor drafts;
 *   - an admin cannot read a Jarvis person's history by changing their phone,
 *     nor turn memory viewing on for them.
 *
 * Run: node --import ./probes/stub-db.mjs probes/accounts-security-probe.mjs
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
process.env.JWT_SECRET = 'accounts-probe-secret';
delete process.env.TOOL_RUNNER_URL;
delete process.env.TOOL_RUNNER_SECRET;
process.env.APP_URL = 'https://platform.test';

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && detail ? `\n    ${detail}` : ''}`);
  if (!ok) failed++;
};

const A = await import(`${ROOT}/api/_auth.js`);
const { hashPassword, verifyPassword, signJWT, sessionToken, internalSecret } = A;

/* ── an in-memory platform ──────────────────────────────────────────────── */
const db = {
  users: [
    { id: 'p', username: 'admin', is_admin: true, org_id: 'o0', org_role: 'admin', org_access: 'edit' },
    { id: 'a', username: 'acme-admin', org_id: 'o1', org_role: 'admin', org_access: 'edit' },
    { id: 'v', username: 'viewer', org_id: 'o1', org_role: 'member', org_access: 'view' },
    { id: 'e', username: 'editor', org_id: 'o1', org_role: 'member', org_access: 'edit' },
    { id: 'x', username: 'stranger', org_id: 'o2', org_role: 'admin', org_access: 'edit' },
    { id: 't', username: 'temporary', org_id: 'o1', org_role: 'member', org_access: 'edit', must_change_password: true },
    { id: 'r', username: 'resettable', org_id: 'o1', org_role: 'member', org_access: 'view' },
  ].map(u => ({ is_admin: false, must_change_password: false, token_version: 0, password_hash: hashPassword('password-1'), ...u })),
  agents: [{ id: 'ag1', org_id: 'o1', user_id: 'a', data: { id: 'ag1', name: 'Sales', tools: [
    { name: 'lookup', code: 'def run(**k):\n    return "saved"', packages: 'requests', envVars: [{ key: 'API_KEY', value: 'SAVED-SECRET' }, { key: 'MODE', value: 'live' }] },
  ] } }],
  tokens: [],
  revoked: [],
  throttle: new Map(),
  jarvis: {
    people: [{ id: 'jp1', number_id: 'wan1', name: 'Dana', phone: '972500000001', active: true, prompt: '', call_name: 'Dana',
               timezone: 'Asia/Jerusalem', capabilities: {}, proactive: {}, admin_can_view_memory: false }],
    deleted: [],
  },
  numbers: [{ id: 'wan1', owner_user_id: 'a', phone: '972500000099' }],
};
const userById = (id) => db.users.find(u => u.id === id);
let lastUpdate = null;

globalThis.__db = (text, p) => {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.startsWith('select u.id, u.username, u.is_admin, u.org_id, u.org_role')) {
    const u = userById(p[0]);
    return u ? [{ ...u, org_name: u.org_id }] : [];
  }
  if (t.startsWith('select id, org_id, user_id from agents where id')) return db.agents.filter(a => a.id === p[0]);
  if (t.startsWith('select level from access_grants') || t.startsWith('select item_id, level from access_grants')) return [];
  if (t.startsWith('select data from agents where id')) return db.agents.filter(a => a.id === p[0]);

  /* login / register */
  if (t.startsWith('select count(*)::int as count from users')) return [{ count: db.users.length }];
  if (t.startsWith('select * from users where username')) return db.users.filter(u => u.username === p[0]);
  if (t.startsWith('update users set last_login_at')) return [];
  if (t.startsWith('select locked_until from auth_throttle')) {
    const r = db.throttle.get(p[0]); return r ? [{ locked_until: r.locked_until }] : [];
  }
  if (t.startsWith('insert into auth_throttle')) {
    const [bucket, max, lockSec] = p;
    const r = db.throttle.get(bucket) || { fails: 0, locked_until: null };
    r.fails += 1;
    if (r.fails > max) r.locked_until = new Date(Date.now() + lockSec * 1000);
    db.throttle.set(bucket, r);
    return [{ fails: r.fails, locked_until: r.locked_until }];
  }
  if (t.startsWith('update auth_throttle set fails = greatest')) { const r = db.throttle.get(p[0]); if (r) r.fails = Math.max(0, r.fails - 1); return []; }
  if (t.startsWith('delete from auth_throttle where bucket')) { for (const b of p[0]) db.throttle.delete(b); return []; }
  if (t.startsWith('delete from auth_throttle')) return [];

  /* passwords, tokens */
  if (t.startsWith('update users set password_hash')) {
    const u = userById(p[1]);
    Object.assign(u, { password_hash: p[0], must_change_password: t.includes('must_change_password = true'),
                       token_version: u.token_version + (t.includes('token_version = token_version + 1') ? 1 : 0) });
    return [];
  }
  if (t.startsWith('update api_tokens set revoked_at = now() where user_id')) { db.revoked.push(p[0]); return []; }
  if (t.startsWith('select id from users where id')) return db.users.filter(u => u.id === p[0]).map(u => ({ id: u.id }));
  if (t.startsWith('insert into api_tokens')) { db.tokens.push({ sql: t, user: p[1] }); return []; }
  if (t.includes('from api_tokens t join users u')) {
    db.tokens.push({ lookup: t });
    return p[0] === A.hashToken('8legs_pat_temporary') ? [{ id: 'tok', user_id: 't', username: 'temporary', is_admin: false, must_change_password: true }] : [];
  }

  /* Jarvis */
  if (t.startsWith('select * from jarvis_people where id')) return db.jarvis.people.filter(x => x.id === p[0]);
  if (t.startsWith('select owner_user_id from wa_numbers where id')) return db.numbers.filter(n => n.id === p[0]);
  if (t.startsWith('select * from wa_numbers where id')) return db.numbers.filter(n => n.id === p[0]);
  if (t.startsWith('select org_id from users where id')) return db.users.filter(u => u.id === p[0]).map(u => ({ org_id: u.org_id }));
  if (t.startsWith('select id from jarvis_people where number_id')) return [];
  if (/^delete from jarvis_(messages|memory|reminders) where person_id/.test(t)) { db.jarvis.deleted.push(t.split(' ')[2]); return []; }
  if (t.startsWith('update jarvis_people set')) { lastUpdate = { phone: p[1], adminCanView: p[8] }; Object.assign(db.jarvis.people[0], { phone: p[1], admin_can_view_memory: p[8] }); return []; }
  if (t.startsWith('select (select count(*)::int from jarvis_memory')) return [{ memory: 0, reminders: 0, messages: 0, since: null }];

  if (t.startsWith('insert into error_log') || t.startsWith('delete from error_log')) return [];
  throw new Error('unrouted: ' + t.slice(0, 100));
};

const bearer = (payload) => `Bearer ${signJWT(payload)}`;
const tokenOf = (id, extra = {}) => bearer({ userId: id, username: userById(id).username, isAdmin: !!userById(id).is_admin, tv: userById(id).token_version, exp: Math.floor(Date.now() / 1000) + 600, ...extra });
async function call(file, method, { auth, query = {}, body, headers = {} } = {}) {
  const { default: handler } = await import(`${ROOT}/api/${file}`);
  const res = { statusCode: 200, payload: undefined,
    status(c) { this.statusCode = c; return this; }, json(v) { this.payload = v; return this; }, setHeader() {}, end() { return this; } };
  await handler({ method, query, body, headers: { authorization: auth || '', host: 'platform.test', ...headers } }, res);
  return res;
}

/* ── sessions ───────────────────────────────────────────────────────────── */
const fakeRes = () => ({ statusCode: 200, payload: null, status(c) { this.statusCode = c; return this; }, json(v) { this.payload = v; return this; } });
let r = fakeRes();
check('a current session passes', !!(await A.requireSession({ headers: { authorization: tokenOf('e') } }, r)));
const stale = tokenOf('e', { tv: 0 });
userById('e').token_version = 1;
r = fakeRes();
check('a session signed before the account\'s token_version moved is refused', !(await A.requireSession({ headers: { authorization: stale } }, r)) && r.statusCode === 401);
r = fakeRes();
check('and so is one with no tv at all (older than the change)', !(await A.requireSession({ headers: { authorization: bearer({ userId: 'e', exp: Math.floor(Date.now() / 1000) + 60 }) } }, r)) && r.statusCode === 401);
const { member } = await import(`${ROOT}/api/_access.js`);
check('member() holds a session token to it too', (await member({ userId: 'e', tv: 0, viaSession: true })) === null &&
      !!(await member({ userId: 'e', tv: 1, viaSession: true })));
check('but a lookup the platform makes itself is unaffected', !!(await member({ userId: 'e' })));
userById('e').token_version = 0;

r = fakeRes();
check('a temporary password opens nothing', !(await A.requireSession({ headers: { authorization: tokenOf('t') } }, r)) &&
      r.statusCode === 403 && r.payload.code === 'MUST_CHANGE_PASSWORD');
r = fakeRes();
check('except its own replacement', !!(await A.requireSession({ headers: { authorization: tokenOf('t') } }, r, { allowPasswordChange: true })));
r = fakeRes();
check('an account that is gone has no session', !(await A.requireSession({ headers: { authorization: bearer({ userId: 'ghost', exp: Math.floor(Date.now() / 1000) + 60 }) } }, r)) && r.statusCode === 401);

r = fakeRes();
check('admin rights come from the database: a token that says admin is not enough',
      !(await A.requireAdmin({ headers: { authorization: tokenOf('a', { isAdmin: true }) } }, r)) && r.statusCode === 403);
r = fakeRes();
check('and the platform admin passes', !!(await A.requireAdmin({ headers: { authorization: tokenOf('p') } }, r)));
check('the admin endpoints this probe owns all ask the database',
      ['admin/users.js', 'admin/users/[userId]/index.js', 'admin/users/[userId]/agents.js', 'admin/users/[userId]/reset-password.js',
       'admin/orgs.js', 'admin/orgs/[id].js', 'admin/invite-codes.js', 'admin/invite-codes/[id].js']
        .every(f => /await requireAdmin\(req, res\)/.test(fs.readFileSync(`${ROOT}/api/${f}`, 'utf8'))));

r = fakeRes();
check('a personal access token is refused while its account holds a temporary password',
      !(await A.checkAuthOrToken({ headers: { authorization: 'Bearer 8legs_pat_temporary' } }, r)) && r.statusCode === 403);
check('and an expired one is not even found', db.tokens.some(x => x.lookup && /t\.expires_at is null or t\.expires_at > now\(\)/.test(x.lookup)));
const made = await call('tokens.js', 'POST', { auth: tokenOf('e'), body: { name: 'laptop' } });
check('a new access token ends', made.statusCode === 201 && !!made.payload.expiresAt &&
      db.tokens.some(x => x.sql && /expires_at/.test(x.sql)), JSON.stringify(made.payload));

/* ── signing in ─────────────────────────────────────────────────────────── */
for (let i = 0; i < 12; i++) await call('auth/login.js', 'POST', { body: { username: 'editor', password: 'wrong-' + i }, headers: { 'x-real-ip': `10.0.0.${i}` } });
check('strangers hammering a username lock it as a record…', !!db.throttle.get('user:editor')?.locked_until);
const t0 = Date.now();
const owner = await call('auth/login.js', 'POST', { body: { username: 'editor', password: 'password-1' }, headers: { 'x-real-ip': '10.9.9.9' } });
check('…but its owner, with the right password, still gets in (only slower)', owner.statusCode === 200 && Date.now() - t0 >= 1900, `${owner.statusCode} ${JSON.stringify(owner.payload)}`);
const claims = A.verifyJWT(owner.payload.token);
check('and the session carries the account\'s token_version', claims && claims.tv === 0 && claims.exp > Date.now() / 1000);
db.throttle.set('ip:10.9.9.9', { fails: 5, locked_until: null });
await call('auth/login.js', 'POST', { body: { username: 'viewer', password: 'password-1' }, headers: { 'x-real-ip': '10.9.9.9' } });
check('a successful sign-in does not wipe its address\'s record', db.throttle.get('ip:10.9.9.9')?.fails === 5, JSON.stringify(db.throttle.get('ip:10.9.9.9')));

const reg = (body) => call('auth/register.js', 'POST', { body: { phone: '0500000000', inviteCode: 'X', ...body } });
check('registration refuses a short password', (await reg({ username: 'newbie', password: 'short' })).statusCode === 400);
check('and a username with a space in it', (await reg({ username: 'new bie', password: 'long-enough-1' })).statusCode === 400);

/* ── passwords ──────────────────────────────────────────────────────────── */
const reset = await call('admin/users/[userId]/reset-password.js', 'POST', { auth: tokenOf('p'), query: { userId: 'r' } });
check('the platform admin\'s reset gives a twelve-character password (the one generator)',
      reset.statusCode === 200 && /^[A-Za-z0-9]{12}$/.test(reset.payload.tempPassword) && verifyPassword(reset.payload.tempPassword, userById('r').password_hash),
      JSON.stringify(reset.payload));
check('and ends the account\'s sessions and access tokens', userById('r').token_version === 1 && db.revoked.includes('r') && userById('r').must_change_password);
const notAdmin = await call('admin/users/[userId]/reset-password.js', 'POST', { auth: tokenOf('a', { isAdmin: true }), query: { userId: 'p' } });
check('a token that only claims admin cannot reset anyone', notAdmin.statusCode === 403);

/* ── the code runner ────────────────────────────────────────────────────── */
const runner = fs.readFileSync(`${ROOT}/api/run_tool.py`);
check('the runner deployed alone is byte for byte the platform\'s copy',
      fs.existsSync(`${ROOT}/tool-runner/api/run_tool.py`) && runner.equals(fs.readFileSync(`${ROOT}/tool-runner/api/run_tool.py`)));
check('the unused fetch proxy and the broken debug endpoint are gone',
      !fs.existsSync(`${ROOT}/api/scrape.py`) && !fs.existsSync(`${ROOT}/api/agents/[id]/debug.js`));

let python = null;
try { execFileSync('python3', ['-c', 'import sys; assert sys.version_info >= (3, 9)']); python = 'python3'; } catch { /* no python here */ }
if (!python) {
  console.log('- python3 is not available here; the runner and extractor checks are skipped');
} else {
  const harness = `
import importlib.util, os, sys, json, io, zipfile, hashlib, hmac, base64, time
def load(name, p):
    spec = importlib.util.spec_from_file_location(name, p); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
rt = load("rt", sys.argv[1]); ef = load("ef", sys.argv[2])
out = {}
for k in ("JWT_SECRET", "TOOL_RUNNER_SECRET"): os.environ.pop(k, None)
out["no_secret_no_entry"] = not rt._authorized({"X-Internal-Secret": hashlib.sha256(b":internal-tool-runner").hexdigest()})
os.environ["JWT_SECRET"] = "k"
def jwt(secret, payload):
    b = lambda x: base64.urlsafe_b64encode(x).rstrip(b"=").decode()
    h = b(b'{"alg":"HS256"}'); p = b(json.dumps(payload).encode())
    return f"{h}.{p}." + b(hmac.new(secret.encode(), f"{h}.{p}".encode(), hashlib.sha256).digest())
session = jwt("k", {"userId": "u", "exp": int(time.time()) + 60})
out["browser_refused"] = not rt._authorized({"Authorization": "Bearer " + session})
out["platform_accepted"] = rt._authorized({"X-Internal-Secret": hashlib.sha256(b"k:internal-tool-runner").hexdigest()})
os.environ["DATABASE_URL"] = "postgres://platform-secret"
r = rt._run("import os\\ndef run(**k):\\n    return ','.join(sorted(os.environ))", {}, [], {"TOOL_KEY": "v"})
out["env"] = r.get("result", r.get("error"))
out["bad_package"] = rt._run("def run(**k): return 1", {}, ["--index-url=http://evil.test"], {}).get("error", "")
out["extract_anon"] = not ef._authorized({})
out["extract_session"] = ef._authorized({"Authorization": "Bearer " + session})
buf = io.BytesIO()
with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z: z.writestr("word/document.xml", b"x" * (60 * 1024 * 1024))
try: ef._extract("bomb.docx", buf.getvalue()); out["bomb"] = "opened"
except ValueError as e: out["bomb"] = str(e)
print(json.dumps(out))
`;
  const got = JSON.parse(execFileSync(python, ['-I', '-c', harness, `${ROOT}/api/run_tool.py`, `${ROOT}/api/extract_file.py`], { env: { PATH: process.env.PATH } }).toString());
  check('with no secret configured, the runner accepts nothing (no computable constant)', got.no_secret_no_entry === true);
  check('a browser session cannot run code', got.browser_refused === true);
  check('the platform\'s internal secret can', got.platform_accepted === true);
  check('the code sees its own variables and none of the platform\'s',
        /TOOL_KEY/.test(got.env) && !/DATABASE_URL|JWT_SECRET/.test(got.env), got.env);
  check('a "package" that is really a pip option is refused', /Not a package name/.test(got.bad_package), got.bad_package);
  check('the extractor refuses an anonymous caller and accepts a session', got.extract_anon === true && got.extract_session === true);
  check('a zip bomb is refused before it is unpacked', /more than 50 MB/.test(got.bomb), got.bomb);
}
const extractor = fs.readFileSync(`${ROOT}/api/extract_file.py`, 'utf8');
check('the extractor sends no CORS header', !/Access-Control-Allow-Origin/.test(extractor));

/* ── /api/tool-run ──────────────────────────────────────────────────────── */
const sent = [];
globalThis.fetch = async (url, opts) => {
  sent.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
  return new Response(JSON.stringify({ result: 'ran' }), { headers: { 'content-type': 'application/json' } });
};
const draft = { agentId: 'ag1', toolName: 'lookup', code: 'def run(**k):\n    return "draft"', inputs: { q: 1 }, packages: ['httpx'], env_vars: { API_KEY: '', MODE: 'test' } };
let tr = await call('tool-run.js', 'POST', { auth: tokenOf('v'), body: draft });
check('a viewer runs the saved tool, whatever code they send',
      tr.statusCode === 200 && sent[0]?.body.code.includes('saved') && sent[0].body.env_vars.API_KEY === 'SAVED-SECRET' &&
      sent[0].body.packages.join() === 'requests', JSON.stringify(sent[0]));
check('through the platform\'s secret, to the platform\'s runner',
      sent[0]?.url === 'https://platform.test/api/run-tool' && sent[0].headers['X-Internal-Secret'] === internalSecret());
tr = await call('tool-run.js', 'POST', { auth: tokenOf('e'), body: draft });
check('an editor runs the draft they sent, with blank variables filled from the saved tool',
      sent[1]?.body.code.includes('draft') && sent[1].body.env_vars.API_KEY === 'SAVED-SECRET' && sent[1].body.env_vars.MODE === 'test' &&
      sent[1].body.packages.join() === 'httpx', JSON.stringify(sent[1]));
tr = await call('tool-run.js', 'POST', { auth: tokenOf('x'), body: draft });
check('someone from another organization cannot run it', tr.statusCode === 404 && sent.length === 2);
tr = await call('tool-run.js', 'POST', { auth: tokenOf('v'), body: { ...draft, toolName: 'nope' } });
check('a viewer naming a tool that does not exist gets an error, not a run', /Unknown tool/.test(tr.payload.error) && sent.length === 2);
check('nobody signed in runs anything', (await call('tool-run.js', 'POST', { body: draft })).statusCode === 401 && sent.length === 2);
process.env.TOOL_RUNNER_URL = 'https://runner.test';
process.env.TOOL_RUNNER_SECRET = 'runner-only-secret';
await call('tool-run.js', 'POST', { auth: tokenOf('v'), body: draft });
check('with a separate runner configured, runs go there with its own secret',
      sent[2]?.url === 'https://runner.test/api/run-tool' && sent[2].headers['X-Internal-Secret'] === 'runner-only-secret', JSON.stringify(sent[2]));
delete process.env.TOOL_RUNNER_URL;
delete process.env.TOOL_RUNNER_SECRET;

/* ── Jarvis: what is private stays private, from the admin too ──────────── */
const patch = (body) => call('admin/jarvis/people/[id].js', 'PATCH', { auth: tokenOf('a'), query: { id: 'jp1' }, body });
const on = await patch({ adminCanViewMemory: true });
check('an admin cannot turn on viewing a person\'s memory', on.statusCode === 403 && !db.jarvis.people[0].admin_can_view_memory);
check('the number\'s own phone is refused', (await patch({ phone: '972500000099' })).statusCode === 400);
const moved = await patch({ phone: '972500000777' });
check('a new phone erases the conversation, the memory and the reminders first',
      moved.statusCode === 200 && ['jarvis_messages', 'jarvis_memory', 'jarvis_reminders'].every(x => db.jarvis.deleted.includes(x)) &&
      lastUpdate.phone === '972500000777', JSON.stringify({ deleted: db.jarvis.deleted, lastUpdate }));

console.log(`\n${failed ? `${failed} FAILURE(S)` : 'all green'}`);
process.exit(failed ? 1 : 0);
