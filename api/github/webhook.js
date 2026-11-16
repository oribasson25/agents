import { sql } from '../_db.js';
import { verifyWebhook, readTree, setStatus } from '../_github.js';
import { filesToAgent } from '../_agentFiles.js';
import { loadAgent, saveAgent, createBranch, MAIN } from '../_branches.js';
import { logError } from '../_errorLog.js';
import { filesToApp } from '../_appFiles.js';
import { loadApp, saveApp, linkProblems } from '../_apps.js';
import { filesToAutomation } from '../_automationFiles.js';
import { loadAutomation, saveDraft, publish } from '../_automations.js';

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
  if (!link) {
    /* Apps have repositories too, and the same hook reaches this handler. */
    const [appLink] = await sql`
      select r.app_id, r.last_push_sha, a.user_id
      from app_repos r join apps a on a.id = r.app_id
      where r.owner = ${owner} and r.repo = ${repo}
    `;
    if (appLink) return applyAppPush({ res, link: appLink, owner, repo, sha, branch });
    const [autoLink] = await sql`
      select r.automation_id, r.last_push_sha, a.user_id
      from automation_repos r join automations a on a.id = r.automation_id
      where r.owner = ${owner} and r.repo = ${repo}
    `;
    if (autoLink) return applyAutomationPush({ res, link: autoLink, owner, repo, sha, branch });
    return res.status(404).json({ error: 'That repository is not linked to an agent, an app or an automation' });
  }

  /* The platform mirrors its own pushes to git. Without this they would come
     straight back in as incoming changes and overwrite what just happened. */
  if (link.last_push_sha === sha) return res.status(200).json({ skipped: 'own push' });

  /* GitHub has already decided who may push to this repository, so the push
     is applied by the platform itself, recorded against the agent's owner. */
  const user = { userId: link.user_id, system: true };
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

/**
 * A push to an app's repository.
 *
 * The same rule as for an agent: the tree either validates and becomes the
 * live app — and a version to go back to — or nothing is written and the
 * commit is marked failed. Only `main` is served; an app has no branches on
 * the platform, so a push anywhere else is accepted by git and left there.
 */
async function applyAppPush({ res, link, owner, repo, sha, branch }) {
  if (link.last_push_sha === sha) return res.status(200).json({ skipped: 'own push' });

  const user = { userId: link.user_id, system: true };
  const base = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
  const targetUrl = base ? `${base}/#app/${link.app_id}` : undefined;
  const fail = async (description) => {
    await setStatus({ owner, repo, sha, state: 'failure', description, targetUrl });
    return res.status(200).json({ applied: false, reason: description });
  };

  try {
    if (branch !== MAIN) {
      await setStatus({ owner, repo, sha, state: 'success', targetUrl,
                        description: 'Not live: only main is served. Merge into main to publish.' });
      return res.status(200).json({ applied: false, reason: 'only main is served' });
    }
    await setStatus({ owner, repo, sha, state: 'pending', description: 'Checking the app…', targetUrl });

    const files = await readTree({ owner, repo, sha });
    const existing = await loadApp({ appId: link.app_id, user });
    if (!existing) return await fail('That app no longer exists');

    const { app, errors } = filesToApp(files, existing.app);
    if (errors.length) return await fail(errors.slice(0, 3).join('; '));
    const problems = await linkProblems(app, link.user_id);
    if (problems.length) return await fail(problems.slice(0, 3).join('; '));

    const saved = await saveApp({ appId: link.app_id, user, data: app, source: 'git',
                                  commitSha: sha, message: `git ${sha.slice(0, 7)}` });
    await sql`update app_repos set last_push_sha = ${sha} where app_id = ${link.app_id}`;

    await setStatus({ owner, repo, sha, state: 'success', targetUrl,
                      description: saved.versionNumber ? `Live as version ${saved.versionNumber}` : 'Live' });
    return res.status(200).json({ applied: true, branch: MAIN, version: saved.versionNumber });
  } catch (err) {
    await logError({ agentId: null, source: 'github', message: err.message,
                     context: { owner, repo, sha, branch, appId: link.app_id } });
    return await fail(err.code === 'TRUNCATED' ? 'Too many files in that commit' : err.message);
  }
}

/**
 * A push to an automation's repository.
 *
 * `main` is what is published: a tree that validates becomes the draft and is
 * published in the same breath, and one that does not changes nothing and is
 * marked failed. A push to any other branch is git's own business.
 */
async function applyAutomationPush({ res, link, owner, repo, sha, branch }) {
  if (link.last_push_sha === sha) return res.status(200).json({ skipped: 'own push' });

  const user = { userId: link.user_id, system: true };
  const base = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
  const targetUrl = base ? `${base}/#automation/${link.automation_id}` : undefined;
  const fail = async (description) => {
    await setStatus({ owner, repo, sha, state: 'failure', description: String(description).slice(0, 140), targetUrl });
    return res.status(200).json({ applied: false, reason: description });
  };

  try {
    if (branch !== MAIN) {
      await setStatus({ owner, repo, sha, state: 'success', targetUrl,
                        description: 'Not published: only main is. Merge into main to publish.' });
      return res.status(200).json({ applied: false, reason: 'only main is published' });
    }
    await setStatus({ owner, repo, sha, state: 'pending', description: 'Checking the automation…', targetUrl });

    const files = await readTree({ owner, repo, sha });
    const existing = await loadAutomation({ id: link.automation_id, user });
    if (!existing) return await fail('That automation no longer exists');

    const { automation, errors } = filesToAutomation(files, { id: existing.row.id, name: existing.row.data.name });
    if (errors.length) return await fail(errors.slice(0, 3).join('; '));

    const saved = await saveDraft({ id: link.automation_id, user, data: automation });
    if (saved.errors.length) return await fail(`Saved as a draft, not published: ${saved.errors.slice(0, 2).join('; ')}`);
    const done = await publish({ id: link.automation_id, user, source: 'git', commitSha: sha, message: `git ${sha.slice(0, 7)}` });
    await sql`update automation_repos set last_push_sha = ${sha} where automation_id = ${link.automation_id}`;

    await setStatus({ owner, repo, sha, state: 'success', targetUrl,
                      description: done.versionNumber ? `Published as version ${done.versionNumber}` : 'Published' });
    return res.status(200).json({ applied: true, branch: MAIN, version: done.versionNumber });
  } catch (err) {
    await logError({ agentId: null, source: 'github', message: err.message,
                     context: { owner, repo, sha, branch, automationId: link.automation_id } });
    return await fail(err.code === 'TRUNCATED' ? 'Too many files in that commit' : err.message);
  }
}
