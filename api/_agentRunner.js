import { sql } from './_db.js';
import { sendGmail } from './_gmail.js';

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
  let system = agent.basePrompt || '';
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

export async function saveSession(sessionId, agentId, allMessages, source = 'widget') {
  if (!sessionId) return;
  try {
    await sql`
      insert into chat_sessions (id, agent_id, source, messages, started_at, updated_at)
      values (${sessionId}, ${agentId}, ${source}, ${JSON.stringify(allMessages)}, now(), now())
      on conflict (id) do update
        set messages   = excluded.messages,
            updated_at = now()
    `;
  } catch (_) {}
}

async function retrieveRagChunks(agentId, query) {
  try {
    const chunks = await sql`
      select title, content
      from documents
      where agent_id = ${agentId}
        and skill_id is null
        and tsv @@ plainto_tsquery('simple', ${query})
      order by ts_rank(tsv, plainto_tsquery('simple', ${query})) desc
      limit 5
    `;
    return chunks;
  } catch (_) {
    return [];
  }
}

const EMAIL_TOOL = {
  description: 'Send an email via the connected Gmail account. Use when explicitly instructed to send an email.',
  parameters: {
    to:      'Recipient email address',
    subject: 'Email subject line',
    body:    'Email body text',
  },
};

function buildClaudeTools(agent) {
  const toolDefs = (agent.tools || []).filter(t => t.name !== 'switch_skill');
  const tools = toolDefs.map(t => {
    const predefinedUrls = (agent.scrapeUrls || (agent.scrapeUrl ? [agent.scrapeUrl] : [])).map(u => u.trim()).filter(Boolean);
    const hasPredefinedUrl = t.name === 'scrape_website' && predefinedUrls.length > 0;
    const params = hasPredefinedUrl ? (t.parameters || []).filter(p => p.name !== 'url') : (t.parameters || []);
    return {
      name: t.name,
      description: t.description + (hasPredefinedUrl ? ' (URL is preconfigured; call with no arguments.)' : ''),
      input_schema: {
        type: 'object',
        properties: Object.fromEntries(params.map(p => [p.name, { type: p.type || 'string', description: p.description || '' }])),
        required: params.map(p => p.name),
      },
    };
  });

  if (agent.emailEnabled) {
    tools.push({
      name: 'send_email',
      description: EMAIL_TOOL.description,
      input_schema: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(EMAIL_TOOL.parameters).map(([name, description]) => [name, { type: 'string', description }])
        ),
        required: Object.keys(EMAIL_TOOL.parameters),
      },
    });
  }
  return tools;
}

function buildOpenAITools(agent) {
  const toolDefs = (agent.tools || []).filter(t => t.name !== 'switch_skill');
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
  return tools;
}

async function executeTool(toolName, inputs, agent, baseUrl, agentId) {
  if (toolName === 'switch_skill') return 'OK';

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
          headers: { 'Content-Type': 'application/json' },
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: tool.code || '', inputs, packages, env_vars: envVars }),
  });
  const data = await resp.json();
  return String(data.result ?? data.error ?? 'No output');
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
  const apiKey     = (agent.apiConfig && agent.apiConfig.apiKey)     || '';
  const provider   = (agent.apiConfig && agent.apiConfig.provider)   || 'claude';
  const model      = (agent.apiConfig && agent.apiConfig.model)      || 'claude-sonnet-4-5';
  const ollamaHost = ((agent.apiConfig && agent.apiConfig.ollamaHost) || 'http://localhost:11434').replace(/\/$/, '');
  const dlp        = agent.dlp || {};
  const safeMessages = dlpMessages(messages, dlp);

  if (!apiKey && provider !== 'ollama') {
    const err = new Error('Agent is not configured with an API key. Contact the site owner.');
    err.code = 'NO_API_KEY';
    throw err;
  }

  if (provider === 'claude') {
    let msgs = [...safeMessages];

    for (let round = 0; round < 10; round++) {
      const body = { model, max_tokens: 1024, system: systemPrompt, messages: msgs };
      const claudeTools = buildClaudeTools(agent);
      if (claudeTools.length > 0) body.tools = claudeTools;

      const llmRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
      });
      const d = await llmRes.json();
      if (!llmRes.ok) throw new Error(d.error?.message || JSON.stringify(d));

      if (d.stop_reason !== 'tool_use') {
        return { text: d.content.find(c => c.type === 'text')?.text || '', safeMessages };
      }

      const toolUses = d.content.filter(c => c.type === 'tool_use');
      const toolResults = await Promise.all(toolUses.map(async tu => {
        const result = await executeTool(tu.name, tu.input, agent, baseUrl, agentId);
        return { type: 'tool_result', tool_use_id: tu.id, content: result };
      }));

      msgs = [...msgs, { role: 'assistant', content: d.content }, { role: 'user', content: toolResults }];
    }
    throw new Error('Too many tool call rounds (max 10)');

  } else if (provider === 'ollama') {
    let msgs = [{ role: 'system', content: systemPrompt }, ...safeMessages];

    for (let round = 0; round < 10; round++) {
      const body = { model, messages: msgs };
      const openAITools = buildOpenAITools(agent);
      if (openAITools.length > 0) body.tools = openAITools;

      const llmRes = await fetch(`${ollamaHost}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await llmRes.json();
      if (!llmRes.ok) throw new Error(d.error?.message || JSON.stringify(d));

      const choice = d.choices[0];
      if (choice.finish_reason !== 'tool_calls') {
        return { text: choice.message.content, safeMessages };
      }

      const toolResultMsgs = await Promise.all((choice.message.tool_calls || []).map(async tc => {
        const inputs = JSON.parse(tc.function.arguments);
        const result = await executeTool(tc.function.name, inputs, agent, baseUrl, agentId);
        return { role: 'tool', tool_call_id: tc.id, content: result };
      }));

      msgs = [...msgs, choice.message, ...toolResultMsgs];
    }
    throw new Error('Too many tool call rounds (max 10)');

  } else {
    let msgs = [{ role: 'system', content: systemPrompt }, ...safeMessages];

    for (let round = 0; round < 10; round++) {
      const body = { model, messages: msgs };
      const openAITools = buildOpenAITools(agent);
      if (openAITools.length > 0) body.tools = openAITools;

      const llmRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
      const d = await llmRes.json();
      if (!llmRes.ok) throw new Error(d.error?.message || JSON.stringify(d));

      const choice = d.choices[0];
      if (choice.finish_reason !== 'tool_calls') {
        return { text: choice.message.content, safeMessages };
      }

      const toolResultMsgs = await Promise.all((choice.message.tool_calls || []).map(async tc => {
        const inputs = JSON.parse(tc.function.arguments);
        const result = await executeTool(tc.function.name, inputs, agent, baseUrl, agentId);
        return { role: 'tool', tool_call_id: tc.id, content: result };
      }));

      msgs = [...msgs, choice.message, ...toolResultMsgs];
    }
    throw new Error('Too many tool call rounds (max 10)');
  }
}
