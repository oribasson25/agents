import { sql } from '../../_db.js';
import { runAgentTurn, saveSession, claimSession, publicHistory, validSessionId, appBaseUrl } from '../../_agentRunner.js';
import { getUserSettings, resolveApiConfig } from '../../_settings.js';
import { logError } from '../../_errorLog.js';
import { isStopped, stopMessage } from '../../_llm.js';
import { branchForSession, loadForConversation } from '../../_branches.js';
import { rateLimit, clientIp } from '../../_throttle.js';

/* How often one visitor may write. A person types far slower than this; a
   script does not, and every turn is paid for by the chatbot's organization. */
const PER_IP_PER_MINUTE = 20;
const PER_SESSION_PER_MINUTE = 10;

/**
 * One turn of a conversation on a chatbot's public widget (and the editor's
 * live chat, which is the same path). Anyone on the internet may call it.
 *
 *   POST { messages: [{ role: 'user'|'assistant', content }], sessionId? } → { content }
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { agentId } = req.query;
  const { messages, sessionId: rawSession } = req.body || {};

  const history = publicHistory(messages);
  if (history.error) return res.status(400).json({ error: history.error });
  if (rawSession !== undefined && rawSession !== null && rawSession !== '' && !validSessionId(rawSession)) {
    return res.status(400).json({ error: 'sessionId must be up to 120 letters, digits or _ . : + -, and may not start with wa_ or wal_' });
  }
  const sessionId = rawSession || null;

  const ip = clientIp(req);
  const allowed = await Promise.all([
    rateLimit(`widget-ip:${ip}`, PER_IP_PER_MINUTE, 60),
    sessionId ? rateLimit(`widget-session:${agentId}:${sessionId}`, PER_SESSION_PER_MINUTE, 60) : true,
  ]);
  if (allowed.includes(false)) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: 'Too many messages. Wait a minute and try again.' });
  }

  try {
    const [row] = await sql`select data, user_id from agents where id = ${agentId}`;
    if (!row) return res.status(404).json({ error: 'Agent not found' });

    /* A conversation id the client chose is only this chatbot's to write to:
       one already stored for another chatbot, or another channel, is not
       touched, and no model is called for it. */
    const [claim, settings] = await Promise.all([
      claimSession(sessionId, agentId, 'widget'),
      row.user_id ? getUserSettings(row.user_id) : null,
    ]);
    if (!claim.ok) return res.status(409).json({ error: 'This conversation cannot be continued here. Reload the page to start a new one.' });

    // Which version of the agent answers: main, or a branch taking a share of
    // conversations. Decided once per conversation and then kept on the session.
    const branchId = claim.exists ? claim.branchId : await branchForSession(agentId, null);
    const chosen = branchId ? await loadForConversation(agentId, branchId) : { agent: row.data, branchId: null };

    // The key, provider and model come from the owner's account settings.
    const agent = { ...chosen.agent, apiConfig: resolveApiConfig(settings, { model: chosen.agent && chosen.agent.model }) };
    const baseUrl = appBaseUrl(req);

    const { text, safeMessages } = await runAgentTurn({ agent, agentId, messages: history.messages, baseUrl });
    const finalMessages = [...safeMessages, { role: 'assistant', content: text }];
    if (sessionId) await saveSession(sessionId, agentId, finalMessages, 'widget', chosen.branchId);
    return res.json({ content: text });

  } catch (err) {
    /* The organization ran out, or the platform reached its ceiling: the
       visitor reads the platform's stop message, and the conversation is not
       stored, so the next try after a top-up starts clean. */
    if (isStopped(err)) {
      const last = history.messages[history.messages.length - 1];
      return res.json({ content: await stopMessage(last && last.content), stopped: true });
    }
    if (err.code === 'NO_API_KEY') {
      await logError({ agentId, source: 'widget', message: err.message, context: { code: 'NO_API_KEY' } });
      return res.status(503).json({ error: 'This chatbot is not available right now.' });
    }
    /* What went wrong is the owner's to read in the error log, not the visitor's. */
    console.error(`[widget chat] agentId=${agentId} error:`, err.message);
    await logError({ agentId, source: 'widget', message: err.message, context: { sessionId, code: err.code || null } });
    return res.status(err.status === 503 ? 503 : 500).json({ error: 'Something went wrong. Please try again.' });
  }
}
