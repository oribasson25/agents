import { checkAuthOrToken } from '../../_auth.js';
import { listVersions, activateVersion, appUrl } from '../../_apps.js';
import { appToFiles } from '../../_appFiles.js';
import { mirrorLinked } from '../../_github.js';

/** An app's versions, and putting an earlier one back in front of people. */
export default async function handler(req, res) {
  const user = await checkAuthOrToken(req, res);
  if (!user) return;
  const { id } = req.query;

  try {
    if (req.method === 'GET') {
      const versions = await listVersions({ appId: id, user });
      if (!versions) return res.status(404).json({ error: 'App not found' });
      return res.json({ versions });
    }
    if (req.method === 'POST') {
      const { versionId } = req.body || {};
      if (!versionId) return res.status(400).json({ error: 'versionId required' });
      const done = await activateVersion({ appId: id, user, versionId });
      if (!done) return res.status(404).json({ error: 'App not found' });
      /* The repository follows, so `git pull` shows what is actually live. */
      await mirrorLinked({ kind: 'app', id: done.app.id, branch: 'main', files: appToFiles(done.app),
                           message: `Back to version ${done.versionNumber}` });
      return res.json({ version: done.version, versionNumber: done.versionNumber, url: appUrl(done.app, user) });
    }
  } catch (err) {
    if (err.code === 'NO_VERSION') return res.status(404).json({ error: err.message });
    if (err.code === 'READ_ONLY') return res.status(403).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: err.message });
  }
  return res.status(405).end();
}
