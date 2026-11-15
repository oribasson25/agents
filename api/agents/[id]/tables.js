import { checkAuth } from '../../_auth.js';
import { runAgentTableTool } from '../../_tables.js';
import { accessTo, allows } from '../../_access.js';

/**
 * The test chat's way into the table tools.
 *
 * The browser runs its own tool loop, so without this it would either call the
 * plain table endpoints — and reach tables this AI Chatbot is not allowed to
 * touch — or drift from what the server does in production. It runs the same
 * function the widget and WhatsApp run.
 *
 * `tables` comes from the browser because the chat may be testing a draft or a
 * branch whose ticked list differs from the stored one; it cannot widen
 * anything, since every table is filtered by who is signed in.
 */
export default async function handler(req, res) {
  const user = checkAuth(req, res);
  if (!user) return;
  if (req.method !== 'POST') return res.status(405).end();

  const { id } = req.query;
  const { tool, inputs, tables } = req.body || {};
  if (!tool) return res.status(400).json({ error: 'tool is required' });

  /* Whoever may test the chatbot may run its tools, as the chatbot would in a
     real conversation; the tables are its organization's, by its owner. */
  const { level, item } = await accessTo(user, 'agent', id);
  if (!allows(level, 'view')) return res.status(404).json({ error: 'Agent not found' });

  try {
    const result = await runAgentTableTool({
      toolName: tool,
      inputs: inputs || {},
      agent: { tables: Array.isArray(tables) ? tables : [] },
      ownerId: item.user_id || user.userId,
      writtenBy: id,
    });
    return res.json({ result });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
