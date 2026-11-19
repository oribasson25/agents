import { sql } from './_db.js';
import { requireSession } from './_auth.js';
import { accessTo, allows } from './_access.js';
import { runToolCode } from './_toolRunner.js';
import { appBaseUrl } from './_agentRunner.js';

/**
 * A person running one of a chatbot's tools from the platform: the tool panel
 * in the editor, the editor's test chat, the assistant's run_tool.
 *
 *   POST { agentId, toolName, code?, inputs, packages?, env_vars? } → { result } | { error }
 *
 * The browser used to send code straight to the Python runner, and any signed
 * in account could. Now the runner takes only the platform, and this decides
 * what a person may run:
 *   - someone who may EDIT the chatbot runs what they sent — the editor tests
 *     drafts that are not saved yet, and they could save that code anyway.
 *     A variable sent empty (or not sent) takes the saved tool's value, so a
 *     secret never has to travel to the browser and back to be used;
 *   - someone who may only VIEW it runs the saved tool by name, exactly as a
 *     visitor's conversation would. Whatever code they sent is ignored.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const user = await requireSession(req, res);
  if (!user) return;

  const body = req.body || {};
  const agentId = String(body.agentId || '');
  const toolName = String(body.toolName || '');
  if (!agentId) return res.status(400).json({ error: 'agentId is required' });

  const { level } = await accessTo(user, 'agent', agentId);
  if (!allows(level, 'view')) return res.status(404).json({ error: 'Not found' });

  const [row] = await sql`select data from agents where id = ${agentId}`;
  const saved = ((row && row.data && row.data.tools) || []).find(t => t && t.name === toolName) || null;
  const savedEnv = Object.fromEntries(((saved && saved.envVars) || []).filter(e => e && e.key).map(e => [e.key, e.value ?? '']));
  const inputs = body.inputs && typeof body.inputs === 'object' && !Array.isArray(body.inputs) ? body.inputs : {};

  let code, packages, envVars;
  if (allows(level, 'edit') && typeof body.code === 'string') {
    code = body.code;
    packages = listOf(body.packages);
    const sent = body.env_vars && typeof body.env_vars === 'object' ? body.env_vars : {};
    envVars = { ...savedEnv };
    for (const [k, v] of Object.entries(sent)) {
      if (v !== undefined && v !== null && String(v) !== '') envVars[k] = String(v);
    }
  } else {
    if (!saved) return res.json({ error: toolName ? `Unknown tool: ${toolName}` : 'toolName is required' });
    code = saved.code || '';
    packages = listOf(saved.packages);
    envVars = savedEnv;
  }

  const baseUrl = appBaseUrl(req);
  try {
    const data = await runToolCode({ code, inputs, packages, envVars, baseUrl });
    if (data.error !== undefined) return res.json({ error: String(data.error) });
    return res.json({ result: data.result ?? null });
  } catch (err) {
    console.error('[tool-run]', err);
    return res.status(502).json({ error: 'The code runner could not be reached. Try again.' });
  }
}

/* A tool's packages are saved as "a, b"; the editor sends an array. */
function listOf(value) {
  const parts = Array.isArray(value) ? value : String(value || '').split(',');
  return parts.map(x => String(x).trim()).filter(Boolean).slice(0, 30);
}
