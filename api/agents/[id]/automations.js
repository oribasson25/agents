import { requireSession } from '../../_auth.js';
import { accessTo, allows } from '../../_access.js';
import { listedOnAgent } from '../../_branches.js';
import { runAgentAutomationTool } from '../../_automationTools.js';

/**
 * The test chat's way into the automation tools — for the same reason the
 * table tools have one: the browser runs its own tool loop, and it has to run
 * the function the widget and WhatsApp run.
 *
 * `automations` comes from the browser because the chat may be testing a
 * draft whose ticked list differs from the stored one. It is cut down to the
 * automations ticked on this chatbot (live or on an open branch), and then to
 * the ones the person testing may reach: view to list them, edit to run one —
 * a run is live, so it is the same right as pressing Run on the automation.
 */
export default async function handler(req, res) {
  const user = await requireSession(req, res);
  if (!user) return;
  if (req.method !== 'POST') return res.status(405).end();
  const { id } = req.query;
  const { tool, inputs, automations } = req.body || {};
  if (!tool) return res.status(400).json({ error: 'tool is required' });

  const { level, item, me } = await accessTo(user, 'agent', id);
  if (!allows(level, 'view')) return res.status(404).json({ error: 'Agent not found' });

  const ticked = await listedOnAgent(id, 'automations');
  const need = tool === 'automation_run' ? 'edit' : 'view';
  const asked = [...new Set((Array.isArray(automations) ? automations : []).map(String))].filter(a => ticked.has(a));
  const allowed = [];
  for (const automationId of asked) {
    const { level: automationLevel } = await accessTo(user, 'automation', automationId, me);
    if (allows(automationLevel, need)) allowed.push(automationId);
  }

  try {
    const result = await runAgentAutomationTool({
      toolName: tool, inputs: inputs || {}, agentId: id, host: req.headers.host,
      agent: { automations: allowed },
      ownerId: item.user_id || user.userId,
    });
    return res.json({ result });
  } catch (err) {
    console.error('[agents/automations]', err);
    return res.status(500).json({ error: 'The automation tool failed.' });
  }
}
