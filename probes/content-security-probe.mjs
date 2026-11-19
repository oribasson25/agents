/**
 * The attacks the code review found on content — tables, automations,
 * documents, chatbots, the nightly crawl and the CLI — tried, and refused.
 *
 *   node --import ./probes/stub-db.mjs probes/content-security-probe.mjs
 *
 * Each check is the attack as it was described, and what must happen instead.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && detail ? `\n    ${detail}` : ''}`);
  if (!ok) failed++;
};

/* ── the world: one organization, an admin and a member who may only look ── */
const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const world = {
  users: { admin: { org: 'o1', role: 'admin' }, viewer: { org: 'o1', role: 'member', access: 'view' } },
  item: (kind, id) => {
    if (kind === 'agent' && id === AGENT_ID) return { org: 'o1', user: 'admin' };
    if (kind === 'agent' && id === 'other-agent') return { org: 'o1', user: 'admin' };
    if (kind === 'table' && ['t-hr', 't-leads'].includes(id)) return { org: 'o1', user: 'admin' };
    if (kind === 'automation' && id === 'auto-1') return { org: 'o1', user: 'admin' };
    return null;
  },
  grants: [
    { user: 'viewer', kind: 'table', item: 't-hr', level: 'none' },
    { user: 'viewer', kind: 'table', item: 't-leads', level: 'view' },
  ],
};
const { accessStub } = await import('./access-stub.mjs');
const access = accessStub(world);

const AGENT = {
  id: AGENT_ID, name: 'Sales', tables: ['t-leads'], automations: ['auto-1'],
  tools: [{ id: 'tool1', name: 'quote', envVars: [{ key: 'API_KEY', value: 'TOOL-SECRET' }], code: 'pass' }],
  whatsapp: { enabled: true, phoneNumberId: '555', accessToken: 'WA-SECRET', appSecret: 'APP-SECRET', verifyToken: 'VERIFY-SECRET' },
};
const db = {
  agentData: { [AGENT_ID]: structuredClone(AGENT), 'other-agent': { id: 'other-agent', name: 'Other' } },
  tablesSeen: [], runsStarted: 0, docs: new Map(), inserts: [], agentsInserted: [],
};

globalThis.__db = (text, p) => {
  const answered = access(text, p);
  if (answered !== undefined) return answered;
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (t.startsWith('select a.data as main, coalesce((select jsonb_agg(b.data)')) {
    const d = db.agentData[p[0]];
    return d ? [{ main: d, branches: [] }] : [];
  }
  /* tablesForAgent: whatever ids reach SQL are recorded */
  if (t.startsWith('select t.id, t.org_id, t.name, t.description')) {
    db.tablesSeen.push([...(p[1] || [])]);
    return (p[1] || []).map(id => ({ id, org_id: 'o1', name: id, description: '', columns: [{ key: 'name', name: 'name', type: 'text' }], row_count: 0 }));
  }
  if (t.startsWith('select * from automations where org_id')) {
    return (p[1] || []).map(id => ({ id, org_id: 'o1', data: { name: id }, published: { name: id, trigger: { type: 'manual' } }, enabled: true }));
  }
  if (t.startsWith('insert into data_table_rows')) return [];
  if (t.startsWith('update data_tables set updated_at')) return [];
  if (t.startsWith('select id, data, written_by')) return [];
  if (t.startsWith('select count(*)::int as total')) return [{ total: 0 }];
  /* documents */
  if (t.startsWith('insert into documents (id, agent_id, skill_id, title, content, raw_content, normalized, source_type, source_url)')) {
    const [id, agentId] = p;
    const had = db.docs.get(id);
    if (had && had.agent_id !== agentId) return [];
    db.docs.set(id, { id, agent_id: agentId, content: p[4] });
    return [{ id, agent_id: agentId, skill_id: null, title: p[3], content: p[4], normalized: false, created_at: 'now', inserted: !had }];
  }
  if (t.startsWith('insert into documents') || t.startsWith('with gone as (delete from documents')) { db.inserts.push(t); return []; }
  if (t.startsWith('delete from documents where parent_id')) { db.inserts.push(t); return []; }
  if (t.includes('error_log')) return [];
  if (t.includes('from automations a')) return [];   /* row-added triggers: none here */
  if (t.startsWith("select coalesce(s.assistant_language, 'en')")) return [];   /* no model: documents are stored as they came */
  /* agents */
  if (t.startsWith('select a.id, a.org_id, a.data, (select b.data from agent_branches')) {
    return Object.entries(db.agentData).map(([id, data]) => ({ id, org_id: 'o1', data, draft: null }));
  }
  if (t.startsWith('select a.data, (select b.id from agent_branches')) {
    const d = db.agentData[p[0]];
    return d ? [{ data: d, draft_id: null, draft: null }] : [];
  }
  if (t.startsWith("select id from agents where data->'whatsapp'->>'phoneNumberId'")) return [];
  if (t.startsWith('insert into agents (id, data, user_id)')) {
    if (db.agentData[p[0]]) return [];
    db.agentData[p[0]] = JSON.parse(p[1]);
    db.agentsInserted.push(p[0]);
    return [{ id: p[0] }];
  }
  if (t.startsWith('select data, user_id from agents where id')) {
    const d = db.agentData[p[0]];
    return d ? [{ data: d, user_id: 'admin' }] : [];
  }
  if (t.startsWith('select id, name, data from agent_branches')) return [];
  if (t.startsWith('select id, name, kind, data, base_version')) return [];
  if (t.startsWith('update agents set data')) { db.agentData[p[1]] = JSON.parse(p[0]); return []; }
  throw new Error('unrouted: ' + t.slice(0, 100));
};

/* The automation tool would start real runs; count them instead. */
const { signJWT } = await import(`${ROOT}/api/_auth.js`);
const sessionOf = (userId) => `Bearer ${signJWT({ userId, username: userId, isAdmin: false })}`;
function call(handler, method, query, body, userId) {
  const res = { statusCode: 200, payload: undefined, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(v) { this.payload = v; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(v) { this.body = v; return this; } };
  const req = { method, query: query || {}, body, headers: { authorization: userId ? sessionOf(userId) : '', host: 'www.8legs.world' } };
  return Promise.resolve(handler(req, res)).then(() => res);
}

/* ── R1: the test chat's table and automation tools ───────────────────────── */
const { default: tablesTool } = await import(`${ROOT}/api/agents/[id]/tables.js`);
const { default: automationsTool } = await import(`${ROOT}/api/agents/[id]/automations.js`);

db.tablesSeen = [];
await call(tablesTool, 'POST', { id: AGENT_ID }, { tool: 'table_find', inputs: { table: 't-hr' }, tables: ['t-hr', 't-leads'] }, 'viewer');
check('a table not ticked on the chatbot is cut from the list the browser sends',
      !db.tablesSeen.flat().includes('t-hr'), JSON.stringify(db.tablesSeen));
db.tablesSeen = [];
await call(tablesTool, 'POST', { id: AGENT_ID }, { tool: 'table_find', inputs: { table: 't-hr' }, tables: ['t-hr'] }, 'viewer');
check('a table the member was given no access to is never reached', db.tablesSeen.length === 0, JSON.stringify(db.tablesSeen));
db.tablesSeen = [];
const viewRead = await call(tablesTool, 'POST', { id: AGENT_ID }, { tool: 'table_find', inputs: { table: 't-leads' }, tables: ['t-leads'] }, 'viewer');
check('a table they may view, ticked on the chatbot, can be read in the test chat',
      viewRead.statusCode === 200 && db.tablesSeen.flat().includes('t-leads'), JSON.stringify(viewRead.payload));
db.tablesSeen = [];
const viewWrite = await call(tablesTool, 'POST', { id: AGENT_ID }, { tool: 'table_add_row', inputs: { table: 't-leads', row: { name: 'x' } }, tables: ['t-leads'] }, 'viewer');
check('but not written to with view access', db.tablesSeen.length === 0 && /No tables/.test(viewWrite.payload?.result || ''), JSON.stringify(viewWrite.payload));
db.tablesSeen = [];
await call(tablesTool, 'POST', { id: AGENT_ID }, { tool: 'table_add_row', inputs: { table: 't-leads', row: { name: 'x' } }, tables: ['t-leads'] }, 'admin');
check('the admin can, as the chatbot would', db.tablesSeen.flat().includes('t-leads'));

const runView = await call(automationsTool, 'POST', { id: AGENT_ID }, { tool: 'automation_run', inputs: { name: 'auto-1' }, automations: ['auto-1', 'auto-x'] }, 'viewer');
check('a member who may only view cannot run an automation from the test chat',
      /no automation called/i.test(runView.payload?.result || ''), JSON.stringify(runView.payload));

/* ── R10: a document id belonging to another chatbot ──────────────────────── */
const { default: documents } = await import(`${ROOT}/api/agents/[id]/documents.js`);
db.docs.set('doc-of-other', { id: 'doc-of-other', agent_id: 'other-agent', content: 'their knowledge' });
const hijack = await call(documents, 'POST', { id: AGENT_ID }, { docId: 'doc-of-other', title: 'x', content: 'attacker text' }, 'admin');
check("uploading with another chatbot's document id -> 409, and theirs is untouched",
      hijack.statusCode === 409 && db.docs.get('doc-of-other').content === 'their knowledge' && db.docs.get('doc-of-other').agent_id === 'other-agent',
      JSON.stringify(hijack.payload));
const fresh = await call(documents, 'POST', { id: AGENT_ID }, { docId: 'new-doc', title: 'x', content: 'para one\n\n'.repeat(400) }, 'admin');
check('a new document is stored', fresh.statusCode === 201, JSON.stringify(fresh.payload).slice(0, 200));
check('and its chunks go in with one insert, without deleting anything first',
      db.inserts.length === 1 && /unnest/.test(db.inserts[0]) && !/delete/.test(db.inserts[0]), db.inserts.join(' | ').slice(0, 300));

/* ── #14: credentials are not handed to someone who may only look ────────── */
const { default: agentsList } = await import(`${ROOT}/api/agents.js`);
const { default: agentOne } = await import(`${ROOT}/api/agents/[id]/index.js`);
const listed = await call(agentsList, 'GET', {}, null, 'viewer');
const mine = (listed.payload || []).find(a => a.id === AGENT_ID);
const leak = JSON.stringify(listed.payload);
check('the list hides the WhatsApp tokens and tool secrets from a viewer',
      mine && !/WA-SECRET|APP-SECRET|VERIFY-SECRET|TOOL-SECRET/.test(leak) && mine.whatsapp.phoneNumberId === '555', leak.slice(0, 300));
const one = await call(agentOne, 'GET', { id: AGENT_ID }, null, 'viewer');
check('and so does one chatbot', !/WA-SECRET|APP-SECRET|TOOL-SECRET/.test(JSON.stringify(one.payload)) && one.payload.tools[0].envVars[0].key === 'API_KEY');
const asAdmin = await call(agentOne, 'GET', { id: AGENT_ID }, null, 'admin');
check('an editor still gets them (a save must keep them)', JSON.stringify(asAdmin.payload).includes('WA-SECRET'));

/* ── H6: the id in the stored JSON is always the row's own ────────────────── */
db.agentData[AGENT_ID].id = '../org/members/viewer#';
const pinned = await call(agentOne, 'GET', { id: AGENT_ID }, null, 'admin');
check('a planted id in the stored JSON is not what the browser is given', pinned.payload.id === AGENT_ID, pinned.payload.id);
const put = await call(agentOne, 'PUT', { id: AGENT_ID, branch: 'main' }, { ...AGENT, id: '../org/members/viewer#' }, 'admin');
check('and a save stores the row id whatever the body says', put.statusCode === 200 && db.agentData[AGENT_ID].id === AGENT_ID, JSON.stringify(db.agentData[AGENT_ID].id));
const badId = await call(agentsList, 'POST', {}, { id: '../org/members/x#', name: 'x' }, 'admin');
check('a new chatbot with an id that is not a UUID is refused', badId.statusCode === 400, JSON.stringify(badId.payload));
const noId = await call(agentsList, 'POST', {}, { name: 'fresh' }, 'admin');
check('one with no id gets a UUID', noId.statusCode === 201 && /^[0-9a-f-]{36}$/.test(noId.payload.id), JSON.stringify(noId.payload));
const dup = await call(agentsList, 'POST', {}, { id: AGENT_ID, name: 'again' }, 'admin');
check('and an id already taken is a 409, not a 500', dup.statusCode === 409);

/* ── R12: the nightly crawl does not run for strangers ───────────────────── */
const { default: crawlAll } = await import(`${ROOT}/api/cron/crawl-all.js`);
delete process.env.CRON_SECRET;
let r = await call(crawlAll, 'GET', {}, null, null);
check('without CRON_SECRET the crawl refuses everyone', r.statusCode === 500 || r.statusCode === 401, String(r.statusCode));
process.env.CRON_SECRET = 'cron-test';
r = await call(crawlAll, 'GET', {}, null, null);
check('with it, a caller without it is refused', r.statusCode === 401);
delete process.env.CRON_SECRET;

/* ── P4: the model pass runs a few slices at once, and stops at its budget ── */
{
  const { normalizeDocument } = await import(`${ROOT}/api/_knowledge.js`);
  const cfg = { provider: 'openrouter', ready: true, model: 'm', orgId: 'o1' };
  const big = Array.from({ length: 12 }, (_, i) => `Section ${i}\n\n${'word '.repeat(1900)}`).join('\n\n');
  let active = 0, peak = 0;
  const slow = async (_cfg, { user }) => {
    active++; peak = Math.max(peak, active);
    await new Promise(res => setTimeout(res, 30));
    active--;
    return `## ${user.slice(0, 40)}\n${'rewritten '.repeat(400)}`;
  };
  const okRun = await normalizeDocument({ title: 't', content: big, apiConfig: cfg, agentId: AGENT_ID, call: slow });
  check('slices go to the model four at a time, in their own order',
        okRun.normalized === true && peak === 4 && okRun.text.indexOf('part 1 of') < okRun.text.indexOf('part 2 of'),
        `peak ${peak}, normalized ${okRun.normalized} ${okRun.reason}`);
  const late = await normalizeDocument({ title: 't', content: big, apiConfig: cfg, agentId: AGENT_ID, budgetMs: 40,
    call: async () => { await new Promise(res => setTimeout(res, 100)); return 'x'.repeat(5000); } });
  check('past its time budget the original is kept, not lost', late.normalized === false && late.text === big, late.reason);
}

/* ── C6: the CLI never writes into .git, and never sends dotfiles ────────── */
{
  const { syncTree, readTree, reservedSegment } = await import(`${ROOT}/cli/src/workdir.js`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legs-cli-'));
  const refused = (files, previous = {}) => { try { syncTree(dir, previous, files); return false; } catch (e) { return !!e.friendly; } };
  check('a pulled .git/config is refused', refused({ '.git/config': '[core]\n\tfsmonitor = touch pwned' }));
  check('in any case and any depth', refused({ 'a/.GIT/hooks/post-checkout': 'x' }) && refused({ '.Git./config': 'x' }) && refused({ 'GIT~1/config': 'x' }));
  check('and .8legs too', refused({ '.8legs/lock.json': '{}' }));
  check('a tree with one bad path writes nothing at all',
        refused({ 'ok.txt': 'x', '.git/config': 'y' }) && !fs.existsSync(path.join(dir, 'ok.txt')));
  check('a delete named by the lock cannot leave the folder', refused({}, { '../outside.txt': 'h' }));
  check('nor reach into .git', refused({}, { '.git/HEAD': 'h' }));
  check('reserved names are judged like the filesystem judges them',
        reservedSegment('.git ') && reservedSegment('.git::$INDEX_ALLOCATION') && !reservedSegment('.github'));
  syncTree(dir, {}, { 'index.html': 'x', '.gitignore': '*.log\nsecret/\n' });
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(dir, 'debug.log'), 'x');
  fs.mkdirSync(path.join(dir, 'secret'));
  fs.writeFileSync(path.join(dir, 'secret', 'k.txt'), 'x');
  const sent = Object.keys(readTree(dir)).sort();
  check('a push sends neither dotfiles nor what .gitignore leaves out', JSON.stringify(sent) === JSON.stringify(['.gitignore', 'index.html']), JSON.stringify(sent));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failed ? `${failed} FAILURE(S)` : 'all green'}`);
process.exit(failed ? 1 : 0);
