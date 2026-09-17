import { sql } from '../../_db.js';
import { runAgentTurn, saveSession } from '../../_agentRunner.js';
import { resolveAgentApiConfig } from '../../_settings.js';
import { logError } from '../../_errorLog.js';
import { branchForSession, loadForConversation } from '../../_branches.js';

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

  const [row] = await sql`select data, user_id from agents where id = ${agentId}`;
  if (!row) return res.status(404).json({ error: 'Agent not found' });

  // Which version of the agent answers: main, or a branch taking a share of
  // conversations. Decided once per conversation and then kept on the session.
  const branchId = await branchForSession(agentId, sessionId);
  const chosen = await loadForConversation(agentId, branchId);

  // The key, provider and model come from the owner's account settings.
  const agent = { ...chosen.agent, apiConfig: await resolveAgentApiConfig(row) };
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const baseUrl = `${proto}://${req.headers.host}`;

  try {
    const { text, safeMessages } = await runAgentTurn({ agent, agentId, messages, baseUrl });
    const finalMessages = [...safeMessages, { role: 'assistant', content: text }];
    await saveSession(sessionId, agentId, finalMessages, 'widget', chosen.branchId);
    return res.json({ content: text });

  } catch (err) {
    if (err.code === 'NO_API_KEY') {
      await logError({ agentId, source: 'widget', message: err.message, context: { code: 'NO_API_KEY' } });
      return res.status(503).json({ error: err.message });
    }
    console.error(`[widget chat] agentId=${agentId} error:`, err.message);
    await logError({ agentId, source: 'widget', message: err.message, context: { sessionId: sessionId || null } });
    return res.status(500).json({ error: err.message });
  }
}
