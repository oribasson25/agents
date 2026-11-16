import { checkAuthOrToken } from '../_auth.js';
import { getRun, stopRun } from '../_automations.js';

/** One run with every step it took; DELETE stops one that is still going. */
export default async function handler(req, res) {
  const user = await checkAuthOrToken(req, res);
  if (!user) return;
  const runId = req.query.id;
  try {
    if (req.method === 'GET') {
      const run = await getRun({ runId, user });
      return run ? res.json(run) : res.status(404).json({ error: 'Run not found' });
    }
    if (req.method === 'DELETE') {
      const done = await stopRun({ runId, user });
      return done ? res.json(done) : res.status(404).json({ error: 'Run not found' });
    }
  } catch (err) {
    return res.status(err.code === 'READ_ONLY' ? 403 : err.status || 500).json({ error: err.message, code: err.code });
  }
  return res.status(405).end();
}
