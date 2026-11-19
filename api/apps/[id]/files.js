import { checkAuthOrToken } from '../../_auth.js';
import { appToFiles, filesToApp } from '../../_appFiles.js';
import { loadApp, saveApp, linkProblems } from '../../_apps.js';
import { ensureLinkedRepo, mirrorLinked } from '../../_github.js';

/**
 * The app as a folder of files: what `8legs pull` reads and `8legs push`
 * writes — the same contract `/api/agents/:id/files` keeps for an agent.
 *
 * A push is all-or-nothing. Either the whole tree validates, becomes the live
 * app and is kept as a version, or nothing is written at all.
 */
export default async function handler(req, res) {
  const user = await checkAuthOrToken(req, res);
  if (!user) return;

  const { id } = req.query;
  const loaded = await loadApp({ appId: id, user });
  if (!loaded) return res.status(404).json({ error: 'App not found' });
  const app = loaded.app;

  if (req.method === 'GET') {
    const files = appToFiles(app);
    /* First pull is also when the repository gets made; it never fails the pull. */
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const appUrl = (process.env.APP_URL || `${proto}://${req.headers.host}`).trim();
    const git = await ensureLinkedRepo({
      kind: 'app', subject: { id: app.id, name: `app-${app.slug}` }, files, appUrl });
    return res.json({ appId: app.id, slug: app.slug, branch: 'main', version: loaded.version, files, git });
  }

  if (req.method === 'PUT') {
    if (loaded.access !== 'edit') {
      return res.status(403).json({ error: 'You can view this app but not change it.', code: 'READ_ONLY' });
    }
    const { baseVersion, files } = req.body || {};
    if (!files || typeof files !== 'object') return res.status(400).json({ error: 'files required' });

    /* Someone changed the app since this checkout was pulled. */
    if (baseVersion && baseVersion !== loaded.version) {
      return res.status(409).json({
        error: 'The app changed since you pulled it',
        yourVersion: baseVersion, currentVersion: loaded.version,
      });
    }

    const { app: next, errors } = filesToApp(files, app);
    if (errors.length) return res.status(422).json({ error: 'Invalid app files', errors });
    const problems = await linkProblems(next, loaded.ownerId, user, loaded.app);
    if (problems.length) return res.status(422).json({ error: 'Invalid app files', errors: problems });

    const saved = await saveApp({ appId: app.id, user, data: next, source: 'cli',
                                  message: (req.body || {}).message || 'Pushed from the CLI' });
    if (!saved) return res.status(404).json({ error: 'App not found' });

    if (saved.changed) {
      await mirrorLinked({ kind: 'app', id: app.id, branch: 'main', files: appToFiles(saved.app),
                           message: (req.body || {}).message || `Update ${app.name || app.slug}` });
    }
    return res.json({ appId: app.id, version: saved.version, branch: 'main',
                      versionNumber: saved.versionNumber });
  }

  res.status(405).end();
}
