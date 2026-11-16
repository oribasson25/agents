import { checkAuth } from '../../_auth.js';
import { loadApp, saveApp, deleteApp, linkProblems, appUrl } from '../../_apps.js';
import { appToFiles, filesToApp } from '../../_appFiles.js';
import { mirrorLinked } from '../../_github.js';

const EDITABLE = ['name', 'description', 'entry', 'agents', 'tables', 'automations', 'files'];

/**
 * One app, as the Apps screen reads and edits it.
 *
 * An edit made here goes through the same validation a push does — the screen
 * is one more way of writing the same files, not a way around the rules.
 */
export default async function handler(req, res) {
  const user = checkAuth(req, res);
  if (!user) return;
  const { id } = req.query;

  try {
    const loaded = await loadApp({ appId: id, user });
    if (!loaded) return res.status(404).json({ error: 'App not found' });
    const app = loaded.app;

    if (req.method === 'GET') {
      return res.json({ ...app, version: loaded.version, url: appUrl(app, user), _access: loaded.access });
    }

    if ((req.method === 'PUT' || req.method === 'DELETE') && loaded.access !== 'edit') {
      return res.status(403).json({ error: 'You can view this app but not change it.', code: 'READ_ONLY' });
    }

    if (req.method === 'PUT') {
      const patch = req.body || {};
      const draft = { ...app };
      for (const key of EDITABLE) if (patch[key] !== undefined) draft[key] = patch[key];
      if (patch.access !== undefined) {
        if (!['private', 'link'].includes(patch.access)) {
          return res.status(400).json({ error: 'access is "private" or "link"' });
        }
      }

      const { app: next, errors } = filesToApp(appToFiles(draft), app);
      if (errors.length) return res.status(422).json({ error: errors[0], errors });
      const problems = await linkProblems(next, loaded.ownerId);
      if (problems.length) return res.status(422).json({ error: problems[0], errors: problems });
      if (patch.access !== undefined) next.access = patch.access;

      const saved = await saveApp({ appId: app.id, user, data: next, source: 'ui',
                                    message: patch.message || 'Edited in the platform' });
      if (saved.changed) {
        await mirrorLinked({ kind: 'app', id: app.id, branch: 'main', files: appToFiles(saved.app),
                             message: patch.message || `Update ${app.name || app.slug}` });
      }
      return res.json({ ...saved.app, version: saved.version, versionNumber: saved.versionNumber,
                        url: appUrl(saved.app, user), _access: loaded.access });
    }

    if (req.method === 'DELETE') {
      await deleteApp({ appId: app.id, user });
      return res.status(204).end();
    }
  } catch (err) {
    if (err.code === 'READ_ONLY') return res.status(403).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: err.message });
  }
  return res.status(405).end();
}
