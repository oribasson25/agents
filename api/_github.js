/**
 * The GitHub side of an agent.
 *
 * Every agent gets a repository under one organisation, and git is a real way
 * in: a `git push` reaches the webhook, which validates the pushed tree and
 * applies it. That is the part worth being careful about, because a push
 * cannot be rejected after the fact — git has already accepted it. So the
 * webhook never half-applies anything. It either writes the whole agent or
 * writes nothing and marks the commit failed, and the live agent stays on the
 * last commit that was valid.
 */
import crypto from 'crypto';

const API = 'https://api.github.com';

export function githubConfigured() {
  return !!(process.env.GITHUB_AGENTS_TOKEN && process.env.GITHUB_AGENTS_ORG);
}

export const ORG = () => process.env.GITHUB_AGENTS_ORG;

async function gh(path, { method = 'GET', body, accept } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_AGENTS_TOKEN}`,
      Accept: accept || 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': '8legs-platform',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  if (!res.ok) {
    const err = new Error(parsed?.message || `GitHub ${res.status} on ${path}`);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

/** A repository name that is legal on GitHub and still says which agent it is. */
export function repoName(agent) {
  const base = String(agent?.name || '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  /* The id is always in the name: agent names are often Hebrew, are not
     unique, and can be renamed — none of which a repository name may be. The
     whole id, not its first eight characters: anyone choosing an id with the
     same start and the same name would otherwise get the same repository —
     and, before the claim below, push into it. */
  const id = String(agent.id || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${base ? base + '-' : 'agent-'}${id}`.slice(0, 100);
}

/** Makes the repository if it is not there yet. Safe to call twice. */
export async function ensureRepo({ agent, appUrl, webhookSecret, what = 'agent' }) {
  /* An existing link names its repository (made before names carried the
     whole id); a new one is named here. */
  const name = agent.repoName || repoName(agent);
  const owner = ORG();
  let repo;
  try {
    repo = await gh(`/repos/${owner}/${name}`);
  } catch (e) {
    if (e.status !== 404) throw e;
    repo = await gh(`/orgs/${owner}/repos`, {
      method: 'POST',
      body: {
        name,
        private: true,
        auto_init: false,
        description: `8Legs ${what}: ${agent.name || agent.id}`,
        has_issues: false, has_projects: false, has_wiki: false,
      },
    });
  }

  /* The hook is what lets a `git push` reach the platform. Failing to add one
     must not cost the repository its content, so it is reported and retried
     on a later pull rather than thrown. */
  let webhookId = null;
  let hookProblem = null;
  if (!appUrl || !webhookSecret) {
    hookProblem = 'GITHUB_WEBHOOK_SECRET is not set, so no webhook was added and a git push will not reach the platform';
  } else {
    try {
      const hooks = await gh(`/repos/${owner}/${name}/hooks`).catch(() => []);
      const url = `${appUrl.replace(/\/+$/, '')}/api/github/webhook`;
      const existing = (hooks || []).find(h => h.config?.url === url);
      webhookId = existing
        ? existing.id
        : (await gh(`/repos/${owner}/${name}/hooks`, {
            method: 'POST',
            body: { name: 'web', active: true, events: ['push'],
                    config: { url, content_type: 'json', secret: webhookSecret, insecure_ssl: '0' } },
          })).id;
    } catch (e) {
      hookProblem = `could not add the webhook (${e.status || ''} ${e.message})`.trim();
    }
  }
  return { owner, repo: name, webhookId, hookProblem, htmlUrl: repo.html_url, created: !repo.pushed_at };
}

/**
 * Gives an empty repository its first commit.
 *
 * GitHub's Git Data API — blobs, trees, commits, the calls pushTree makes —
 * answers 409 "Git Repository is empty" on a repository with no commit at all,
 * which is what ensureRepo creates. The Contents API does work there, so one
 * README goes in through it first. Every repository made before this existed
 * was left empty for exactly this reason, and is put right on its next pull.
 */
export async function ensureNotEmpty({ owner, repo, name }) {
  try {
    await gh(`/repos/${owner}/${repo}/commits?per_page=1`);
    return false;
  } catch (e) {
    if (e.status !== 409) throw e;
  }
  const readme = `# ${name || repo}\n\nKept in step with 8Legs: a push here that validates goes live.\n`;
  await gh(`/repos/${owner}/${repo}/contents/README.md`, {
    method: 'PUT',
    body: { message: 'Start the repository', content: Buffer.from(readme, 'utf8').toString('base64') },
  });
  return true;
}

/**
 * Writes a whole tree as one commit.
 *
 * Every file goes in each time rather than a delta: the agent is small, and a
 * delta would need the platform to know what the previous commit held, which
 * is exactly the assumption that breaks when someone edits on GitHub.
 */
export async function pushTree({ owner, repo, branch = 'main', files, message, parentSha }) {
  /* The contents go inside the tree itself — one call, where a blob per file
     used to be one call each, all at once, which ran an app of 300 files into
     GitHub's secondary rate limits. */
  const entries = Object.entries(files).map(([path, content]) => (
    { path, mode: '100644', type: 'blob', content: String(content) }));

  let parent = parentSha;
  if (parent === undefined) {
    try {
      const ref = await gh(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
      parent = ref.object.sha;
    } catch (e) { if (e.status !== 404 && e.status !== 409) throw e; parent = null; }
  }

  /* No base_tree: the commit is the complete set of files, so a file deleted
     in the platform disappears from git instead of lingering forever. */
  const tree = await gh(`/repos/${owner}/${repo}/git/trees`, { method: 'POST', body: { tree: entries } });
  const commit = await gh(`/repos/${owner}/${repo}/git/commits`, {
    method: 'POST',
    body: { message, tree: tree.sha, parents: parent ? [parent] : [] },
  });

  const refPath = `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`;
  if (parent) await gh(refPath, { method: 'PATCH', body: { sha: commit.sha, force: true } });
  else await gh(`/repos/${owner}/${repo}/git/refs`,
                { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: commit.sha } });
  return { sha: commit.sha };
}

/* At most this many requests to GitHub at once when reading a tree. */
const READ_CONCURRENCY = 8;

/** Every file at a commit, as { path: content }. */
export async function readTree({ owner, repo, sha }) {
  const tree = await gh(`/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`);
  if (tree.truncated) {
    throw Object.assign(new Error('That commit has too many files for one read'), { code: 'TRUNCATED' });
  }
  const files = {};
  const nodes = tree.tree.filter(n => n.type === 'blob');
  let next = 0;
  const worker = async () => {
    while (next < nodes.length) {
      const node = nodes[next++];
      const blob = await gh(`/repos/${owner}/${repo}/git/blobs/${node.sha}`);
      files[node.path] = Buffer.from(blob.content, blob.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, nodes.length) }, worker));
  return files;
}

/**
 * Marks a commit accepted or rejected.
 *
 * This is the only honest answer to a push that does not validate: git has
 * already taken it, so the platform cannot refuse it — it can only refuse to
 * run it, and say so where the person who pushed will see it.
 */
export async function setStatus({ owner, repo, sha, state, description, targetUrl }) {
  return gh(`/repos/${owner}/${repo}/statuses/${sha}`, {
    method: 'POST',
    body: { state, context: '8legs/validate', target_url: targetUrl,
            description: String(description || '').slice(0, 140) },
  }).catch(() => null);   /* a status is reporting, never the operation itself */
}

/** GitHub signs every delivery; an unsigned or wrongly signed one is not ours. */
export function verifyWebhook(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/*
 * Where each kind of thing keeps its repository link. Agents and apps share
 * every step of the git flow; the only difference is which table remembers it.
 */
function repoStore(kind, sql) {
  if (kind === 'automation') return {
    get: (id) => sql`select owner, repo, webhook_id, last_push_sha from automation_repos where automation_id = ${id}`,
    setHook: (id, hook) => sql`update automation_repos set webhook_id = ${hook} where automation_id = ${id}`,
    insert: (id, m, sha) => sql`
      insert into automation_repos (automation_id, owner, repo, webhook_id, last_push_sha)
      values (${id}, ${m.owner}, ${m.repo}, ${m.webhookId}, ${sha})
      on conflict (automation_id) do nothing
      returning automation_id
    `,
    setSha: (id, sha) => sql`update automation_repos set last_push_sha = ${sha} where automation_id = ${id}`,
  };
  if (kind === 'app') return {
    get: (id) => sql`select owner, repo, webhook_id, last_push_sha from app_repos where app_id = ${id}`,
    setHook: (id, hook) => sql`update app_repos set webhook_id = ${hook} where app_id = ${id}`,
    insert: (id, m, sha) => sql`
      insert into app_repos (app_id, owner, repo, webhook_id, last_push_sha)
      values (${id}, ${m.owner}, ${m.repo}, ${m.webhookId}, ${sha})
      on conflict (app_id) do nothing
      returning app_id
    `,
    setSha: (id, sha) => sql`update app_repos set last_push_sha = ${sha} where app_id = ${id}`,
  };
  return {
    get: (id) => sql`select owner, repo, webhook_id, last_push_sha from agent_repos where agent_id = ${id}`,
    setHook: (id, hook) => sql`update agent_repos set webhook_id = ${hook} where agent_id = ${id}`,
    insert: (id, m, sha) => sql`
      insert into agent_repos (agent_id, owner, repo, webhook_id, last_push_sha)
      values (${id}, ${m.owner}, ${m.repo}, ${m.webhookId}, ${sha})
      on conflict (agent_id) do nothing
      returning agent_id
    `,
    setSha: (id, sha) => sql`update agent_repos set last_push_sha = ${sha} where agent_id = ${id}`,
  };
}

/**
 * The repository for an agent or an app, made on demand.
 *
 * Called from a pull, not from creation: every sign-up is handed starter
 * agents and most are never opened in an editor, so creating a repository up
 * front would leave hundreds nobody ever clones. It also keeps creation free
 * of any dependency on GitHub being up.
 *
 * `subject` is `{ id, name }`; the name only shapes the repository's name.
 *
 * Never throws. A pull has to work whether or not the mirror does.
 */
export async function ensureLinkedRepo({ kind, subject, files, appUrl }) {
  if (!githubConfigured()) return null;
  const { sql } = await import('./_db.js');
  const store = repoStore(kind, sql);
  try {
    const [existing] = await store.get(subject.id);
    if (existing) {
      /* A repository made before GITHUB_WEBHOOK_SECRET was configured has no
         hook, and without one a `git push` reaches nothing. Returning early
         would leave it that way for good, so a later pull installs it. */
      if (!existing.webhook_id && process.env.GITHUB_WEBHOOK_SECRET && appUrl) {
        const fixed = await ensureRepo({ agent: { ...subject, repoName: existing.repo }, appUrl, what: kind,
                                         webhookSecret: process.env.GITHUB_WEBHOOK_SECRET });
        if (fixed.webhookId) await store.setHook(subject.id, fixed.webhookId);
        if (fixed.hookProblem) await report(kind, subject.id, fixed.hookProblem, fixed);
      }
      /* Claimed, but the first push never landed (GitHub failed half-way):
         it lands now, into the repository this subject already holds. */
      if (existing.last_push_sha === null && files && Object.keys(files).length) {
        await ensureNotEmpty({ owner: existing.owner, repo: existing.repo, name: subject.name });
        const { sha } = await pushTree({ owner: existing.owner, repo: existing.repo, branch: 'main', files,
                                         message: `Initial import of ${subject.name || subject.id}` });
        await store.setSha(subject.id, sha);
      }
      return { owner: existing.owner, repo: existing.repo,
               cloneUrl: `https://github.com/${existing.owner}/${existing.repo}.git` };
    }

    /* Claim the name before anything is pushed. A repository already linked
       to anything else — an agent, an app or an automation, in any
       organization — is never written to: its webhook would carry the push
       straight into the thing it belongs to. */
    const owner = ORG();
    const name = repoName(subject);
    const held = await sql`
      select 1 as held from agent_repos where owner = ${owner} and repo = ${name}
      union all select 1 from app_repos where owner = ${owner} and repo = ${name}
      union all select 1 from automation_repos where owner = ${owner} and repo = ${name}
      limit 1
    `;
    if (held.length) throw Object.assign(new Error(`the repository ${name} already belongs to something else`), { code: 'REPO_TAKEN' });
    const [claimed] = await store.insert(subject.id, { owner, repo: name, webhookId: null }, null);
    if (!claimed) {
      /* Another pull claimed it a moment ago; that one does the first push. */
      const [now] = await store.get(subject.id);
      return now ? { owner: now.owner, repo: now.repo, cloneUrl: `https://github.com/${now.owner}/${now.repo}.git` } : null;
    }

    const made = await ensureRepo({ agent: { ...subject, repoName: name }, appUrl, what: kind,
                                    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET });
    if (made.webhookId) await store.setHook(subject.id, made.webhookId);
    if (made.hookProblem) await report(kind, subject.id, made.hookProblem, made);
    await ensureNotEmpty({ owner: made.owner, repo: made.repo, name: subject.name });
    const { sha } = await pushTree({
      owner: made.owner, repo: made.repo, branch: 'main', files,
      message: `Initial import of ${subject.name || subject.id}`,
    });
    await store.setSha(subject.id, sha);
    return { owner: made.owner, repo: made.repo,
             cloneUrl: `https://github.com/${made.owner}/${made.repo}.git` };
  } catch (err) {
    console.error('[github] could not prepare the repository:', err.message);
    await report(kind, subject.id, `could not prepare the repository: ${err.status || ''} ${err.message}`.trim());
    return null;
  }
}

/* Into error_log as well as the console: a pull that quietly comes back
   without a repository is otherwise impossible to explain afterwards. */
async function report(kind, id, message, extra = {}) {
  try {
    const { logError } = await import('./_errorLog.js');
    await logError({ agentId: kind === 'agent' ? id : null, source: 'github', message,
                     context: { kind, id, owner: extra.owner, repo: extra.repo } });
  } catch { /* reporting must never break a pull */ }
}

export const ensureAgentRepo = ({ agent, files, appUrl }) =>
  ensureLinkedRepo({ kind: 'agent', subject: agent, files, appUrl });

/**
 * Mirrors a change the platform made back to git.
 *
 * The resulting commit sha is remembered so the webhook can tell this push
 * apart from someone else's and not apply it back over itself.
 */
export async function mirrorLinked({ kind, id, branch, files, message }) {
  if (!githubConfigured()) return null;
  const { sql } = await import('./_db.js');
  const store = repoStore(kind, sql);
  try {
    const [link] = await store.get(id);
    if (!link) return null;   /* nobody has pulled this yet */
    const { sha } = await pushTree({ owner: link.owner, repo: link.repo, branch, files, message });
    await store.setSha(id, sha);
    return { sha };
  } catch (err) {
    console.error('[github] could not mirror the change:', err.message);
    return null;
  }
}

export const mirrorToGit = ({ agentId, branch, files, message }) =>
  mirrorLinked({ kind: 'agent', id: agentId, branch, files, message });
