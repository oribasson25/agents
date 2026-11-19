import { checkAuth } from './_auth.js';
import { member } from './_access.js';
import { getUserSettings, resolveApiConfig } from './_settings.js';
import { llmFetch, pingConfig } from './_llm.js';

/**
 * The browser's road to a model. The test chat, the building assistants,
 * Autopilot and the home chat post their request here and the server sends it
 * on the platform's OpenRouter key, on the model chosen for the caller's
 * organization.
 *
 *   POST { body, source, itemType?, itemId? } → OpenRouter's answer, with its status
 *   POST { ping: true } → { ok, why } — can this organization reach a model now?
 *
 * `body` is a chat-completions request. Any member may call it: a member who
 * can only view a chatbot can still test it. Calls are written to llm_usage
 * against the caller.
 */
const SOURCES = new Set(['builder', 'test-chat', 'assistant', 'autopilot', 'home']);
const ITEM_TYPES = new Set(['agent', 'automation', 'app']);

export default async function handler(req, res) {
  const user = checkAuth(req, res);
  if (!user) return;
  if (req.method !== 'POST') return res.status(405).end();

  const me = await member(user);
  if (!me || !me.orgId) return res.status(401).json({ error: { message: 'unauthorized' } });

  const cfg = resolveApiConfig(await getUserSettings(user.userId));
  const b = req.body || {};

  if (b.ping) return res.json(await pingConfig(cfg));

  /* A page loaded before models moved to the platform still speaks Claude's
     shape; a reload gives it the new code. */
  if (b.format === 'anthropic') {
    return res.status(409).json({ error: { message: 'The platform was updated. Reload the page.', code: 'STALE' } });
  }
  const body = b.body;
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) {
    return res.status(400).json({ error: { message: 'body.messages is required' } });
  }

  const meta = {
    orgId: me.orgId,
    userId: user.userId,
    source: SOURCES.has(b.source) ? b.source : 'browser',
    itemType: ITEM_TYPES.has(b.itemType) ? b.itemType : null,
    itemId: ITEM_TYPES.has(b.itemType) && typeof b.itemId === 'string' ? b.itemId.slice(0, 80) : null,
  };

  try {
    const out = await llmFetch({ cfg, body, meta });
    return res.status(out.status).json(out.data);
  } catch (err) {
    return res.status(err.status || 502).json({ error: { message: err.message, code: err.code || 'PROVIDER' } });
  }
}
