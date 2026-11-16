import { checkAuthOrToken } from '../../_auth.js';
import { loadAutomation, saveDraft, setEnabled, deleteAutomation, getSamples } from '../../_automations.js';
import { checkAutomation } from '../../_automationSpec.js';

/**
 * One automation, as the canvas reads and edits it.
 *
 *   GET     the draft, with what is wrong with it and what each step last returned
 *   PUT     { data, baseVersion? }  saves the draft
 *           { enabled }             switches the published automation on or off
 *   DELETE  removes it, its versions and its runs
 */
export default async function handler(req, res) {
  const user = await checkAuthOrToken(req, res);
  if (!user) return;
  const { id } = req.query;

  try {
    if (req.method === 'GET') {
      const loaded = await loadAutomation({ id, user });
      if (!loaded) return res.status(404).json({ error: 'Automation not found' });
      const { errors, warnings } = checkAutomation(loaded.row.data);
      return res.json({ ...loaded.automation, errors, warnings, samples: await getSamples({ id, user }) });
    }

    if (req.method === 'PUT') {
      const body = req.body || {};
      let out = null;
      if (body.data !== undefined) {
        const saved = await saveDraft({ id, user, data: body.data, baseVersion: body.baseVersion });
        if (!saved) return res.status(404).json({ error: 'Automation not found' });
        out = { ...saved.automation, errors: saved.errors, warnings: saved.warnings };
      }
      if (body.enabled !== undefined) {
        const toggled = await setEnabled({ id, user, enabled: !!body.enabled });
        if (!toggled) return res.status(404).json({ error: 'Automation not found' });
        out = { ...(out || {}), ...toggled };
      }
      if (!out) return res.status(400).json({ error: 'Nothing to change: send data or enabled' });
      return res.json(out);
    }

    if (req.method === 'DELETE') {
      const done = await deleteAutomation({ id, user });
      if (!done) return res.status(404).json({ error: 'Automation not found' });
      return res.status(204).end();
    }
  } catch (err) {
    return res.status(err.code === 'READ_ONLY' ? 403 : err.status || 500).json({ error: err.message, code: err.code });
  }
  return res.status(405).end();
}
