import { sql } from '../_db.js';
import { verifyWebhook, readTree, setStatus } from '../_github.js';
import { filesToAgent } from '../_agentFiles.js';
import { loadAgent, saveAgent, createBranch, MAIN } from '../_branches.js';
import { logError } from '../_errorLog.js';

/* The raw body is what GitHub signed, so it has to be read before parsing. */
export const config = { api: { bodyParser: false } };

function rawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * A `git push` arriving from GitHub.
 *
 * The rule the whole thing turns on: git has already accepted the push, so
 * this cannot reject it. It can only decline to make it live. A tree that does
 * not validate leaves the agent exactly as it was and marks the commit failed,
 * so the live agent is always the last commit that made sense.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const raw = await rawBody(req);
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!verifyWebhook(raw, req.headers['x-hub-signature-256'], secret)) {
    /* Anyone can reach this URL; only GitHub can sign for it. */
    return res.status(401).json({ error: 'bad signature' });
  }

  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).end(); }
  if (req.headers['x-github-event'] !== 'push') return res.status(204).end();

  const owner = event.repository?.owner?.name || event.repository?.owner?.login;
  const repo = event.repository?.name;
  const sha = event.after;
  const branch = String(event.ref || '').replace(/^refs\/heads\//, '');

  /* A branch deletion, or a push of nothing. */
  if (!sha || /^0+$/.test(sha)) return res.status(204).end();

  const [link] = await sql`
    select r.agent_id, r.last_push_sha, a.user_id
    from agent_repos r join agents a on a.id = r.agent_id
    where r.owner = ${owner} and r.repo = ${repo}
  `;
  if (!link) return res.status(404).json({ error: 'That repository is not linked to an agent' });

  /* The platform mirrors its own pushes to git. Without this they would come
     straight back in as incoming changes and overwrite what just happened. */
  if (link.last_push_sha === sha) return res.status(200).json({ skipped: 'own push' });

  /* The repository belongs to an agent, and the agent to a person. The push
     runs as that person — GitHub access is proof enough of who may edit. */
  const user = { userId: link.user_id, isAdmin: false };
  const appUrl = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
  const targetUrl = appUrl ? `${appUrl}/#agent/${link.agent_id}` : undefined;
  const fail = async (description) => {
    await setStatus({ owner, repo, sha, state: 'failure', description, targetUrl });
    return res.status(200).json({ applied: false, reason: description });
  };

  try {
    await setStatus({ owner, repo, sha, state: 'pending', description: 'Checking the agent…', targetUrl });

    const files = await readTree({ owner, repo, sha });

    /* A push to a git branch the platform does not know about opens one, so
       `git checkout -b` followed by a push behaves the way it reads. */
    let target = branch;
    if (branch !== MAIN) {
      try {
        await loadAgent({ agentId: link.agent_id, user, branch });
      } catch (e) {
        if (e.code !== 'NO_BRANCH') throw e;
        await createBranch({ agentId: link.agent_id, user, name: branch, from: MAIN });
      }
    } else {
      target = MAIN;
    }

    const existing = await loadAgent({ agentId: link.agent_id, user, branch: target });
    if (!existing) return await fail('That agent no longer exists');

    const { agent, errors } = filesToAgent(files, existing.agent);
    if (errors.length) return await fail(errors.slice(0, 3).join('; '));

    /* The repository may not move the agent to another id or another owner. */
    agent.id = existing.agent.id;

    await saveAgent({ agentId: link.agent_id, user, branch: target, data: agent });
    await sql`update agent_repos set last_push_sha = ${sha} where agent_id = ${link.agent_id}`;

    await setStatus({ owner, repo, sha, state: 'success',
                      description: target === MAIN ? 'Live' : `Applied to ${target}`, targetUrl });
    return res.status(200).json({ applied: true, branch: target });

  } catch (err) {
    await logError({ agentId: link.agent_id, source: 'github', message: err.message,
                     context: { owner, repo, sha, branch } });
    return await fail(err.code === 'TRUNCATED' ? 'Too many files in that commit' : err.message);
  }
}
