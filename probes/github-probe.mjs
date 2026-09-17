/**
 * The git-as-a-real-remote path.
 *
 * A push cannot be rejected after git has taken it, so the only thing standing
 * between a bad commit and a broken live agent is this handler declining to
 * apply it. That is what most of this checks.
 */
import crypto from 'crypto';
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

process.env.GITHUB_WEBHOOK_SECRET = 'test-secret';
process.env.GITHUB_AGENTS_TOKEN = 'test-token';
process.env.GITHUB_AGENTS_ORG = '8legs-agents';
process.env.APP_URL = 'https://www.8legs.world';

const GH = await import(`${ROOT}/api/_github.js`);
const { agentToFiles } = await import(`${ROOT}/api/_agentFiles.js`);
const { default: webhook } = await import(`${ROOT}/api/github/webhook.js`);

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && detail ? `\n    ${detail}` : ''}`);
  if (!ok) failed++;
};

/* ── names and signatures ───────────────────────────────────────────────── */
check('a Hebrew agent name still makes a legal repo name',
      /^[a-z0-9-]+$/.test(GH.repoName({ id: '804fe690-c8b6', name: 'ביטוח רכב' })));
check('two agents with the same name get different repos',
      GH.repoName({ id: 'aaaaaaaa-1', name: 'Support' }) !== GH.repoName({ id: 'bbbbbbbb-2', name: 'Support' }));

const body = Buffer.from(JSON.stringify({ hello: 'world' }));
const good = 'sha256=' + crypto.createHmac('sha256', 'test-secret').update(body).digest('hex');
check('a correct signature verifies', GH.verifyWebhook(body, good, 'test-secret'));
check('a wrong signature does not', !GH.verifyWebhook(body, 'sha256=' + 'a'.repeat(64), 'test-secret'));
check('a missing signature does not', !GH.verifyWebhook(body, undefined, 'test-secret'));
check('a tampered body does not', !GH.verifyWebhook(Buffer.from('{"hello":"there"}'), good, 'test-secret'));

/* ── the webhook ────────────────────────────────────────────────────────── */
const AGENT = {
  id: 'a1', name: 'car-insurance', basePrompt: 'the live prompt',
  skills: [], tools: [], apiConfig: { provider: 'claude', apiKey: 'LIVE-KEY' },
  dlp: { creditCard: false, israeliId: false }, scrapeUrls: [], emailEnabled: false,
  whatsapp: { enabled: false, phoneNumberId: '', accessToken: '', appSecret: '', verifyToken: '' },
  createdAt: '2026-01-01T00:00:00.000Z',
};
let stored, lastSha, statuses, treeFiles;

function reset() {
  stored = structuredClone(AGENT);
  lastSha = 'sha-initial';
  statuses = [];
  treeFiles = agentToFiles(stored);
}

globalThis.__db = (text, p) => {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.startsWith('select r.agent_id, r.last_push_sha'))
    return p[0] === '8legs-agents' && p[1] === 'car-insurance-a1'
      ? [{ agent_id: 'a1', last_push_sha: lastSha, user_id: 'u1' }] : [];
  if (t.startsWith('select data, user_id from agents')) return [{ data: stored, user_id: 'u1' }];
  if (t.includes('from agent_branches')) return [];
  if (t.startsWith('update agents set data')) { stored = JSON.parse(p[0]); return []; }
  if (t.startsWith('update agent_repos set last_push_sha')) { lastSha = p[0]; return []; }
  if (t.startsWith('insert into error_log') || t.includes('error_log')) return [];
  throw new Error('unrouted: ' + t.slice(0, 80));
};

/* Stands in for the GitHub API: the tree read, and the status write. */
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
  if (/\/git\/trees\/[^/?]+\?recursive=1/.test(u)) {
    return ok({ truncated: false, tree: Object.keys(treeFiles).map(path => ({ path, type: 'blob', sha: `blob-${path}` })) });
  }
  if (/\/git\/blobs\/blob-/.test(u)) {
    const path = decodeURIComponent(u.split('/git/blobs/blob-')[1]);
    return ok({ encoding: 'base64', content: Buffer.from(treeFiles[path], 'utf8').toString('base64') });
  }
  if (/\/statuses\//.test(u)) { statuses.push(JSON.parse(opts.body)); return ok({}); }
  throw new Error('unexpected GitHub call: ' + u);
};

function deliver(payload, { sign = true } = {}) {
  const raw = Buffer.from(JSON.stringify(payload));
  const sig = 'sha256=' + crypto.createHmac('sha256', 'test-secret').update(raw).digest('hex');
  const req = Object.assign(
    (async function* () {})(),
    { method: 'POST', headers: { 'x-github-event': 'push', ...(sign ? { 'x-hub-signature-256': sig } : {}) } });
  /* The handler reads the raw body off the stream itself. */
  req.on = (ev, fn) => { if (ev === 'data') fn(raw); if (ev === 'end') fn(); return req; };
  const res = { statusCode: 200, payload: undefined,
    status(c) { this.statusCode = c; return this; },
    json(v) { this.payload = v; return this; },
    end() { return this; } };
  return Promise.resolve(webhook(req, res)).then(() => res);
}

const push = (sha, ref = 'refs/heads/main') => ({
  after: sha, ref,
  repository: { name: 'car-insurance-a1', owner: { login: '8legs-agents', name: '8legs-agents' } },
});

/* A valid push goes live. */
reset();
treeFiles['prompt.md'] = 'pushed from an editor';
let r = await deliver(push('sha-1'));
check('a valid push is applied', r.payload?.applied === true && stored.basePrompt === 'pushed from an editor',
      JSON.stringify(r.payload));
check('and the commit is marked success', statuses.at(-1)?.state === 'success', JSON.stringify(statuses.at(-1)));

/* A broken tree changes nothing. */
reset();
const before = JSON.stringify(stored);
treeFiles['config.json'] = '{ not json at all';
r = await deliver(push('sha-2'));
check('a commit that does not parse is not applied', r.payload?.applied === false);
check('and the live agent is untouched', JSON.stringify(stored) === before);
check('and the commit is marked failed', statuses.at(-1)?.state === 'failure', JSON.stringify(statuses.at(-1)));
check('the failure says what was wrong', /config\.json/.test(statuses.at(-1)?.description || ''),
      statuses.at(-1)?.description);

/* A missing prompt is the same story. */
reset();
delete treeFiles['prompt.md'];
r = await deliver(push('sha-3'));
check('a commit missing prompt.md is not applied', r.payload?.applied === false && stored.basePrompt === 'the live prompt');

/* Secrets cannot be set from git. */
reset();
const cfg = JSON.parse(treeFiles['config.json']);
cfg.behavior.channels.chat.connections.whatsapp = { enabled: true, phone_number_id: '666666' };
treeFiles['config.json'] = JSON.stringify(cfg);
await deliver(push('sha-4'));
check('git cannot set a WhatsApp number', stored.whatsapp.phoneNumberId === '', stored.whatsapp.phoneNumberId);
check('git cannot touch the API key', stored.apiConfig.apiKey === 'LIVE-KEY');

/* The platform's own mirrored commit must not come back in. */
reset();
treeFiles['prompt.md'] = 'this should be ignored';
r = await deliver(push(lastSha));
check("the platform's own push is not applied back",
      r.payload?.skipped === 'own push' && stored.basePrompt === 'the live prompt');

/* Unsigned deliveries are not ours. */
reset();
r = await deliver(push('sha-5'), { sign: false });
check('an unsigned delivery is rejected', r.statusCode === 401 && stored.basePrompt === 'the live prompt');

/* A branch deletion is not a change. */
reset();
r = await deliver(push('0000000000000000000000000000000000000000'));
check('a deleted branch is ignored', r.statusCode === 204);

/* An unknown repository is not silently applied to something. */
reset();
r = await deliver({ ...push('sha-6'), repository: { name: 'someone-elses', owner: { login: 'x', name: 'x' } } });
check('an unlinked repository is refused', r.statusCode === 404);

/* ── a repository made before the webhook secret existed ────────────────── */
{
  let repoRow = { owner: '8legs-agents', repo: 'car-insurance-a1', webhook_id: null };
  const hookCalls = [];
  const prevDb = globalThis.__db, prevFetch = globalThis.fetch;
  globalThis.__db = (text, p) => {
    const t = text.replace(/\s+/g, ' ').trim();
    if (t.startsWith('select owner, repo, webhook_id from agent_repos')) return [repoRow];
    if (t.startsWith('update agent_repos set webhook_id')) { repoRow.webhook_id = p[0]; return []; }
    return prevDb(text, p);
  };
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const ok = (b) => ({ ok: true, status: 200, text: async () => JSON.stringify(b) });
    if (/\/repos\/[^/]+\/[^/]+\/hooks$/.test(u) && (!opts.method || opts.method === 'GET')) return ok([]);
    if (/\/hooks$/.test(u) && opts.method === 'POST') { hookCalls.push(JSON.parse(opts.body)); return ok({ id: 4242 }); }
    if (/\/repos\/[^/]+\/[^/?]+$/.test(u)) return ok({ html_url: 'https://github.com/x/y', pushed_at: '2026-01-01' });
    return prevFetch(url, opts);
  };

  const link = await GH.ensureAgentRepo({ agent: AGENT, files: {}, appUrl: 'https://www.8legs.world' });
  check('a repo with no hook gets one on a later pull', repoRow.webhook_id === 4242, JSON.stringify(repoRow));
  check('and the hook points at this platform',
        hookCalls[0]?.config?.url === 'https://www.8legs.world/api/github/webhook', JSON.stringify(hookCalls[0]));
  check('and the pull still returns the clone url', /car-insurance-a1\.git$/.test(link?.cloneUrl || ''), link?.cloneUrl);

  globalThis.__db = prevDb;
  globalThis.fetch = prevFetch;
}

console.log(`\n${failed ? `${failed} FAILURE(S)` : 'all green'}`);
process.exit(failed ? 1 : 0);
