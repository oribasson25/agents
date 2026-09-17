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
     unique, and can be renamed — none of which a repository name may be. */
  return `${base ? base + '-' : 'agent-'}${String(agent.id).slice(0, 8)}`;
}

/** Makes the repository if it is not there yet. Safe to call twice. */
export async function ensureRepo({ agent, appUrl, webhookSecret }) {
  const name = repoName(agent);
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
        description: `8Legs agent: ${agent.name || agent.id}`,
        has_issues: false, has_projects: false, has_wiki: false,
      },
    });
  }

  let webhookId = null;
  if (appUrl && webhookSecret) {
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
  }
  return { owner, repo: name, webhookId, htmlUrl: repo.html_url, created: !repo.pushed_at };
}

/**
 * Writes a whole tree as one commit.
 *
 * Every file goes in each time rather than a delta: the agent is small, and a
 * delta would need the platform to know what the previous commit held, which
 * is exactly the assumption that breaks when someone edits on GitHub.
 */
export async function pushTree({ owner, repo, branch = 'main', files, message, parentSha }) {
  const blobs = await Promise.all(Object.entries(files).map(async ([path, content]) => {
    const blob = await gh(`/repos/${owner}/${repo}/git/blobs`, {
      method: 'POST',
      body: { content: Buffer.from(String(content), 'utf8').toString('base64'), encoding: 'base64' },
    });
    return { path, mode: '100644', type: 'blob', sha: blob.sha };
  }));

  let parent = parentSha;
  if (parent === undefined) {
    try {
      const ref = await gh(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
      parent = ref.object.sha;
    } catch (e) { if (e.status !== 404 && e.status !== 409) throw e; parent = null; }
  }

  /* No base_tree: the commit is the complete set of files, so a file deleted
     in the platform disappears from git instead of lingering forever. */
  const tree = await gh(`/repos/${owner}/${repo}/git/trees`, { method: 'POST', body: { tree: blobs } });
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

/** Every file at a commit, as { path: content }. */
export async function readTree({ owner, repo, sha }) {
  const tree = await gh(`/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`);
  if (tree.truncated) {
    throw Object.assign(new Error('That commit has too many files for one read'), { code: 'TRUNCATED' });
  }
  const files = {};
  await Promise.all(tree.tree.filter(n => n.type === 'blob').map(async node => {
    const blob = await gh(`/repos/${owner}/${repo}/git/blobs/${node.sha}`);
    files[node.path] = Buffer.from(blob.content, blob.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
  }));
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

/**
 * The repository for an agent, made on demand.
 *
 * Called from a pull, not from agent creation: every sign-up is handed starter
 * agents and most are never opened in an editor, so creating a repository up
 * front would leave hundreds nobody ever clones. It also keeps agent creation
 * free of any dependency on GitHub being up.
 *
 * Never throws. A pull has to work whether or not the mirror does.
 */
export async function ensureAgentRepo({ agent, files, appUrl }) {
  if (!githubConfigured()) return null;
  const { sql } = await import('./_db.js');
  try {
    const [existing] = await sql`select owner, repo from agent_repos where agent_id = ${agent.id}`;
    if (existing) return { ...existing, cloneUrl: `https://github.com/${existing.owner}/${existing.repo}.git` };

    const made = await ensureRepo({ agent, appUrl, webhookSecret: process.env.GITHUB_WEBHOOK_SECRET });
    const { sha } = await pushTree({
      owner: made.owner, repo: made.repo, branch: 'main', files,
      message: `Initial import of ${agent.name || agent.id}`,
    });
    await sql`
      insert into agent_repos (agent_id, owner, repo, webhook_id, last_push_sha)
      values (${agent.id}, ${made.owner}, ${made.repo}, ${made.webhookId}, ${sha})
      on conflict (agent_id) do nothing
    `;
    return { owner: made.owner, repo: made.repo,
             cloneUrl: `https://github.com/${made.owner}/${made.repo}.git` };
  } catch (err) {
    console.error('[github] could not prepare the repository:', err.message);
    return null;
  }
}

/**
 * Mirrors a change the platform made back to git.
 *
 * The resulting commit sha is remembered so the webhook can tell this push
 * apart from someone else's and not apply it back over itself.
 */
export async function mirrorToGit({ agentId, branch, files, message }) {
  if (!githubConfigured()) return null;
  const { sql } = await import('./_db.js');
  try {
    const [link] = await sql`select owner, repo from agent_repos where agent_id = ${agentId}`;
    if (!link) return null;   /* nobody has pulled this agent yet */
    const { sha } = await pushTree({ owner: link.owner, repo: link.repo, branch, files, message });
    await sql`update agent_repos set last_push_sha = ${sha} where agent_id = ${agentId}`;
    return { sha };
  } catch (err) {
    console.error('[github] could not mirror the change:', err.message);
    return null;
  }
}
