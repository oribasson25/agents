import { checkAuthOrToken } from '../../_auth.js';
import { agentToFiles, filesToAgent, agentVersion } from '../../_agentFiles.js';
import { loadAgent, saveAgent, MAIN } from '../../_branches.js';
import { ensureAgentRepo, mirrorToGit } from '../../_github.js';

/**
 * The agent as a folder of files: what `8legs pull` reads and `8legs push`
 * writes. Accepts a personal access token as well as a browser session.
 *
 * A push is all-or-nothing. Either every file parses and the whole agent is
 * replaced in one statement, or nothing is written at all — a broken JSON file
 * must never be able to leave a live agent half updated.
 */
export default async function handler(req, res) {
  const user = await checkAuthOrToken(req, res);
  if (!user) return;

  const { id } = req.query;
  const branch = req.query.branch || MAIN;

  let loaded;
  try {
    loaded = await loadAgent({ agentId: id, user, branch });
  } catch (e) {
    if (e.code === 'NO_BRANCH') return res.status(404).json({ error: e.message });
    throw e;
  }
  if (!loaded) return res.status(404).json({ error: 'Agent not found' });
  const agent = loaded.agent;

  if (req.method === 'GET') {
    const files = agentToFiles(agent);
    /* First pull is also when the repository gets made. It never fails the
       pull: editing through the CLI works whether or not the mirror does. */
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const appUrl = (process.env.APP_URL || `${proto}://${req.headers.host}`).trim();
    const git = loaded.branch === MAIN
      ? await ensureAgentRepo({ agent, files, appUrl })
      : null;
    return res.json({ agentId: id, branch: loaded.branch, version: loaded.version, files, git });
  }

  if (req.method === 'PUT') {
    const { baseVersion, files } = req.body || {};
    if (!files || typeof files !== 'object') {
      return res.status(400).json({ error: 'files required' });
    }

    /* Someone changed the agent since this checkout was pulled. Refusing here
       is the whole point of the version: the alternative is silently throwing
       their edit away. `8legs pull` then merges and pushes again. */
    const current = loaded.version;
    if (baseVersion && baseVersion !== current) {
      return res.status(409).json({
        error: 'The agent changed since you pulled it',
        yourVersion: baseVersion,
        currentVersion: current,
      });
    }

    const { agent: next, errors } = filesToAgent(files, agent);
    if (errors.length) return res.status(422).json({ error: 'Invalid agent files', errors });

    /* Nothing may move the agent's identity or its owner. */
    next.id = agent.id;

    const saved = await saveAgent({ agentId: id, user, branch, data: next });
    if (!saved) return res.status(404).json({ error: 'Agent not found' });

    /* Mirror it, so `git log` on the repository is the whole history and not
       only the half that happened to arrive through git. */
    await mirrorToGit({ agentId: id, branch: saved.branch, files,
                        message: (req.body || {}).message || `Update ${agent.name || id}` });

    return res.json({ agentId: id, version: saved.version, branch: saved.branch });
  }

  res.status(405).end();
}
