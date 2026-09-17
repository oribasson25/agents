/**
 * Branches, against a small in-memory stand-in for the two tables involved.
 *
 * The things worth proving here are the ones that damage something when they
 * are wrong: that editing in the browser cannot move the live agent, that a
 * merge cannot carry a WhatsApp number out of a branch, and that a person in
 * the middle of a conversation never changes branch under them.
 */
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const B = await import(`${ROOT}/api/_branches.js`);

const USER = { userId: 'u1', isAdmin: false };
const AGENT_ID = 'a1';
let agents, branches, sessions;

function reset() {
  agents = [{ id: AGENT_ID, user_id: 'u1', data: {
    id: AGENT_ID, name: 'car-insurance', basePrompt: 'main prompt',
    skills: [{ id: 's1', name: 'Pricing', prompt: 'p' }], tools: [],
    apiConfig: { provider: 'claude', apiKey: 'MAIN-KEY' },
    whatsapp: { enabled: true, phoneNumberId: '111', accessToken: 'MAIN-WA',
                appSecret: 'MAIN-APP', verifyToken: 'MAIN-VERIFY' },
    createdAt: '2026-01-01T00:00:00.000Z',
  } }];
  branches = [];
  sessions = [];
}

/* A router over the statements _branches.js actually issues. */
globalThis.__db = (text, p) => {
  const t = text.replace(/\s+/g, ' ').trim();
  const open = () => branches.filter(b => b.agent_id === AGENT_ID && !b.merged_at);

  if (t.startsWith('select data, user_id from agents'))
    return agents.filter(a => a.id === p[0] && (a.user_id === p[1] || p[2] === true));
  if (t.startsWith('select data from agents')) return agents.filter(a => a.id === p[0]);

  if (t.includes('from agent_branches where agent_id = ? and merged_at is null and (id = ? or lower(name)'))
    return open().filter(b => b.id === p[1] || b.name.toLowerCase() === String(p[2]).toLowerCase());
  if (t.includes("where agent_id = ? and kind = 'draft' and merged_at is null"))
    return open().filter(b => b.kind === 'draft');
  if (t.includes('where agent_id = ? and merged_at is null order by'))
    return open().slice().sort((a, b) => (b.kind === 'draft') - (a.kind === 'draft'));
  if (t.includes("merged_at is null and kind = 'branch' and traffic_weight > 0"))
    return open().filter(b => b.kind === 'branch' && b.traffic_weight > 0);
  if (t.includes('where id = ? and agent_id = ? and merged_at is null'))
    return open().filter(b => b.id === p[0]);
  if (t.includes('coalesce(sum(traffic_weight), 0)'))
    return [{ other: open().filter(b => b.id !== p[1]).reduce((n, b) => n + b.traffic_weight, 0) }];

  if (t.startsWith('insert into agent_branches')) {
    branches.push({ id: p[0], agent_id: p[1], name: p[2], kind: p[3], data: JSON.parse(p[4]),
                    base_version: p[5], created_by: p[6], traffic_weight: 0, merged_at: null });
    return [];
  }
  if (t.startsWith('update agents set data')) {
    agents[0].data = JSON.parse(p[0]);
    return [];
  }
  if (t.startsWith('update agent_branches set data')) {
    Object.assign(branches.find(b => b.id === p[1]), { data: JSON.parse(p[0]) });
    return [];
  }
  if (t.startsWith('update agent_branches set merged_at')) {
    Object.assign(branches.find(b => b.id === p[0]), { merged_at: new Date(), traffic_weight: 0 });
    return [];
  }
  if (t.startsWith('update agent_branches set traffic_weight = ?,')) {
    Object.assign(branches.find(b => b.id === p[1]), { traffic_weight: p[0] });
    return [];
  }
  if (t.startsWith('update agent_branches set traffic_weight = 0')) {
    const hit = open().filter(b => b.traffic_weight > 0);
    hit.forEach(b => { b.traffic_weight = 0; });
    return hit.map(b => ({ name: b.name }));
  }
  if (t.startsWith('delete from agent_branches')) {
    branches = branches.filter(b => b.id !== p[0]);
    return [];
  }
  if (t.startsWith('select branch_id from chat_sessions')) {
    const s = sessions.find(x => x.id === p[0]);
    return s ? [{ branch_id: s.branch_id }] : [];
  }
  if (t.startsWith('update chat_sessions set branch_id = null')) {
    const stale = sessions.filter(s => s.branch_id && s.idle);
    stale.forEach(s => { s.branch_id = null; });
    return stale.map(s => ({ id: s.id }));
  }
  throw new Error('unrouted query: ' + t.slice(0, 90));
};

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && detail ? `\n    ${detail}` : ''}`);
  if (!ok) failed++;
};

/* ── the draft ───────────────────────────────────────────────────────────── */
reset();
const draft = await B.getOrCreateDraft(AGENT_ID, USER);
check('a draft is made on first edit', !!draft && draft.created);
await B.saveAgent({ agentId: AGENT_ID, user: USER, branch: draft.id,
                    data: { ...draft.data, basePrompt: 'edited in the browser' } });
check('editing the draft does not move the live agent', agents[0].data.basePrompt === 'main prompt',
      agents[0].data.basePrompt);
const again = await B.getOrCreateDraft(AGENT_ID, USER);
check('there is only ever one draft', !again.created && again.id === draft.id);
await B.mergeBranch({ agentId: AGENT_ID, user: USER, branch: draft.id });
check('publishing moves it to the live agent', agents[0].data.basePrompt === 'edited in the browser');
check('and closes the draft', !branches.find(b => b.kind === 'draft' && !b.merged_at));

/* ── a branch, and what a merge may not carry ────────────────────────────── */
reset();
await B.createBranch({ agentId: AGENT_ID, user: USER, name: 'warmer-tone' });
const loaded = await B.loadAgent({ agentId: AGENT_ID, user: USER, branch: 'warmer-tone' });
check('a branch starts as a copy of main', loaded.agent.basePrompt === 'main prompt');
await B.saveAgent({ agentId: AGENT_ID, user: USER, branch: 'warmer-tone', data: {
  ...loaded.agent, basePrompt: 'warmer prompt',
  apiConfig: { provider: 'claude', apiKey: 'BRANCH-KEY' },
  whatsapp: { enabled: true, phoneNumberId: '999', accessToken: 'BRANCH-WA',
              appSecret: 'BRANCH-APP', verifyToken: 'BRANCH-VERIFY' },
  createdAt: '2020-01-01T00:00:00.000Z', id: 'hijacked',
} });
await B.mergeBranch({ agentId: AGENT_ID, user: USER, branch: 'warmer-tone' });
const live = agents[0].data;
check('a merge brings the prompt', live.basePrompt === 'warmer prompt');
check('a merge cannot take a WhatsApp number', live.whatsapp.phoneNumberId === '111', live.whatsapp.phoneNumberId);
check('a merge cannot take WhatsApp credentials',
      live.whatsapp.accessToken === 'MAIN-WA' && live.whatsapp.appSecret === 'MAIN-APP');
check('a merge cannot change the API key', live.apiConfig.apiKey === 'MAIN-KEY');
check('a merge cannot change the agent id', live.id === AGENT_ID);
check('a merge cannot rewrite createdAt', live.createdAt === '2026-01-01T00:00:00.000Z');

/* ── names ──────────────────────────────────────────────────────────────── */
reset();
await B.createBranch({ agentId: AGENT_ID, user: USER, name: 'exp' });
const dup = await B.createBranch({ agentId: AGENT_ID, user: USER, name: 'EXP' }).catch(e => e);
check('a duplicate name is refused, case included', dup.code === 'EXISTS');
for (const reserved of ['main', 'Draft']) {
  const e = await B.createBranch({ agentId: AGENT_ID, user: USER, name: reserved }).catch(x => x);
  check(`"${reserved}" is reserved`, e.code === 'BAD_NAME');
}

/* ── traffic ────────────────────────────────────────────────────────────── */
reset();
await B.createBranch({ agentId: AGENT_ID, user: USER, name: 'a' });
await B.createBranch({ agentId: AGENT_ID, user: USER, name: 'b' });
const set = await B.setTraffic({ agentId: AGENT_ID, user: USER, branch: 'a', weight: 30 });
check('a weight is set, and main keeps the rest', set.traffic_weight === 30 && set.main === 70);
const over = await B.setTraffic({ agentId: AGENT_ID, user: USER, branch: 'b', weight: 80 }).catch(e => e);
check('weights cannot add up past 100', over.code === 'OVER_100', over.message);
await B.getOrCreateDraft(AGENT_ID, USER);
const onDraft = await B.setTraffic({ agentId: AGENT_ID, user: USER, branch: 'draft', weight: 10 }).catch(e => e);
check('a draft cannot take live traffic', onDraft.code === 'BAD_TARGET');

/* The draw has to land near the weight it was given. */
await B.setTraffic({ agentId: AGENT_ID, user: USER, branch: 'a', weight: 30 });
let hits = 0;
for (let i = 0; i < 4000; i++) if (await B.drawBranch(AGENT_ID)) hits++;
const pct = (hits / 4000) * 100;
check(`the draw honours the weight (${pct.toFixed(1)}% of 30%)`, Math.abs(pct - 30) < 3.5);

/* ── stickiness: the one thing a split must never get wrong ─────────────── */
const branchA = branches.find(b => b.name === 'a');
sessions.push({ id: 'sess-1', branch_id: branchA.id, idle: false });
const seen = new Set();
for (let i = 0; i < 200; i++) seen.add(await B.branchForSession(AGENT_ID, 'sess-1'));
check('an existing conversation never changes branch', seen.size === 1 && seen.has(branchA.id));

sessions.push({ id: 'sess-main', branch_id: null, idle: false });
const seenMain = new Set();
for (let i = 0; i < 200; i++) seenMain.add(await B.branchForSession(AGENT_ID, 'sess-main'));
check('a conversation already on main stays on main', seenMain.size === 1 && seenMain.has(null));

/* ── stopping ───────────────────────────────────────────────────────────── */
sessions.push({ id: 'sess-idle', branch_id: branchA.id, idle: true });
const stopped = await B.stopExperiments({ agentId: AGENT_ID, user: USER });
check('stop returns every weight to zero', stopped.stopped.includes('a'));
check('stop releases quiet conversations', stopped.released === 1);
check('stop leaves a live conversation alone', sessions.find(s => s.id === 'sess-1').branch_id === branchA.id);
check('nothing is drawn after a stop', (await B.drawBranch(AGENT_ID)) === null);

/* ── a branch that vanishes mid-conversation ────────────────────────────── */
const fallback = await B.loadForConversation(AGENT_ID, 'no-such-branch');
check('a deleted branch falls back to main rather than failing',
      fallback.branchId === null && fallback.agent.id === AGENT_ID);

/* ── someone else's agent ───────────────────────────────────────────────── */
const other = await B.loadAgent({ agentId: AGENT_ID, user: { userId: 'u2', isAdmin: false } });
check("another user cannot read the agent", other === null);

console.log(`\n${failed ? `${failed} FAILURE(S)` : 'all green'}`);
process.exit(failed ? 1 : 0);
