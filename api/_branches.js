/**
 * Branches of an agent.
 *
 * `main` is `agents.data` — the live agent, unchanged from before any of this
 * existed. Everything else is a row in `agent_branches` carrying its own copy
 * of the same blob. So every read goes through one function, loadAgent, and an
 * agent with no branches takes exactly the path it always took.
 *
 * The draft deserves a word. Editing in the browser writes to a branch of kind
 * 'draft', not to main, so the live agent never changes half-way through
 * someone typing. There is at most one draft per agent — the alternative,
 * a branch per save, buries the merge screen in forty branches by Friday.
 */
import crypto from 'crypto';
import { sql } from './_db.js';
import { agentVersion } from './_agentFiles.js';

export const MAIN = 'main';

const isMain = (ref) => !ref || ref === MAIN;

/** The agent the caller owns, or null. Admins may read anyone's. */
async function ownedAgent(agentId, user) {
  const [row] = await sql`
    select data, user_id from agents
    where id = ${agentId} and (user_id = ${user.userId} or ${!!user.isAdmin})
  `;
  return row || null;
}

/** A branch by name or id, still open. */
async function findBranch(agentId, ref) {
  const [row] = await sql`
    select id, name, kind, data, base_version, traffic_weight, created_at, updated_at
    from agent_branches
    where agent_id = ${agentId} and merged_at is null
      and (id = ${ref} or lower(name) = lower(${ref}))
  `;
  return row || null;
}

/**
 * The agent as a given branch sees it.
 *
 * Returns null when the agent is not the caller's, and throws a tagged error
 * when the agent exists but the branch does not — the two are different
 * answers and a caller needs to tell them apart.
 */
export async function loadAgent({ agentId, user, branch = MAIN }) {
  const owned = await ownedAgent(agentId, user);
  if (!owned) return null;
  if (isMain(branch)) {
    return { agent: owned.data, branch: MAIN, branchId: null, version: agentVersion(owned.data) };
  }
  const row = await findBranch(agentId, branch);
  if (!row) throw Object.assign(new Error(`No branch called "${branch}"`), { code: 'NO_BRANCH' });
  return { agent: row.data, branch: row.name, branchId: row.id, kind: row.kind, version: agentVersion(row.data) };
}

/** Writes the agent back to whichever branch it came from. */
export async function saveAgent({ agentId, user, branch = MAIN, data }) {
  const owned = await ownedAgent(agentId, user);
  if (!owned) return null;
  if (isMain(branch)) {
    await sql`
      update agents set data = ${JSON.stringify(data)}::jsonb, updated_at = now()
      where id = ${agentId} and (user_id = ${user.userId} or ${!!user.isAdmin})
    `;
    return { branch: MAIN, branchId: null, version: agentVersion(data) };
  }
  const row = await findBranch(agentId, branch);
  if (!row) throw Object.assign(new Error(`No branch called "${branch}"`), { code: 'NO_BRANCH' });
  await sql`
    update agent_branches set data = ${JSON.stringify(data)}::jsonb, updated_at = now()
    where id = ${row.id}
  `;
  return { branch: row.name, branchId: row.id, version: agentVersion(data) };
}

export async function listBranches(agentId, user) {
  const owned = await ownedAgent(agentId, user);
  if (!owned) return null;
  const rows = await sql`
    select id, name, kind, base_version, traffic_weight, created_at, updated_at
    from agent_branches
    where agent_id = ${agentId} and merged_at is null
    order by kind = 'draft' desc, created_at
  `;
  /* Live means "real conversations reach this version". That is main, and it
     is also any branch an experiment routes a share of the traffic to. */
  return [
    { id: null, name: MAIN, kind: 'main', live: true,
      traffic_weight: 100 - rows.reduce((n, r) => n + r.traffic_weight, 0),
      version: agentVersion(owned.data) },
    ...rows.map(r => ({ ...r, live: r.traffic_weight > 0 })),
  ];
}

/**
 * Opens a branch from another branch's current content.
 *
 * `main` and `draft` are reserved: main is the live agent and draft is the
 * interface's, and a branch shadowing either would make "which one is this"
 * unanswerable in every screen that shows a name.
 */
export async function createBranch({ agentId, user, name, from = MAIN, kind = 'branch' }) {
  const clean = String(name || '').trim();
  if (!clean) throw Object.assign(new Error('A branch needs a name'), { code: 'BAD_NAME' });
  if (kind === 'branch' && /^(main|draft)$/i.test(clean)) {
    throw Object.assign(new Error(`"${clean}" is reserved`), { code: 'BAD_NAME' });
  }
  const source = await loadAgent({ agentId, user, branch: from });
  if (!source) return null;
  if (await findBranch(agentId, clean)) {
    throw Object.assign(new Error(`A branch called "${clean}" is already open`), { code: 'EXISTS' });
  }
  const id = crypto.randomUUID();
  await sql`
    insert into agent_branches (id, agent_id, name, kind, data, base_version, created_by)
    values (${id}, ${agentId}, ${clean}, ${kind}, ${JSON.stringify(source.agent)}::jsonb,
            ${source.version}, ${user.userId})
  `;
  return { id, name: clean, kind, version: source.version, from: source.branch };
}

/** The interface's working copy, made on first edit rather than up front. */
export async function getOrCreateDraft(agentId, user) {
  const [existing] = await sql`
    select id, name, data from agent_branches
    where agent_id = ${agentId} and kind = 'draft' and merged_at is null
  `;
  if (existing) return { id: existing.id, name: existing.name, data: existing.data, created: false };
  const made = await createBranch({ agentId, user, name: 'draft', from: MAIN, kind: 'draft' });
  if (!made) return null;
  const loaded = await loadAgent({ agentId, user, branch: made.id });
  return { id: made.id, name: made.name, data: loaded.agent, created: true };
}

/**
 * Fields a branch may never carry into main.
 *
 * A WhatsApp number belongs to one agent at a time, platform-wide. If merging
 * could move one, a merge would be a way to take someone else's number, so the
 * number, its credentials and the account's API key always stay as main has
 * them regardless of what the branch says.
 */
export function mergeInto(main, branch) {
  return {
    ...branch,
    id: main.id,
    createdAt: main.createdAt,
    apiConfig: main.apiConfig,
    whatsapp: { ...(branch.whatsapp || {}), ...pickWhatsapp(main.whatsapp) },
    crawlConfig: branch.crawlConfig && main.crawlConfig
      ? { ...branch.crawlConfig, status: main.crawlConfig.status,
          lastCrawledAt: main.crawlConfig.lastCrawledAt, pagesCrawled: main.crawlConfig.pagesCrawled }
      : (branch.crawlConfig || main.crawlConfig),
  };
}

function pickWhatsapp(wa = {}) {
  const { phoneNumberId = '', accessToken = '', appSecret = '', verifyToken = '' } = wa;
  return { phoneNumberId, accessToken, appSecret, verifyToken };
}

/** Applies a branch to main and closes it. */
export async function mergeBranch({ agentId, user, branch }) {
  const owned = await ownedAgent(agentId, user);
  if (!owned) return null;
  const row = await findBranch(agentId, branch);
  if (!row) throw Object.assign(new Error(`No branch called "${branch}"`), { code: 'NO_BRANCH' });

  const merged = mergeInto(owned.data, row.data);
  await sql`
    update agents set data = ${JSON.stringify(merged)}::jsonb, updated_at = now()
    where id = ${agentId}
  `;
  /* Traffic goes with it: a merged branch must stop taking conversations. */
  await sql`
    update agent_branches set merged_at = now(), traffic_weight = 0 where id = ${row.id}
  `;
  return { branch: row.name, version: agentVersion(merged) };
}

export async function deleteBranch({ agentId, user, branch }) {
  const owned = await ownedAgent(agentId, user);
  if (!owned) return null;
  const row = await findBranch(agentId, branch);
  if (!row) throw Object.assign(new Error(`No branch called "${branch}"`), { code: 'NO_BRANCH' });
  await sql`delete from agent_branches where id = ${row.id}`;
  return { branch: row.name };
}

/**
 * Which branch answers this conversation.
 *
 * Drawn once, when a conversation starts, and then stored on the session — so
 * a person never sees the agent change personality between two messages, which
 * is the one thing a traffic split must never do. Drafts never take traffic.
 */
export async function drawBranch(agentId) {
  const rows = await sql`
    select id, traffic_weight from agent_branches
    where agent_id = ${agentId} and merged_at is null and kind = 'branch' and traffic_weight > 0
  `;
  const total = rows.reduce((n, r) => n + r.traffic_weight, 0);
  if (!total) return null;
  let roll = Math.random() * 100;
  for (const row of rows) {
    roll -= row.traffic_weight;
    if (roll < 0) return row.id;
  }
  return null;  /* the remainder is main */
}

/**
 * The branch that answers this conversation.
 *
 * Drawn once, on the first message, and then read back from the session for
 * every message after it. A conversation that changed branch mid-way would
 * change personality mid-sentence, which is the one failure a traffic split
 * must never produce.
 */
export async function branchForSession(agentId, sessionId) {
  if (sessionId) {
    const [row] = await sql`select branch_id from chat_sessions where id = ${sessionId}`;
    /* An existing session has already decided, and null means main. */
    if (row) return row.branch_id;
  }
  return drawBranch(agentId);
}

/** The agent that should answer a conversation already assigned to a branch. */
export async function loadForConversation(agentId, branchId) {
  if (!branchId) {
    const [row] = await sql`select data from agents where id = ${agentId}`;
    return row ? { agent: row.data, branchId: null } : null;
  }
  const [row] = await sql`
    select id, data from agent_branches
    where id = ${branchId} and agent_id = ${agentId} and merged_at is null
  `;
  /* A branch merged or deleted mid-conversation falls back to main rather
     than failing: the conversation has to keep working. */
  if (!row) return loadForConversation(agentId, null);
  return { agent: row.data, branchId: row.id };
}

export async function setTraffic({ agentId, user, branch, weight }) {
  const owned = await ownedAgent(agentId, user);
  if (!owned) return null;
  const pct = Math.max(0, Math.min(100, Math.round(Number(weight) || 0)));
  const row = await findBranch(agentId, branch);
  if (!row) throw Object.assign(new Error(`No branch called "${branch}"`), { code: 'NO_BRANCH' });
  if (row.kind === 'draft') {
    throw Object.assign(new Error('A draft cannot take live traffic'), { code: 'BAD_TARGET' });
  }
  const [{ other }] = await sql`
    select coalesce(sum(traffic_weight), 0)::int as other from agent_branches
    where agent_id = ${agentId} and merged_at is null and id <> ${row.id}
  `;
  if (other + pct > 100) {
    throw Object.assign(new Error(`Branches would take ${other + pct}% of conversations`), { code: 'OVER_100' });
  }
  await sql`update agent_branches set traffic_weight = ${pct}, updated_at = now() where id = ${row.id}`;
  return { branch: row.name, traffic_weight: pct, main: 100 - other - pct };
}

/**
 * All traffic back to main, without closing anything.
 *
 * Setting the weights to zero only stops new draws. A WhatsApp conversation is
 * one session per sender forever, so without the second statement a person
 * assigned to a branch would stay on it for good. Sessions that have been
 * quiet for half an hour are released back to main — long enough that nobody
 * sees the agent change between two messages, short enough that "stop" means
 * something.
 */
export async function stopExperiments({ agentId, user }) {
  const owned = await ownedAgent(agentId, user);
  if (!owned) return null;
  const rows = await sql`
    update agent_branches set traffic_weight = 0, updated_at = now()
    where agent_id = ${agentId} and merged_at is null and traffic_weight > 0
    returning name
  `;
  const released = await sql`
    update chat_sessions set branch_id = null
    where agent_id = ${agentId} and branch_id is not null
      and updated_at < now() - interval '30 minutes'
    returning id
  `;
  return { stopped: rows.map(r => r.name), released: released.length };
}
