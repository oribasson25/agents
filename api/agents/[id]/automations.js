import { checkAuth } from '../../_auth.js';
import { accessTo, allows } from '../../_access.js';
import { runAgentAutomationTool } from '../../_automationTools.js';

/**
 * The test chat's way into the automation tools — for the same reason the
 * table tools have one: the browser runs its own tool loop, and it has to run
 * the function the widget and WhatsApp run.
 *
 * `automations` comes from the browser because the chat may be testing a
 * draft whose ticked list differs from the stored one; it cannot widen
 * anything, since each is looked up inside the chatbot's own organization.
 */
export default async function handler(req, res) {
  const user = checkAuth(req, res);
  if (!user) return;
  if (req.method !== 'POST') return res.status(405).end();
  const { id } = req.query;
  const { tool, inputs, automations } = req.body || {};
  if (!tool) return res.status(400).json({ error: 'tool is required' });

  const { level, item } = await accessTo(user, 'agent', id);
  if (!allows(level, 'view')) return res.status(404).json({ error: 'Agent not found' });
  try {
    const result = await runAgentAutomationTool({
      toolName: tool, inputs: inputs || {}, agentId: id, host: req.headers.host,
      agent: { automations: Array.isArray(automations) ? automations : [] },
      ownerId: item.user_id || user.userId,
    });
    return res.json({ result });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
