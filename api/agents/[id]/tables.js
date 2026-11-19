import { requireSession } from '../../_auth.js';
import { runAgentTableTool } from '../../_tables.js';
import { accessTo, allows } from '../../_access.js';
import { listedOnAgent } from '../../_branches.js';

/* Tools that change a row; the rest only read. */
const WRITES = new Set(['table_add_row', 'table_update_row']);

/**
 * The test chat's way into the table tools.
 *
 * The browser runs its own tool loop, so without this it would either call the
 * plain table endpoints — and reach tables this AI Chatbot is not allowed to
 * touch — or drift from what the server does in production. It runs the same
 * function the widget and WhatsApp run.
 *
 * `tables` comes from the browser because the chat may be testing a draft or a
 * branch whose ticked list differs from the stored one. It is cut down twice
 * before anything runs: to the tables ticked on this chatbot (live or on an
 * open branch), and to the tables the person testing may reach themselves —
 * view to read, edit to add or change a row. Testing a chatbot is not a way
 * into a table you were given no access to.
 */
export default async function handler(req, res) {
  const user = await requireSession(req, res);
  if (!user) return;
  if (req.method !== 'POST') return res.status(405).end();

  const { id } = req.query;
  const { tool, inputs, tables } = req.body || {};
  if (!tool) return res.status(400).json({ error: 'tool is required' });

  const { level, item, me } = await accessTo(user, 'agent', id);
  if (!allows(level, 'view')) return res.status(404).json({ error: 'Agent not found' });

  const ticked = await listedOnAgent(id, 'tables');
  const need = WRITES.has(tool) ? 'edit' : 'view';
  const asked = [...new Set((Array.isArray(tables) ? tables : []).map(String))].filter(t => ticked.has(t));
  const allowed = [];
  for (const tableId of asked) {
    const { level: tableLevel } = await accessTo(user, 'table', tableId, me);
    if (allows(tableLevel, need)) allowed.push(tableId);
  }

  try {
    const result = await runAgentTableTool({
      toolName: tool,
      inputs: inputs || {},
      agent: { tables: allowed },
      ownerId: item.user_id || user.userId,
      writtenBy: id,
    });
    return res.json({ result });
  } catch (err) {
    console.error('[agents/tables]', err);
    return res.status(500).json({ error: 'The table tool failed.' });
  }
}
