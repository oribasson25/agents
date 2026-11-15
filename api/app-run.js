import { sql } from './_db.js';
import { loadAppById, mayOpen } from './_apps.js';
import { linkId } from './_appFiles.js';
import { getTable, listRows, addRow, updateRow, deleteRow } from './_tables.js';
import { runAgentTurn, saveSession } from './_agentRunner.js';
import { resolveAgentApiConfig } from './_settings.js';
import { branchForSession, loadForConversation } from './_branches.js';
import { logError } from './_errorLog.js';

/**
 * What a running app may ask the platform for — the other end of `legs`.
 *
 * Two gates on every call. The caller must be allowed to open the app (it is
 * public, or they hold a link to it). And the thing asked for must be named in
 * the live app.json AND belong to the app's owner: a name in a file is a claim,
 * and a claim on somebody else's table opens nothing.
 *
 * There is no user here. A public app runs for whoever has the link, and acts
 * with exactly what its owner linked to it — nothing else in the account.
 */
export default async function handler(req, res) {
  /* App pages are sandboxed, so to the browser this is a cross-origin call. */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).end();

  const body = req.body || {};
  const { op, name } = body;

  const found = body.app ? await loadAppById(String(body.app)) : null;
  if (!found || !mayOpen(found.app, body.token)) return res.status(404).json({ error: 'No such app' });
  const { app, ownerId } = found;

  try {
    if (op === 'agent.send') {
      const agentId = linkId((app.agents || {})[name]);
      if (!agentId) return res.status(404).json({ error: `This app has no AI Chatbot linked as "${name}"` });
      const { messages, sessionId } = body;
      if (!Array.isArray(messages) || !messages.length) {
        return res.status(400).json({ error: 'messages array required' });
      }
      const [row] = await sql`select data, user_id from agents where id = ${agentId} and user_id = ${ownerId}`;
      if (!row) return res.status(404).json({ error: `The AI Chatbot linked as "${name}" no longer exists` });

      const branchId = await branchForSession(agentId, sessionId);
      const chosen = await loadForConversation(agentId, branchId);
      const agent = { ...chosen.agent, apiConfig: await resolveAgentApiConfig(row) };
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const baseUrl = `${proto}://${req.headers.host}`;
      try {
        const { text, safeMessages } = await runAgentTurn({ agent, agentId, messages, baseUrl });
        await saveSession(sessionId, agentId, [...safeMessages, { role: 'assistant', content: text }],
                          'app', chosen.branchId);
        return res.json({ content: text });
      } catch (err) {
        await logError({ agentId, source: 'app', message: err.message, context: { appId: app.id } });
        return res.status(err.code === 'NO_API_KEY' ? 503 : 500).json({ error: err.message });
      }
    }

    if (typeof op === 'string' && op.startsWith('table.')) {
      const link = (app.tables || {})[name];
      const tableId = linkId(link);
      if (!tableId) return res.status(404).json({ error: `This app has no Table linked as "${name}"` });
      const table = await getTable(tableId, ownerId);
      if (!table) return res.status(404).json({ error: `The Table linked as "${name}" no longer exists` });
      const readonly = !!(link && typeof link === 'object' && link.readonly);
      const by = `app:${app.id}`;

      if (op === 'table.info') {
        return res.json({ name: table.name, description: table.description, columns: table.columns, readonly });
      }
      if (op === 'table.rows') {
        const { rows, total } = await listRows(tableId, { q: body.q || '', limit: body.limit, offset: body.offset });
        return res.json({ rows, total, columns: table.columns });
      }
      if (readonly) return res.status(403).json({ error: `"${name}" is linked read-only` });
      if (op === 'table.add') return res.json(await addRow(table, body.row || {}, by));
      if (op === 'table.update') {
        if (!body.rowId) return res.status(400).json({ error: 'rowId is required' });
        const saved = await updateRow(table, body.rowId, body.row || {}, by);
        return saved.error ? res.status(404).json(saved) : res.json(saved);
      }
      if (op === 'table.remove') {
        if (!body.rowId) return res.status(400).json({ error: 'rowId is required' });
        return res.json(await deleteRow(tableId, body.rowId));
      }
    }

    return res.status(400).json({ error: `Unknown operation "${op}"` });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
