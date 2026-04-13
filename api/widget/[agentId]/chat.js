import { sql } from '../../_db.js';

function buildSystemPrompt(agent) {
  let system = agent.basePrompt || '';
  if (agent.skills && agent.skills.length > 0) {
    system += '\n\n' + agent.skills.map(s =>
      `## Skill: ${s.name}\n${s.description ? s.description + '\n' : ''}${s.prompt}`
    ).join('\n\n');
  }
  return system.trim();
}

function buildClaudeTools(agent) {
  const toolDefs = agent.tools || [];
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
  const toolDefs = agent.tools || [];
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
  const { messages } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const [row] = await sql`select data from agents where id = ${agentId}`;
  if (!row) return res.status(404).json({ error: 'Agent not found' });

  const agent = row.data;
  const systemPrompt = buildSystemPrompt(agent);
  const apiKey   = (agent.apiConfig && agent.apiConfig.apiKey)   || '';
  const provider = (agent.apiConfig && agent.apiConfig.provider) || 'claude';
  const model    = (agent.apiConfig && agent.apiConfig.model)    || 'claude-sonnet-4-5';
  const toolDefs = agent.tools || [];

  if (!apiKey) {
    return res.status(503).json({ error: 'Agent is not configured with an API key. Contact the site owner.' });
  }

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const baseUrl = `${proto}://${req.headers.host}`;

  try {
    if (provider === 'claude') {
      let msgs = [...messages];

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

    } else {
      let msgs = [{ role: 'system', content: systemPrompt }, ...messages];

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
          return res.json({ content: choice.message.content });
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
