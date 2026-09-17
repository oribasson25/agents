/** Exercises GET /api/agents/:id/files and PUT, including every refusal path. */
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const { default: handler } = await import(`${ROOT}/api/agents/[id]/files.js`);
const { agentVersion } = await import(`${ROOT}/api/_agentFiles.js`);
const { createToken, hashToken } = await import(`${ROOT}/api/_auth.js`);

const AGENT = {
  id: 'a1', name: 'ביטוח רכב', avatar: '🚗', openingMessage: 'שלום',
  basePrompt: '## Role\nOriginal prompt.\n',
  skills: [{ id: 's1', name: 'Pricing', description: 'quotes', prompt: '# Pricing\n' }],
  tools: [{ id: 't1', name: 'fetch_quote', description: 'quote', parameters: [],
            packages: 'requests', envVars: [{ key: 'QUOTE_KEY', value: 'SECRET-VALUE' }],
            code: 'def run(**k):\n    pass\n' }],
  apiConfig: { provider: 'claude', apiKey: 'SECRET-KEY', model: 'claude-sonnet-4-5' },
  dlp: { creditCard: false, israeliId: false }, scrapeUrls: [], emailEnabled: false,
  whatsapp: { enabled: true, phoneNumberId: '99999', accessToken: 'SECRET-WA',
              appSecret: 'SECRET-APP', verifyToken: 'SECRET-VERIFY' },
  createdAt: '2026-01-01T00:00:00.000Z',
};

const { token, hash } = createToken();
let stored = JSON.parse(JSON.stringify(AGENT));
let updates = 0;

globalThis.__db = (text, params) => {
  if (text.includes('from api_tokens t join users u')) {
    return params[0] === hash ? [{ id: 'tok1', user_id: 'u1', username: 'ori', is_admin: false }] : [];
  }
  if (text.includes('update api_tokens set last_used_at')) return [];
  /* loadAgent's ownership check, and the main-branch read behind it. */
  if (text.includes('select data, user_id from agents')) {
    return params[0] === stored.id ? [{ data: stored, user_id: 'u1' }] : [];
  }
  if (text.includes('from agent_branches')) return [];
  if (text.includes('update agents set data')) { updates++; stored = JSON.parse(params[0]); return []; }
  throw new Error('unexpected query: ' + text.slice(0, 70));
};

function call(method, query, body, auth = `Bearer ${token}`) {
  const res = { statusCode: 200, payload: undefined,
    status(c) { this.statusCode = c; return this; },
    json(v) { this.payload = v; return this; },
    end() { return this; } };
  return Promise.resolve(handler({ method, query, body, headers: { authorization: auth } }, res)).then(() => res);
}

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail && !ok ? `\n    ${detail}` : ''}`);
  if (!ok) failed++;
};

/* pull */
const pulled = await call('GET', { id: 'a1' });
check('pull returns the file tree', pulled.statusCode === 200 && !!pulled.payload.files,
      JSON.stringify(pulled.payload).slice(0, 120));
const files = pulled.payload.files;
const version = pulled.payload.version;
check('pull carries a version', version === agentVersion(stored));
const blob = Object.values(files).join('\n');
check('no secret in the pulled files',
      !['SECRET-KEY', 'SECRET-VALUE', 'SECRET-WA', 'SECRET-APP', 'SECRET-VERIFY', '99999'].some(s => blob.includes(s)));

/* auth */
check('no token -> 401', (await call('GET', { id: 'a1' }, null, '')).statusCode === 401);
check('bad token -> 401', (await call('GET', { id: 'a1' }, null, 'Bearer 8legs_pat_wrong')).statusCode === 401);
const other = await call('GET', { id: 'someone-elses' });
check("another user's agent -> 404", other.statusCode === 404);

/* push: the happy path */
const edited = { ...files, 'prompt.md': '## Role\nEdited in the IDE.\n' };
const pushed = await call('PUT', { id: 'a1' }, { baseVersion: version, files: edited });
check('push applies the edit', pushed.statusCode === 200 && stored.basePrompt === '## Role\nEdited in the IDE.\n',
      `status ${pushed.statusCode}, prompt ${JSON.stringify(stored.basePrompt)}`);
check('push kept the api key', stored.apiConfig.apiKey === 'SECRET-KEY');
check('push kept the whatsapp number and tokens',
      stored.whatsapp.phoneNumberId === '99999' && stored.whatsapp.accessToken === 'SECRET-WA');
check('push kept the tool env value', stored.tools[0].envVars[0].value === 'SECRET-VALUE');
check('push kept createdAt', stored.createdAt === '2026-01-01T00:00:00.000Z');

/* push: every refusal must leave the agent untouched */
const before = JSON.stringify(stored);
const wasUpdates = updates;

const stale = await call('PUT', { id: 'a1' }, { baseVersion: version, files: edited });
check('stale baseVersion -> 409', stale.statusCode === 409);

const broken = await call('PUT', { id: 'a1' },
  { baseVersion: agentVersion(stored), files: { ...files, 'config.json': '{ not json' } });
check('broken config.json -> 422', broken.statusCode === 422 && /config\.json/.test(String(broken.payload.errors)),
      JSON.stringify(broken.payload));

const noPrompt = { ...files };
delete noPrompt['prompt.md'];
const missing = await call('PUT', { id: 'a1' }, { baseVersion: agentVersion(stored), files: noPrompt });
check('missing prompt.md -> 422', missing.statusCode === 422);

const noId = await call('PUT', { id: 'a1' },
  { baseVersion: agentVersion(stored), files: { ...files, 'skills/pricing/skill.json': '{"name":"pricing"}' } });
check('skill without an id -> 422', noId.statusCode === 422);

check('no refusal wrote to the database', updates === wasUpdates && JSON.stringify(stored) === before,
      `updates ${wasUpdates} -> ${updates}`);

/* a push cannot move the agent to another id */
const hijack = JSON.parse(files['config.json']);
hijack.profile.id = 'someone-elses-agent';
const moved = await call('PUT', { id: 'a1' },
  { baseVersion: agentVersion(stored), files: { ...files, 'config.json': JSON.stringify(hijack) } });
check('a push cannot change the agent id', moved.statusCode === 200 && stored.id === 'a1');

console.log(`\n${failed ? `${failed} FAILURE(S)` : 'all green'}`);
process.exit(failed ? 1 : 0);
