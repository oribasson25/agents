import { sql } from './_db.js';
import { nowBlock } from './_now.js';
import { searchDocuments } from './_knowledge.js';
import { sendGmail } from './_gmail.js';
import { logError } from './_errorLog.js';
import { TABLE_TOOLS, runAgentTableTool } from './_tables.js';
import { AUTOMATION_TOOLS, runAgentAutomationTool } from './_automationTools.js';
import { internalSecret } from './_auth.js';
import { llmFetch, replyText } from './_llm.js';
import { configUsable } from './_settings.js';

/* This runs server-side with no logged-in user, so it proves it is the
   platform to the tool runner and the scraper with the internal secret
   instead of a session token. */
const INTERNAL_HEADERS = { 'Content-Type': 'application/json', 'x-internal-secret': internalSecret() };

function applyDlp(text, dlp) {
  if (!dlp || typeof text !== 'string') return text;
  let out = text;
  if (dlp.creditCard) out = out.replace(/\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, '[MASKED]');
  if (dlp.israeliId)  out = out.replace(/\b\d{9}\b/g, '[MASKED]');
  return out;
}

export function dlpMessages(messages, dlp) {
  if (!dlp) return messages;
  return messages.map(m => {
    if (m.role !== 'user' || typeof m.content !== 'string') return m;
    return { ...m, content: applyDlp(m.content, dlp) };
  });
}

function buildSystemPrompt(agent, ragChunks = []) {
  // Every chatbot is told the date, whatever else it is told.
  let system = `${nowBlock()}\n\n${agent.basePrompt || ''}`;
  if (ragChunks.length > 0) {
    system += '\n\n## Relevant Context\n' + ragChunks.map(c => `--- ${c.title}\n${c.content}`).join('\n\n');
  }
  if (agent.skills && agent.skills.length > 0) {
    system += '\n\n' + agent.skills.map(s =>
      `## Skill: ${s.name}\n${s.description ? s.description + '\n' : ''}${s.prompt}`
    ).join('\n\n');
  }
  const dlp = agent.dlp || {};
  if (dlp.creditCard || dlp.israeliId) {
    system += '\n\n[SECURITY NOTICE] Never process, repeat, or store personal identifiable information (PII). If the user provides sensitive data such as credit card numbers or ID numbers, refuse to repeat it and treat it as [MASKED].';
  }
  return system.trim();
}

export async function saveSession(sessionId, agentId, allMessages, source = 'widget', branchId = null) {
  if (!sessionId) return;
  try {
    await sql`
      insert into chat_sessions (id, agent_id, source, messages, branch_id, started_at, updated_at)
      values (${sessionId}, ${agentId}, ${source}, ${JSON.stringify(allMessages)}, ${branchId}, now(), now())
      on conflict (id) do update
        set messages   = excluded.messages,
            updated_at = now()
    `;
  } catch (_) {}
}

/**
 * Knowledge for the public channels (widget, WhatsApp).
 *
 * includeSkills is true here on purpose: buildSystemPrompt below appends every
 * skill's prompt unconditionally, so on these channels all skills are active
 * at once. Restricting retrieval to global documents — which is what this did —
 * meant a document attached to a skill was reachable from the test chat and
 * from nowhere else.
 */
async function retrieveRagChunks(agentId, query) {
  return searchDocuments({ agentId, query, includeSkills: true, limit: 5 });
}

const EMAIL_TOOL = {
  description: 'Send an email via the connected Gmail account. Use when explicitly instructed to send an email.',
  parameters: {
    to:      'Recipient email address',
    subject: 'Email subject line',
    body:    'Email body text',
  },
};

/* Only channels that keep a conversation open across messages (linked
   WhatsApp numbers) turn this on, with agent.canEndConversation. The channel
   reads `ended` from runAgentTurn and starts a fresh session next time. */
const END_CONVERSATION_TOOL = {
  name: 'end_conversation',
  description: 'End this conversation. Call it when the person asks to end, stop or close the conversation, or says goodbye with nothing left open. Then reply with a short goodbye: their next message starts a new conversation that does not remember this one.',
};

function buildOpenAITools(agent) {
  const toolDefs = (agent.tools || []).filter(t => t.name !== 'switch_skill' && !(agent.canEndConversation && t.name === END_CONVERSATION_TOOL.name));
  const tools = toolDefs.map(t => {
    const predefinedUrls = (agent.scrapeUrls || (agent.scrapeUrl ? [agent.scrapeUrl] : [])).map(u => u.trim()).filter(Boolean);
    const hasPredefinedUrl = t.name === 'scrape_website' && predefinedUrls.length > 0;
    const params = hasPredefinedUrl ? (t.parameters || []).filter(p => p.name !== 'url') : (t.parameters || []);
    return {
      type: 'function',
      function: {
        name: t.name,
        description: t.description + (hasPredefinedUrl ? ' (URL is preconfigured; call with no arguments.)' : ''),
        parameters: {
          type: 'object',
          properties: Object.fromEntries(params.map(p => [p.name, { type: p.type || 'string', description: p.description || '' }])),
          required: params.map(p => p.name),
        },
      },
    };
  });

  if (agent.emailEnabled) {
    tools.push({
      type: 'function',
      function: {
        name: 'send_email',
        description: EMAIL_TOOL.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            Object.entries(EMAIL_TOOL.parameters).map(([name, description]) => [name, { type: 'string', description }])
          ),
          required: Object.keys(EMAIL_TOOL.parameters),
        },
      },
    });
  }

  if ((agent.tables || []).length > 0) {
    for (const t of TABLE_TOOLS) {
      tools.push({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } });
    }
  }
  if ((agent.automations || []).length > 0) {
    for (const t of AUTOMATION_TOOLS) {
      tools.push({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } });
    }
  }
  if (agent.canEndConversation) {
    tools.push({ type: 'function', function: { ...END_CONVERSATION_TOOL, parameters: { type: 'object', properties: {} } } });
  }
  return tools;
}

async function executeTool(toolName, inputs, agent, baseUrl, agentId) {
  if (toolName === 'switch_skill') return 'OK';

  if (toolName.startsWith('table_')) {
    try {
      const [owner] = await sql`select user_id from agents where id = ${agentId}`;
      return await runAgentTableTool({
        toolName, inputs, agent, ownerId: owner && owner.user_id, writtenBy: agentId,
      });
    } catch (err) {
      await logError({ agentId, source: 'tool', message: `${toolName}: ${err.message}`, context: { tool: toolName } });
      return `The table tool failed: ${err.message}`;
    }
  }

  if (toolName === 'automation_list' || toolName === 'automation_run') {
    try {
      const [owner] = await sql`select user_id from agents where id = ${agentId}`;
      let host = null;
      try { host = new URL(baseUrl).host; } catch { /* no address to run code steps from */ }
      return await runAgentAutomationTool({ toolName, inputs, agent, ownerId: owner && owner.user_id, agentId, host });
    } catch (err) {
      await logError({ agentId, source: 'tool', message: `${toolName}: ${err.message}`, context: { tool: toolName } });
      return `The automation tool failed: ${err.message}`;
    }
  }

  if (toolName === 'send_email') {
    if (!agent.emailEnabled) return 'The send_email tool is disabled for this agent.';
    try {
      const { message } = await sendGmail({
        agentId,
        to: inputs.to,
        subject: inputs.subject,
        body: inputs.body,
      });
      return message;
    } catch (err) {
      console.error(`[send_email] agentId=${agentId} ${err.code || 'ERROR'}:`, err.message);
      await logError({ agentId, source: 'tool', message: `send_email: ${err.message}`, context: { tool: 'send_email', code: err.code || null, to: inputs.to || null } });
      return `Error: ${err.message}`;
    }
  }

  const predefinedUrls = (agent.scrapeUrls || (agent.scrapeUrl ? [agent.scrapeUrl] : [])).map(u => u.trim()).filter(Boolean);

  if (toolName === 'scrape_website') {
    const urls = predefinedUrls.length > 0
      ? predefinedUrls
      : (inputs.url ? [inputs.url] : []);

    if (urls.length === 0) return 'No URL provided';

    const results = await Promise.allSettled(
      urls.map(url =>
        fetch(`${baseUrl}/api/scrape-browser`, {
          method: 'POST',
          headers: INTERNAL_HEADERS,
          body: JSON.stringify({ url }),
        }).then(r => r.json())
      )
    );

    return results.map((r, i) => {
      const d = r.status === 'fulfilled' ? r.value : { error: r.reason?.message };
      return `=== ${urls[i]} ===\n${d.error ? 'Error: ' + d.error : (d.title ? 'Title: ' + d.title + '\n' : '') + (d.text || '')}`;
    }).join('\n\n');
  }

  const tool = (agent.tools || []).find(t => t.name === toolName);
  if (!tool) return `Unknown tool: ${toolName}`;

  const packages = (tool.packages || '').split(',').map(s => s.trim()).filter(Boolean);
  const envVars = Object.fromEntries((tool.envVars || []).filter(e => e.key).map(e => [e.key, e.value]));

  const resp = await fetch(`${baseUrl}/api/run-tool`, {
    method: 'POST',
    headers: INTERNAL_HEADERS,
    body: JSON.stringify({ code: tool.code || '', inputs, packages, env_vars: envVars }),
  });
  const data = await resp.json();

  // A tool that fails mid-conversation is the failure an assistant most needs
  // to see, and nobody is watching the logs when it happens.
  if (data.error) {
    await logError({ agentId, source: 'tool', message: String(data.error), context: { tool: toolName, inputs } });
    return String(data.error);
  }
  return String(data.result ?? 'No output');
}

/**
 * Runs one full agent turn (with RAG + DLP + tool-calling loop) against
 * whichever provider the agent is configured for. Returns
 * `{ text, safeMessages }` — `safeMessages` is the DLP-masked input history,
 * for callers that persist `[...safeMessages, {role:'assistant', content:text}]`.
 * Throws on failure; throws with `err.code === 'NO_API_KEY'` when the agent
 * has no key configured (and isn't using Ollama).
 */
export async function runAgentTurn({ agent, agentId, messages, baseUrl }) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  const ragChunks = lastUserMsg.trim() ? await retrieveRagChunks(agentId, lastUserMsg) : [];
  const systemPrompt = buildSystemPrompt(agent, ragChunks);
  const cfg = agent.apiConfig || {};
  const dlp = agent.dlp || {};
  const safeMessages = dlpMessages(messages, dlp);

  if (!configUsable(cfg)) {
    const err = new Error('The platform has not set up a model for this AI Chatbot\'s organization yet.');
    err.code = 'NO_API_KEY';
    throw err;
  }
  const meta = { orgId: cfg.orgId || null, source: 'agents', itemType: 'agent', itemId: agentId };

  let ended = false;
  const runTool = async (name, inputs) => {
    if (name === END_CONVERSATION_TOOL.name && agent.canEndConversation) {
      ended = true;
      return 'Done. Now say a short goodbye.';
    }
    return executeTool(name, inputs, agent, baseUrl, agentId);
  };

  let msgs = [{ role: 'system', content: systemPrompt }, ...safeMessages];

  for (let round = 0; round < 10; round++) {
    const body = { messages: msgs, max_tokens: 2048 };
    const openAITools = buildOpenAITools(agent);
    if (openAITools.length > 0) body.tools = openAITools;

    const { ok, data: d } = await llmFetch({ cfg, body, meta });
    if (!ok) throw new Error(d.error?.message || JSON.stringify(d));

    const choice = d.choices[0];
    const calls = (choice.message && choice.message.tool_calls) || [];
    if (!calls.length) {
      // A refusal or an empty answer: the callers turn '' into their own apology.
      return { text: replyText(d), safeMessages, ended };
    }

    const toolResultMsgs = await Promise.all(calls.map(async tc => {
      let inputs = {};
      try { inputs = JSON.parse(tc.function.arguments || '{}'); } catch { /* a model that wrote broken JSON gets an empty call */ }
      const result = await runTool(tc.function.name, inputs);
      return { role: 'tool', tool_call_id: tc.id, content: String(result) };
    }));

    msgs = [...msgs, choice.message, ...toolResultMsgs];
  }
  throw new Error('Too many tool call rounds (max 10)');
}
