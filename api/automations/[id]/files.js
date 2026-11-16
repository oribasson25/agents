import { checkAuthOrToken } from '../../_auth.js';
import { loadAutomation, saveDraft, publish, versionOf } from '../../_automations.js';
import { checkAutomation } from '../../_automationSpec.js';
import { automationToFiles, filesToAutomation } from '../../_automationFiles.js';
import { ensureLinkedRepo, mirrorLinked } from '../../_github.js';

/**
 * The automation as a folder of files: what `8legs pull` reads and `8legs
 * push` writes.
 *
 * A pull gives the draft. A push replaces the draft — all of it or none of
 * it: a file that does not parse, a connection to a step that is not there,
 * a push made on top of an older draft, and nothing is written. With
 * `publish: true` the pushed draft also becomes what the trigger fires.
 */
export default async function handler(req, res) {
  const user = await checkAuthOrToken(req, res);
  if (!user) return;
  const { id } = req.query;

  try {
    const loaded = await loadAutomation({ id, user });
    if (!loaded) return res.status(404).json({ error: 'Automation not found' });
    const { automation: def } = checkAutomation(loaded.row.data);

    if (req.method === 'GET') {
      const files = automationToFiles(def, loaded.row.id);
      /* The repository holds what is published, so that is what it starts with. */
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const appUrl = (process.env.APP_URL || `${proto}://${req.headers.host}`).trim();
      const git = loaded.row.published ? await ensureLinkedRepo({
        kind: 'automation', subject: { id: loaded.row.id, name: `automation-${def.name}` },
        files: automationToFiles(checkAutomation(loaded.row.published).automation, loaded.row.id), appUrl }) : null;
      return res.json({ automationId: loaded.row.id, name: def.name, branch: 'main',
                        version: versionOf(loaded.row.data), files, git,
                        published: !!loaded.row.published, enabled: !!loaded.row.enabled });
    }

    if (req.method === 'PUT') {
      if (loaded.access !== 'edit') {
        return res.status(403).json({ error: 'You can view this automation but not change it.', code: 'READ_ONLY' });
      }
      const body = req.body || {};
      if (!body.files || typeof body.files !== 'object') return res.status(400).json({ error: 'files required' });
      if (body.baseVersion && body.baseVersion !== versionOf(loaded.row.data)) {
        return res.status(409).json({ error: 'The automation changed since you pulled it',
                                      yourVersion: body.baseVersion, currentVersion: versionOf(loaded.row.data) });
      }
      const { automation: next, errors } = filesToAutomation(body.files, { id: loaded.row.id, name: def.name });
      if (errors.length) return res.status(422).json({ error: 'Invalid automation files', errors });

      const saved = await saveDraft({ id: loaded.row.id, user, data: next });
      let published = null;
      if (body.publish) {
        if (saved.errors.length) return res.status(422).json({ error: 'The draft was saved, but it cannot be published yet', errors: saved.errors, saved: true, version: saved.automation.version });
        published = await publish({ id: loaded.row.id, user, source: 'cli', message: body.message || 'Published from the CLI' });
        if (published.changed) {
          await mirrorLinked({ kind: 'automation', id: loaded.row.id, branch: 'main',
                               files: automationToFiles(next, loaded.row.id), message: body.message || `Publish ${next.name}` });
        }
      }
      return res.json({ automationId: loaded.row.id, branch: 'main', version: saved.automation.version,
                        unfinished: saved.errors, warnings: saved.warnings,
                        published: !!published, versionNumber: published ? published.versionNumber : null });
    }
  } catch (err) {
    return res.status(err.code === 'READ_ONLY' ? 403 : err.status || 500).json({ error: err.message, code: err.code, errors: err.errors });
  }
  return res.status(405).end();
}
