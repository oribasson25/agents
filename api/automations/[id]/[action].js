import { checkAuthOrToken } from '../../_auth.js';
import {
  loadAutomation, publish, startRun, workRun, testStep, listRuns, saveSecrets, listVersions, activateVersion,
} from '../../_automations.js';
import { checkAutomation } from '../../_automationSpec.js';
import { automationToFiles } from '../../_automationFiles.js';
import { mirrorLinked } from '../../_github.js';

/**
 * Everything done *to* an automation, one address each:
 *
 *   POST publish     the draft becomes what triggers fire
 *   POST run         { input, mode: 'test' | 'live' }  runs it now and answers with the run
 *   POST test-step   { stepId }  runs one step of the draft on its own
 *   GET  runs        the latest runs
 *   PUT  secrets     { set: { NAME: value }, remove: [NAME] }
 *   GET  versions    what was published, newest first
 *   POST versions    { versionId }  puts an earlier one back
 */
/* The repository follows what is published, so `git pull` shows what runs. */
async function mirror(automation, message) {
  const { automation: def } = checkAutomation(automation);
  await mirrorLinked({ kind: 'automation', id: automation.id, branch: 'main', files: automationToFiles(def, automation.id), message });
}

export default async function handler(req, res) {
  const user = await checkAuthOrToken(req, res);
  if (!user) return;
  const { id, action } = req.query;
  const body = req.body || {};
  const host = req.headers.host;
  const notFound = () => res.status(404).json({ error: 'Automation not found' });

  try {
    if (action === 'publish' && req.method === 'POST') {
      const done = await publish({ id, user, source: user.viaToken ? 'cli' : 'ui', message: body.message });
      if (done && done.changed) await mirror(done.automation, body.message || `Publish ${done.automation.name}`);
      return done ? res.json({ ...done.automation, versionNumber: done.versionNumber, changed: done.changed }) : notFound();
    }

    if (action === 'run' && req.method === 'POST') {
      const mode = body.mode === 'live' ? 'live' : 'test';
      const loaded = await loadAutomation({ id, user, need: 'edit' });
      if (!loaded) return notFound();
      const runId = await startRun({ row: loaded.row, mode, source: 'manual', input: body.input ?? {}, userId: user.userId, host });
      const run = await workRun(runId, { host });
      return res.json({ runId, status: run ? run.status : 'queued', output: run ? run.output : null, error: run ? run.error : null });
    }

    if (action === 'test-step' && req.method === 'POST') {
      if (!body.stepId) return res.status(400).json({ error: 'stepId required' });
      const result = await testStep({ id, user, stepId: String(body.stepId), host });
      return result ? res.json(result) : notFound();
    }

    if (action === 'runs' && req.method === 'GET') {
      const runs = await listRuns({ id, user, limit: req.query.limit, mode: req.query.mode || null });
      return runs ? res.json({ runs }) : notFound();
    }

    if (action === 'secrets' && req.method === 'PUT') {
      const saved = await saveSecrets({ id, user, set: body.set || {}, remove: Array.isArray(body.remove) ? body.remove : [] });
      return saved ? res.json(saved) : notFound();
    }

    if (action === 'versions' && req.method === 'GET') {
      const versions = await listVersions({ id, user });
      return versions ? res.json({ versions }) : notFound();
    }
    if (action === 'versions' && req.method === 'POST') {
      if (!body.versionId) return res.status(400).json({ error: 'versionId required' });
      const done = await activateVersion({ id, user, versionId: body.versionId });
      if (done) await mirror(done.automation, `Back to version ${done.versionNumber}`);
      return done ? res.json({ ...done.automation, versionNumber: done.versionNumber }) : notFound();
    }
  } catch (err) {
    return res.status(err.code === 'READ_ONLY' ? 403 : err.status || 500)
      .json({ error: err.message, code: err.code, errors: err.errors });
  }
  return res.status(404).json({ error: `Unknown action "${action}"` });
}
