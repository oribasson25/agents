/**
 * Automations as something an AI Chatbot can run mid-conversation.
 *
 * A chatbot's owner ticks the automations it may run. With one ticked, the
 * chatbot gets two tools — the same arrangement as tables: one to see what
 * there is, one to use it. Two gates on every call, as everywhere: the
 * automation must be ticked on the chatbot AND belong to its organization.
 *
 * What it runs is the published automation, and only while it is switched
 * on; the fields of its Manual trigger are what the chatbot is told to send.
 */
import { sql } from './_db.js';
import { startRun, workRun } from './_automations.js';

export const AUTOMATION_TOOLS = [
  { name: 'automation_list',
    description: 'Lists the automations you can run, with what each one does and the input it needs. Call this before automation_run unless you already know.',
    schema: { type: 'object', properties: {} } },
  { name: 'automation_run',
    description: 'Runs one automation and returns what it returned. Use the exact name from automation_list, and send the input fields it lists.',
    schema: {
      type: 'object',
      properties: {
        name:  { type: 'string', description: 'The automation\'s name, from automation_list' },
        input: { type: 'object', description: 'The input, as field name to value' },
      },
      required: ['name'],
    } },
];

/** The automations one chatbot may run: ticked on it, and its organization's. */
export async function automationsForAgent(agent, ownerId) {
  const allowed = Array.isArray(agent && agent.automations) ? agent.automations.map(String) : [];
  if (!allowed.length || !ownerId) return [];
  const rows = await sql`
    select * from automations
    where org_id = (select org_id from users where id = ${ownerId}) and id = any(${allowed})
  `;
  return rows || [];
}

const describe = (row) => {
  const def = row.published || row.data || {};
  const trigger = def.trigger || {};
  const fields = trigger.type === 'manual' ? ((trigger.config || {}).fields || []).filter(f => f.key) : [];
  return {
    name: def.name || '',
    what_it_does: def.description || '',
    input: Object.fromEntries(fields.map(f => [f.key, f.value === undefined || f.value === '' ? 'text' : `e.g. ${String(f.value).slice(0, 60)}`])),
    ready: !!row.published && !!row.enabled,
  };
};

/**
 * Runs one of the two tools and returns text for the model — a result, or
 * words it can act on. Never throws for a mistake the model can correct.
 */
export async function runAgentAutomationTool({ toolName, inputs = {}, agent, ownerId, agentId = null, host = null }) {
  const rows = await automationsForAgent(agent, ownerId);
  if (toolName === 'automation_list') {
    if (!rows.length) return 'There are no automations you can run.';
    return JSON.stringify(rows.map(describe));
  }
  if (toolName !== 'automation_run') return `Unknown tool: ${toolName}`;

  const wanted = String(inputs.name || '').trim().toLowerCase();
  const row = rows.find(r => r.id === inputs.name) || rows.find(r => String((r.published || r.data).name || '').trim().toLowerCase() === wanted);
  if (!row) return `There is no automation called "${inputs.name}". The ones you can run: ${rows.map(r => `"${(r.published || r.data).name}"`).join(', ') || 'none'}.`;
  if (!row.published) return `"${row.data.name}" has not been published yet, so it cannot be run.`;
  if (!row.enabled) return `"${row.published.name}" is switched off, so it cannot be run.`;

  const input = inputs.input && typeof inputs.input === 'object' && !Array.isArray(inputs.input) ? inputs.input : {};
  /* When the chatbot was itself asked by an automation's step, this run is
     one deeper than that one (startRun reads it from runScope), so an
     automation that asks a chatbot that runs the automation stops in time. */
  let runId;
  try {
    runId = await startRun({ row, mode: 'live', source: 'agent', input, host });
  } catch (err) {
    if (err.code === 'TOO_DEEP' || err.code === 'NOT_PUBLISHED' || err.code === 'INVALID') return `The automation could not be started: ${err.message}`;
    throw err;
  }
  const run = await workRun(runId, { host, budgetMs: 45 * 1000, hardBudgetMs: 60 * 1000 });
  if (!run) return 'The automation was started.';
  if (run.status === 'done') return run.output === null || run.output === undefined ? 'Done.' : JSON.stringify(run.output);
  if (run.status === 'failed') return `The automation failed: ${run.error}`;
  return 'The automation has started and is still going (it is waiting on something). It will finish by itself; there is no result to report yet.';
}
