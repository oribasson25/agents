import { sql } from '../../_db.js';
import { checkAuthOrToken } from '../../_auth.js';
import { agentToFiles, filesToAgent, agentVersion } from '../../_agentFiles.js';

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
  const [row] = await sql`
    select data from agents where id = ${id} and user_id = ${user.userId}
  `;
  if (!row) return res.status(404).json({ error: 'Agent not found' });
  const agent = row.data;

  if (req.method === 'GET') {
    return res.json({
      agentId: id,
      branch: 'main',
      version: agentVersion(agent),
      files: agentToFiles(agent),
    });
  }

  if (req.method === 'PUT') {
    const { baseVersion, files } = req.body || {};
    if (!files || typeof files !== 'object') {
      return res.status(400).json({ error: 'files required' });
    }

    /* Someone changed the agent since this checkout was pulled. Refusing here
       is the whole point of the version: the alternative is silently throwing
       their edit away. `8legs pull` then merges and pushes again. */
    const current = agentVersion(agent);
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

    await sql`
      update agents set data = ${JSON.stringify(next)}::jsonb, updated_at = now()
      where id = ${id} and user_id = ${user.userId}
    `;
    return res.json({ agentId: id, version: agentVersion(next), branch: 'main' });
  }

  res.status(405).end();
}
