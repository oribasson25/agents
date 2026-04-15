import { sql } from '../../_db.js';

function applyDlp(text, dlp) {
  if (!dlp || typeof text !== 'string') return text;
  let out = text;
  if (dlp.creditCard) out = out.replace(/\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, '[MASKED]');
  if (dlp.israeliId)  out = out.replace(/\b\d{9}\b/g, '[MASKED]');
  return out;
}

function dlpMessages(messages, dlp) {
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

async function saveSession(sessionId, agentId, allMessages) {
  if (!sessionId) return;
  try {
    await sql`
      insert into chat_sessions (id, agent_id, source, messages, started_at, updated_at)
      values (${sessionId}, ${agentId}, 'widget', ${JSON.stringify(allMessages)}, now(), now())
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

function buildClaudeTools(agent) {
  const toolDefs = (agent.tools || []).filter(t => t.name !== 'switch_skill');
  return toolDefs.map(t => {
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
}

function buildOpenAITools(agent) {
  const toolDefs = (agent.tools || []).filter(t => t.name !== 'switch_skill');
  return toolDefs.map(t => {
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
}

async function executeTool(toolName, inputs, agent, baseUrl) {
  if (toolName === 'switch_skill') return 'OK';

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { agentId } = req.query;
  const { messages, sessionId } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const [row] = await sql`select data from agents where id = ${agentId}`;
  if (!row) return res.status(404).json({ error: 'Agent not found' });

  const agent = row.data;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const baseUrl = `${proto}://${req.headers.host}`;
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  const ragChunks = lastUserMsg.trim() ? await retrieveRagChunks(agentId, lastUserMsg) : [];
  const systemPrompt = buildSystemPrompt(agent, ragChunks);
  const apiKey     = (agent.apiConfig && agent.apiConfig.apiKey)     || '';
  const provider   = (agent.apiConfig && agent.apiConfig.provider)   || 'claude';
  const model      = (agent.apiConfig && agent.apiConfig.model)      || 'claude-sonnet-4-5';
  const ollamaHost = ((agent.apiConfig && agent.apiConfig.ollamaHost) || 'http://localhost:11434').replace(/\/$/, '');
  const dlp        = agent.dlp || {};
  const toolDefs   = agent.tools || [];
  const safeMessages = dlpMessages(messages, dlp);

  if (!apiKey && provider !== 'ollama') {
    return res.status(503).json({ error: 'Agent is not configured with an API key. Contact the site owner.' });
  }

  try {
    if (provider === 'claude') {
      let msgs = [...safeMessages];

      for (let round = 0; round < 10; round++) {
        const body = { model, max_tokens: 1024, system: systemPrompt, messages: msgs };
        if (toolDefs.length > 0) body.tools = buildClaudeTools(agent);

        const llmRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify(body),
        });
        const d = await llmRes.json();
        if (!llmRes.ok) throw new Error(d.error?.message || JSON.stringify(d));

        if (d.stop_reason !== 'tool_use') {
          const text = d.content.find(c => c.type === 'text')?.text || '';
          const finalMessages = [...safeMessages, { role: 'assistant', content: text }];
          await saveSession(sessionId, agentId, finalMessages);
          return res.json({ content: text });
        }

        const toolUses = d.content.filter(c => c.type === 'tool_use');
        const toolResults = await Promise.all(toolUses.map(async tu => {
          const result = await executeTool(tu.name, tu.input, agent, baseUrl);
          return { type: 'tool_result', tool_use_id: tu.id, content: result };
        }));

        msgs = [...msgs, { role: 'assistant', content: d.content }, { role: 'user', content: toolResults }];
      }
      throw new Error('Too many tool call rounds (max 10)');

    } else if (provider === 'ollama') {
      let msgs = [{ role: 'system', content: systemPrompt }, ...safeMessages];

      for (let round = 0; round < 10; round++) {
        const body = { model, messages: msgs };
        if (toolDefs.length > 0) body.tools = buildOpenAITools(agent);

        const llmRes = await fetch(`${ollamaHost}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const d = await llmRes.json();
        if (!llmRes.ok) throw new Error(d.error?.message || JSON.stringify(d));

        const choice = d.choices[0];
        if (choice.finish_reason !== 'tool_calls') {
          const text = choice.message.content;
          const finalMessages = [...safeMessages, { role: 'assistant', content: text }];
          await saveSession(sessionId, agentId, finalMessages);
          return res.json({ content: text });
        }

        const toolResultMsgs = await Promise.all((choice.message.tool_calls || []).map(async tc => {
          const inputs = JSON.parse(tc.function.arguments);
          const result = await executeTool(tc.function.name, inputs, agent, baseUrl);
          return { role: 'tool', tool_call_id: tc.id, content: result };
        }));

        msgs = [...msgs, choice.message, ...toolResultMsgs];
      }
      throw new Error('Too many tool call rounds (max 10)');

    } else {
      let msgs = [{ role: 'system', content: systemPrompt }, ...safeMessages];

      for (let round = 0; round < 10; round++) {
        const body = { model, messages: msgs };
        if (toolDefs.length > 0) body.tools = buildOpenAITools(agent);

        const llmRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          body: JSON.stringify(body),
        });
        const d = await llmRes.json();
        if (!llmRes.ok) throw new Error(d.error?.message || JSON.stringify(d));

        const choice = d.choices[0];
        if (choice.finish_reason !== 'tool_calls') {
          const text = choice.message.content;
          const finalMessages = [...safeMessages, { role: 'assistant', content: text }];
          await saveSession(sessionId, agentId, finalMessages);
          return res.json({ content: text });
        }

        const toolResultMsgs = await Promise.all((choice.message.tool_calls || []).map(async tc => {
          const inputs = JSON.parse(tc.function.arguments);
          const result = await executeTool(tc.function.name, inputs, agent, baseUrl);
          return { role: 'tool', tool_call_id: tc.id, content: result };
        }));

        msgs = [...msgs, choice.message, ...toolResultMsgs];
      }
      throw new Error('Too many tool call rounds (max 10)');
    }

  } catch (err) {
    console.error(`[widget chat] agentId=${agentId} error:`, err.message);
    return res.status(500).json({ error: err.message });
  }
}
