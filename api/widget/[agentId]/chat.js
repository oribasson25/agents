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

  if (!apiKey) {
    return res.status(503).json({ error: 'Agent is not configured with an API key. Contact the site owner.' });
  }

  try {
    let llmRes, data;

    if (provider === 'claude') {
      llmRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model, max_tokens: 1024, system: systemPrompt, messages }),
      });
      data = await llmRes.json();
      if (!llmRes.ok) throw new Error(data.error?.message || JSON.stringify(data));
      return res.json({ content: data.content[0].text });

    } else {
      llmRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: systemPrompt }, ...messages],
        }),
      });
      data = await llmRes.json();
      if (!llmRes.ok) throw new Error(data.error?.message || JSON.stringify(data));
      return res.json({ content: data.choices[0].message.content });
    }

  } catch (err) {
    console.error(`[widget chat] agentId=${agentId} error:`, err.message);
    return res.status(500).json({ error: err.message });
  }
}
