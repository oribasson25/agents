/**
 * Apps, end to end on the server side:
 *
 *   the contract   filesToApp(appToFiles(a), a) gives back `a`
 *   the CLI path   pull, push, and every refusal that must write nothing
 *   the git path   a push to GitHub goes live, or is declined whole
 *   versions       every change is kept, and an earlier one can be put back
 *   serving        private stays private, and the page is sandboxed
 *   the runtime    an app reaches only what it links and its owner has
 */
import crypto from 'crypto';
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

process.env.JWT_SECRET = 'probe-secret';
process.env.GITHUB_WEBHOOK_SECRET = 'test-secret';
process.env.GITHUB_AGENTS_TOKEN = 'test-token';
process.env.GITHUB_AGENTS_ORG = '8legs-agents';
process.env.APP_URL = 'https://www.8legs.world';

const { appToFiles, filesToApp, appVersion, starterFiles } = await import(`${ROOT}/api/_appFiles.js`);
const { createToken, signJWT } = await import(`${ROOT}/api/_auth.js`);
const { viewToken, checkViewToken } = await import(`${ROOT}/api/_apps.js`);
const { default: appsHandler } = await import(`${ROOT}/api/apps.js`);
const { default: appHandler } = await import(`${ROOT}/api/apps/[id]/index.js`);
const { default: filesHandler } = await import(`${ROOT}/api/apps/[id]/files.js`);
const { default: versionsHandler } = await import(`${ROOT}/api/apps/[id]/versions.js`);
const { default: webhook } = await import(`${ROOT}/api/github/webhook.js`);
const { default: serve, parseAppPath } = await import(`${ROOT}/api/app-serve.js`);
const { default: run } = await import(`${ROOT}/api/app-run.js`);

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && detail ? `\n    ${detail}` : ''}`);
  if (!ok) failed++;
};
const same = (a, b) => JSON.stringify(sort(a)) === JSON.stringify(sort(b));
function sort(v) {
  if (Array.isArray(v)) return v.map(sort);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])]));
  return v;
}

/* ── the contract ───────────────────────────────────────────────────────── */
const minimal = {
  id: '11111111-1111-4111-8111-111111111111', slug: 'my-app', name: 'My app', description: '',
  entry: 'index.html', agents: {}, tables: {}, access: 'private',
  files: starterFiles('My app'), createdAt: '2026-11-15T00:00:00.000Z',
};
const full = {
  ...minimal, id: '22222222-2222-4222-8222-222222222222', slug: 'leads-desk', access: 'link',
  name: 'לוח לידים', description: 'מעקב לידים',
  entry: 'pages/home.html',
  agents: { support: 'agent-1' },
  tables: { leads: 'table-1', prices: { id: 'table-2', readonly: true } },
  files: { 'pages/home.html': '<h1>שלום</h1>\n', 'src/app.js': 'console.log(1)\n',
           'data/seed.json': '{"a":1}', 'README.md': '# mine\n' },
};
const withUnknowns = { ...full, theme: { accent: '#ef9f27' }, futureFlag: true };

for (const [label, source] of [['a freshly created app', minimal], ['Hebrew, links, nested files', full],
                               ['with fields the platform adds later', withUnknowns]]) {
  const app = JSON.parse(JSON.stringify(source));
  const { app: back, errors } = filesToApp(appToFiles(app), app);
  check(`round trip: ${label}`, !errors.length && same(app, back),
        errors.join('; ') || `\n    in:  ${JSON.stringify(sort(app)).slice(0, 300)}\n    out: ${JSON.stringify(sort(back)).slice(0, 300)}`);
}
check('the version tracks content', appVersion(full) !== appVersion({ ...full, files: { ...full.files, 'src/app.js': 'x' } }));
check('the version ignores who may open the app', appVersion(full) === appVersion({ ...full, access: 'private' }));
{
  const moved = filesToApp({ ...appToFiles(full), 'app.json': JSON.stringify({ id: full.id, slug: 'stolen', entry: 'pages/home.html', access: 'link' }) },
                           { ...full, access: 'private' });
  check('a file cannot move the slug or publish the app',
        moved.app && moved.app.slug === 'leads-desk' && moved.app.access === 'private', JSON.stringify(moved));
}
for (const [label, files, want] of [
  ['a missing entry file', { 'app.json': JSON.stringify({ id: 'x' }) }, /index\.html is missing/],
  ['broken app.json', { 'app.json': '{ nope', 'index.html': '' }, /app\.json/],
  ['a path that climbs out', { 'app.json': JSON.stringify({ id: 'x' }), 'index.html': '', '../evil.js': '' }, /not a usable path/],
  ['a path that would shadow a private link', { 'app.json': JSON.stringify({ id: 'x' }), 'index.html': '', '~tok/a.js': '' }, /may not start with ~/],
  ['a link with no id', { 'app.json': JSON.stringify({ id: 'x', agents: { a: {} } }), 'index.html': '' }, /needs an id/],
  ['more than the size limit', { 'app.json': JSON.stringify({ id: 'x' }), 'index.html': 'x'.repeat(2 * 1024 * 1024 + 1) }, /at most 2 MB/],
]) {
  const { app, errors } = filesToApp(files, {});
  check(`refused: ${label}`, app === null && want.test(errors.join('; ')), errors.join('; '));
}

/* ── an in-memory platform ──────────────────────────────────────────────── */
const { token, hash } = createToken();
const USER = { id: 'u1' };
const db = { apps: new Map(), versions: [], repos: new Map(), rows: [{ id: 'r1', data: { name: 'Dana' } }],
             agents: { 'agent-1': 'u1', 'agent-x': 'u2' }, tables: { 'table-1': 'u1', 'table-2': 'u1', 'table-x': 'u2' } };
let writes = 0;

globalThis.__db = (text, p) => {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.includes('from api_tokens t join users u'))
    return p[0] === hash ? [{ id: 'tok1', user_id: 'u1', username: 'ori', is_admin: false }] : [];
  if (t.startsWith('update api_tokens')) return [];

  if (t.startsWith('select 1 as x from apps where slug')) return [...db.apps.values()].some(a => a.slug === p[0]) ? [{ x: 1 }] : [];
  if (t.startsWith('insert into apps')) { db.apps.set(p[0], { id: p[0], user_id: p[1], slug: p[2], data: JSON.parse(p[3]), active: null }); return []; }
  if (t.startsWith('select data, user_id, active_version_id from apps')) {
    const a = [...db.apps.values()].find(x => (x.id === p[0] || x.slug === p[1]) && (x.user_id === p[2] || p[3]));
    return a ? [{ data: a.data, user_id: a.user_id, active_version_id: a.active }] : [];
  }
  if (t.startsWith('select data, user_id from apps where slug')) {
    const a = [...db.apps.values()].find(x => x.slug === p[0]);
    return a ? [{ data: a.data, user_id: a.user_id }] : [];
  }
  if (t.startsWith('select data, user_id from apps where id')) {
    const a = db.apps.get(p[0]);
    return a ? [{ data: a.data, user_id: a.user_id }] : [];
  }
  if (t.startsWith('select data, updated_at,'))
    return [...db.apps.values()].filter(a => a.user_id === p[0]).map(a => ({ data: a.data, updated_at: 'now', versions: 1 }));
  if (t.startsWith('update apps set data') && t.includes('active_version_id =')) {
    const a = db.apps.get(p[2]); a.data = JSON.parse(p[0]); a.active = p[1]; writes++; return [];
  }
  if (t.startsWith('update apps set data')) { db.apps.get(p[1]).data = JSON.parse(p[0]); writes++; return []; }
  if (t.startsWith('update apps set active_version_id')) { db.apps.get(p[1]).active = p[0]; return []; }
  if (t.startsWith('delete from apps')) { db.apps.delete(p[0]); return []; }

  if (t.startsWith('insert into app_versions')) {
    const number = db.versions.filter(v => v.app_id === p[1]).length + 1;
    db.versions.push({ id: p[0], app_id: p[1], number, data: JSON.parse(p[3]), source: p[4], commit_sha: p[5], message: p[6] });
    return [{ number }];
  }
  if (t.startsWith('select id, number, source, commit_sha, message, created_at from app_versions'))
    return db.versions.filter(v => v.app_id === p[0]).sort((a, b) => b.number - a.number);
  if (t.startsWith('select id, number, data from app_versions'))
    return db.versions.filter(v => v.app_id === p[0] && (v.id === p[1] || String(v.number) === p[2]));

  if (t.startsWith('select id from agents where user_id')) return p[1].filter(id => db.agents[id] === p[0]).map(id => ({ id }));
  if (t.startsWith('select id from data_tables where user_id')) return p[1].filter(id => db.tables[id] === p[0]).map(id => ({ id }));

  if (t.startsWith('select owner, repo, webhook_id from app_repos')) { const r = db.repos.get(p[0]); return r ? [r] : []; }
  if (t.startsWith('insert into app_repos')) { db.repos.set(p[0], { owner: p[1], repo: p[2], webhook_id: p[3], last_push_sha: p[4] }); return []; }
  if (t.startsWith('update app_repos set last_push_sha')) { db.repos.get(p[1]).last_push_sha = p[0]; return []; }
  if (t.startsWith('select r.agent_id, r.last_push_sha')) return [];
  if (t.startsWith('select r.app_id, r.last_push_sha')) {
    const hit = [...db.repos.entries()].find(([, r]) => r.owner === p[0] && r.repo === p[1]);
    return hit ? [{ app_id: hit[0], last_push_sha: hit[1].last_push_sha, user_id: db.apps.get(hit[0]).user_id }] : [];
  }

  if (t.startsWith('select id, name, description, columns, created_at, updated_at from data_tables'))
    return db.tables[p[0]] === p[1] ? [{ id: p[0], name: 'Leads', description: '', columns: [{ key: 'name', name: 'Name', type: 'text' }] }] : [];
  if (t.includes('from data_table_rows') && t.startsWith('select count')) return [{ total: db.rows.length }];
  if (t.includes('from data_table_rows')) return db.rows;
  if (t.startsWith('insert into data_table_rows')) { db.rows.push({ id: p[0], data: JSON.parse(p[2]), written_by: p[3] }); return []; }
  if (t.startsWith('update data_tables set updated_at')) return [];
  if (t.includes('error_log')) return [];
  throw new Error('unrouted: ' + t.slice(0, 90));
};

/* GitHub: repository, tree, blobs, refs, statuses. */
let treeFiles = {}, statuses = [], commits = 0;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const ok = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  if (/\/git\/trees\/[^/?]+\?recursive=1/.test(u))
    return ok({ truncated: false, tree: Object.keys(treeFiles).map(path => ({ path, type: 'blob', sha: `blob-${encodeURIComponent(path)}` })) });
  if (/\/git\/blobs\/blob-/.test(u)) {
    const path = decodeURIComponent(decodeURIComponent(u.split('/git/blobs/blob-')[1]));
    return ok({ encoding: 'base64', content: Buffer.from(treeFiles[path], 'utf8').toString('base64') });
  }
  if (/\/statuses\//.test(u)) { statuses.push(JSON.parse(opts.body)); return ok({}); }
  if (/\/hooks$/.test(u)) return opts.method === 'POST' ? ok({ id: 77 }) : ok([]);
  if (/\/orgs\/[^/]+\/repos$/.test(u)) return ok({ html_url: 'https://github.com/x/y', pushed_at: null });
  if (/\/git\/blobs$/.test(u)) return ok({ sha: 'b' });
  if (/\/git\/trees$/.test(u)) return ok({ sha: 't' });
  if (/\/git\/commits$/.test(u)) return ok({ sha: `platform-sha-${++commits}` });
  if (/\/git\/ref\/heads\//.test(u)) return ok({ object: { sha: 'parent' } });
  if (/\/git\/refs/.test(u)) return ok({});
  if (/\/repos\/[^/]+\/[^/]+$/.test(u)) return ok({ message: 'Not Found' }, 404);
  throw new Error('unexpected GitHub call: ' + u);
};

function call(handler, method, query, body, auth = `Bearer ${token}`, extra = {}) {
  const res = { statusCode: 200, payload: undefined, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(v) { this.payload = v; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(v) { this.body = v; return this; } };
  const req = { method, query: query || {}, body, headers: { authorization: auth, host: 'www.8legs.world' }, ...extra };
  return Promise.resolve(handler(req, res)).then(() => res);
}
const session = `Bearer ${signJWT({ userId: 'u1', username: 'ori', isAdmin: false })}`;
const stranger = `Bearer ${signJWT({ userId: 'u2', username: 'eve', isAdmin: false })}`;

/* ── create, pull, push ─────────────────────────────────────────────────── */
const made = await call(appsHandler, 'POST', {}, { name: 'Leads desk' }, session);
check('creating an app gives it an address and a starter page',
      made.statusCode === 201 && made.payload.slug === 'leads-desk' && !!made.payload.files['index.html'], JSON.stringify(made.payload).slice(0, 200));
const APP = made.payload.id;
check('it starts private', made.payload.access === 'private' && /\/a\/leads-desk\/~/.test(made.payload.url));
check('the list does not carry the files', !(await call(appsHandler, 'GET', {})).payload[0].files);
check('a second app by the same name gets its own address',
      (await call(appsHandler, 'POST', {}, { name: 'Leads desk' }, session)).payload.slug !== 'leads-desk');

const pulled = await call(filesHandler, 'GET', { id: APP });
check('pull returns the tree with a version', pulled.statusCode === 200 && !!pulled.payload.files['app.json'] && !!pulled.payload.version);
check('pull makes the repository', pulled.payload.git?.cloneUrl === `https://github.com/8legs-agents/app-leads-desk-${APP.slice(0, 8)}.git`,
      JSON.stringify(pulled.payload.git));
check('pull works by slug too', (await call(filesHandler, 'GET', { id: 'leads-desk' })).payload.appId === APP);
check('no token -> 401', (await call(filesHandler, 'GET', { id: APP }, null, '')).statusCode === 401);
check("somebody else's app -> 404", (await call(filesHandler, 'GET', { id: APP }, null, stranger)).statusCode === 404);

const files = pulled.payload.files;
const edited = { ...files, 'index.html': '<!doctype html><html><head></head><body>edited locally<script src="app.js"></script></body></html>',
                 'app.json': JSON.stringify({ ...JSON.parse(files['app.json']), agents: { support: 'agent-1' }, tables: { leads: 'table-1' } }) };
const pushed = await call(filesHandler, 'PUT', { id: APP }, { baseVersion: pulled.payload.version, files: edited });
check('push makes the edit live', pushed.statusCode === 200 && db.apps.get(APP).data.files['index.html'].includes('edited locally'),
      JSON.stringify(pushed.payload));
check('push is kept as version 2', pushed.payload.versionNumber === 2);
check('the push is mirrored to git', db.repos.get(APP).last_push_sha === `platform-sha-${commits}`);

const before = JSON.stringify(db.apps.get(APP).data);
const wasWrites = writes;
check('a stale push -> 409',
      (await call(filesHandler, 'PUT', { id: APP }, { baseVersion: pulled.payload.version, files: edited })).statusCode === 409);
const now = () => appVersion(db.apps.get(APP).data);
check('broken app.json -> 422',
      (await call(filesHandler, 'PUT', { id: APP }, { baseVersion: now(), files: { ...edited, 'app.json': '{' } })).statusCode === 422);
const { 'index.html': _gone, ...noEntry } = edited;
check('no entry file -> 422', (await call(filesHandler, 'PUT', { id: APP }, { baseVersion: now(), files: noEntry })).statusCode === 422);
const theirs = await call(filesHandler, 'PUT', { id: APP }, { baseVersion: now(),
  files: { ...edited, 'app.json': JSON.stringify({ ...JSON.parse(edited['app.json']), tables: { leads: 'table-x' } }) } });
check("linking somebody else's table -> 422", theirs.statusCode === 422 && /not one of your Tables/.test(String(theirs.payload.errors)),
      JSON.stringify(theirs.payload));
check('every refusal left the app untouched', JSON.stringify(db.apps.get(APP).data) === before && writes === wasWrites);
check('a push with no change makes no version',
      (await call(filesHandler, 'PUT', { id: APP }, { baseVersion: now(), files: appToFiles(db.apps.get(APP).data) })).payload.versionNumber === null);

/* ── git ────────────────────────────────────────────────────────────────── */
function deliver(sha, ref = 'refs/heads/main') {
  const raw = Buffer.from(JSON.stringify({ after: sha, ref,
    repository: { name: db.repos.get(APP).repo, owner: { login: '8legs-agents', name: '8legs-agents' } } }));
  const sig = 'sha256=' + crypto.createHmac('sha256', 'test-secret').update(raw).digest('hex');
  const req = { method: 'POST', headers: { 'x-github-event': 'push', 'x-hub-signature-256': sig } };
  req.on = (ev, fn) => { if (ev === 'data') fn(raw); if (ev === 'end') fn(); return req; };
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(v) { this.payload = v; return this; }, end() { return this; } };
  return Promise.resolve(webhook(req, res)).then(() => res);
}
treeFiles = { ...appToFiles(db.apps.get(APP).data), 'index.html': '<html><head></head><body>pushed with git</body></html>',
              '.8legs/lock.json': '{}' };
let r = await deliver('git-sha-1');
check('a git push goes live', r.payload?.applied === true && db.apps.get(APP).data.files['index.html'].includes('pushed with git'), JSON.stringify(r.payload));
check('and is kept as a version naming the commit', db.versions.at(-1).source === 'git' && db.versions.at(-1).commit_sha === 'git-sha-1');
check('and the commit is marked success', statuses.at(-1)?.state === 'success', JSON.stringify(statuses.at(-1)));
check("the CLI's bookkeeping, if committed, is not served", !('.8legs/lock.json' in db.apps.get(APP).data.files));

const live = JSON.stringify(db.apps.get(APP).data);
treeFiles = { ...treeFiles, 'app.json': '{ broken' };
r = await deliver('git-sha-2');
check('a git push that does not validate is not applied', r.payload?.applied === false && JSON.stringify(db.apps.get(APP).data) === live);
check('and the commit is marked failed', statuses.at(-1)?.state === 'failure');
treeFiles = { ...appToFiles(db.apps.get(APP).data), 'index.html': 'from a side branch' };
r = await deliver('git-sha-3', 'refs/heads/experiment');
check('a push to another git branch is not served', r.payload?.applied === false && JSON.stringify(db.apps.get(APP).data) === live);
r = await deliver(db.repos.get(APP).last_push_sha);
check("the platform's own mirror push is not applied back", r.payload?.skipped === 'own push');

/* ── versions ───────────────────────────────────────────────────────────── */
const versions = (await call(versionsHandler, 'GET', { id: APP })).payload.versions;
check('every change is listed, newest first, one of them live',
      versions.length === 3 && versions[0].number === 3 && versions.filter(v => v.active).length === 1 && versions[0].active,
      JSON.stringify(versions.map(v => [v.number, v.active])));
const back = await call(versionsHandler, 'POST', { id: APP }, { versionId: '2' });
check('an earlier version can be put back', back.statusCode === 200 && db.apps.get(APP).data.files['index.html'].includes('edited locally'));
check('going back deletes nothing', db.versions.filter(v => v.app_id === APP).length === 3);
check('no such version -> 404', (await call(versionsHandler, 'POST', { id: APP }, { versionId: '99' })).statusCode === 404);

/* ── the screen's edits go through the same rules ───────────────────────── */
const ui = await call(appHandler, 'PUT', { id: APP }, { files: { ...db.apps.get(APP).data.files, 'extra.css': 'b{}' } }, session);
check('an edit in the platform is a version too', ui.statusCode === 200 && ui.payload.versionNumber === 4, JSON.stringify(ui.payload).slice(0, 200));
check('an edit that breaks the app is refused',
      (await call(appHandler, 'PUT', { id: APP }, { files: { 'other.html': '' } }, session)).statusCode === 422);
check('a CLI token cannot use the screen endpoint', (await call(appHandler, 'GET', { id: APP })).statusCode === 401);

/* ── serving ────────────────────────────────────────────────────────────── */
check('the address parses with and without a token',
      same(parseAppPath('/a/x/~tok/js/a.js'), { slug: 'x', token: 'tok', path: 'js/a.js' }) &&
      same(parseAppPath('/a/x/'), { slug: 'x', token: null, path: '' }) &&
      same(parseAppPath('/a/x'), { slug: 'x', token: null, path: null }));
const get = (url) => call(serve, 'GET', {}, null, '', { url });
check('a private app does not open without a link', (await get('/a/leads-desk/')).statusCode === 403);
check('nor with a link made for another app', (await get(`/a/leads-desk/~${viewToken('other-app', 'u1')}/`)).statusCode === 403);
check('nor with a login token in place of a link',
      (await get(`/a/leads-desk/~${signJWT({ userId: 'u1', appId: APP })}/`)).statusCode === 403);
check('a view link is not a login', !checkViewToken(session.slice(7), APP) &&
      (await call(appsHandler, 'GET', {}, null, `Bearer ${viewToken(APP, 'u1')}`)).statusCode === 401);
const tok = viewToken(APP, 'u1');
const opened = await get(`/a/leads-desk/~${tok}/`);
check('it opens with its link', opened.statusCode === 200 && opened.body.includes('edited locally'));
check('the page is sandboxed away from the platform',
      /^sandbox /.test(opened.headers['content-security-policy']) && !/allow-same-origin/.test(opened.headers['content-security-policy']));
check('the page gets the legs handle ahead of its own scripts',
      opened.body.indexOf('window.legs=') > 0 && opened.body.indexOf('window.legs=') < opened.body.indexOf('src="app.js"'));
check('and the handle knows what the app links', /"agents":\["support"\]/.test(opened.body) && /"tables":\["leads"\]/.test(opened.body));
const js = await get(`/a/leads-desk/~${tok}/app.js`);
check('its other files are served with their type', js.statusCode === 200 && /text\/javascript/.test(js.headers['content-type']) && !js.body.includes('window.legs='));
check('a folder address without the slash is sent to the folder', (await get(`/a/leads-desk/~${tok}`)).headers.location === `/a/leads-desk/~${tok}/`);
check('a missing file -> 404', (await get(`/a/leads-desk/~${tok}/nope.js`)).statusCode === 404);
check('no such app -> 404', (await get('/a/nothing-here/')).statusCode === 404);
check('the rewrite form (slug and path as query) works too',
      (await call(serve, 'GET', { slug: 'leads-desk', path: `~${tok}/app.js` }, null, '', { url: '/api/app-serve' })).statusCode === 200);

const open = await call(appHandler, 'PUT', { id: APP }, { access: 'link' }, session);
check('sharing by link is a setting, not a version', open.payload.access === 'link' && open.payload.versionNumber === null && open.payload.url === '/a/leads-desk/');
check('a shared app opens for anyone', (await get('/a/leads-desk/')).statusCode === 200);

/* ── the runtime ────────────────────────────────────────────────────────── */
const ask = (body) => call(run, 'POST', {}, { app: APP, ...body }, '');
const rows = await ask({ op: 'table.rows', name: 'leads' });
check('a linked table can be read', rows.statusCode === 200 && rows.payload.rows.length === 1 && rows.payload.columns.length === 1, JSON.stringify(rows.payload));
const added = await ask({ op: 'table.add', name: 'leads', row: { name: 'Noa' } });
check('and written, marked as written by the app', added.statusCode === 200 && db.rows.at(-1).written_by === `app:${APP}`);
check('a table the app does not link is out of reach', (await ask({ op: 'table.rows', name: 'prices' })).statusCode === 404);
check('an unknown operation is refused', (await ask({ op: 'account.delete' })).statusCode === 400);
await call(appHandler, 'PUT', { id: APP }, { access: 'private', tables: { leads: { id: 'table-1', readonly: true } } }, session);
check('a private app answers nobody without its link', (await ask({ op: 'table.rows', name: 'leads' })).statusCode === 404);
check('and answers with it', (await ask({ op: 'table.rows', name: 'leads', token: viewToken(APP, 'u1') })).statusCode === 200);
check('a read-only link refuses a write',
      (await ask({ op: 'table.add', name: 'leads', row: {}, token: viewToken(APP, 'u1') })).statusCode === 403);

/* ── delete ─────────────────────────────────────────────────────────────── */
check('deleting an app takes it off the air',
      (await call(appHandler, 'DELETE', { id: APP }, null, session)).statusCode === 204 && (await get('/a/leads-desk/')).statusCode === 404);

console.log(`\n${failed ? `${failed} FAILURE(S)` : 'all green'}`);
process.exit(failed ? 1 : 0);
