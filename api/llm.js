import { requireSession } from './_auth.js';
import { member, accessTo, allows } from './_access.js';
import { getUserSettings, resolveApiConfig } from './_settings.js';
import { llmFetch, pingConfig } from './_llm.js';

/**
 * The browser's road to a model. The test chat, the building assistants,
 * Autopilot and the home chat post their request here and the server sends it
 * on the platform's OpenRouter key, on the model chosen for the caller's
 * organization.
 *
 *   POST { body, source, itemType?, itemId?, model? } → OpenRouter's answer, with its status
 *   POST { ping: true } → { ok, why } — can this organization reach a model now?
 *
 * `body` is a chat-completions request, and only the parts of one that the
 * platform's own screens use are passed on (ALLOWED below): anything else —
 * streaming, a list of fallback models, a provider or plugins — could change
 * what the call costs or how it is counted, so it is refused. Any member may
 * call it: a member who can only view a chatbot can still test it. Calls are
 * written to llm_usage against the caller, and against the item only when the
 * caller may see that item.
 *
 * `model` is the model of the item being tried (the chatbot open in the
 * editor, saved or not). It is used only if it is in the organization's list;
 * anything else runs on the organization's default.
 */
const SOURCES = new Set(['builder', 'test-chat', 'assistant', 'autopilot', 'home']);
const ITEM_TYPES = new Set(['agent', 'automation', 'app']);

const MAX_TOKENS = 8192;
const REFUSED = ['stream', 'stream_options', 'models', 'model', 'provider', 'plugins', 'transforms', 'route', 'n', 'usage', 'prediction', 'web_search_options'];
const ROLES = new Set(['system', 'user', 'assistant', 'tool']);

/** The request as it goes on, or { error }. */
export function allowedBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.messages)) {
    return { error: 'body.messages is required' };
  }
  for (const k of REFUSED) {
    /* `model` is the one exception the screens may send: it is replaced by the organization's anyway. */
    if (k !== 'model' && Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined && body[k] !== false && body[k] !== null) {
      return { error: `body.${k} is not allowed` };
    }
  }
  if (body.messages.length > 400) return { error: 'body.messages is too long' };
  for (const m of body.messages) {
    if (!m || typeof m !== 'object' || !ROLES.has(m.role)) return { error: 'every message needs a role: system, user, assistant or tool' };
  }
  const out = { messages: body.messages };
  const asked = Number(body.max_tokens);
  out.max_tokens = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), MAX_TOKENS) : 4096;
  if (Array.isArray(body.tools) && body.tools.length) {
    if (body.tools.length > 128) return { error: 'body.tools is too long' };
    out.tools = body.tools;
  }
  if (body.tool_choice !== undefined && (typeof body.tool_choice === 'string' || (body.tool_choice && typeof body.tool_choice === 'object'))) {
    out.tool_choice = body.tool_choice;
  }
  for (const k of ['temperature', 'top_p']) {
    const v = Number(body[k]);
    if (body[k] !== undefined && body[k] !== null && Number.isFinite(v)) out[k] = Math.max(0, Math.min(v, 2));
  }
  if (body.response_format && typeof body.response_format === 'object' && !Array.isArray(body.response_format)) {
    out.response_format = body.response_format;
  }
  return { body: out };
}

export default async function handler(req, res) {
  const user = await requireSession(req, res);
  if (!user) return;
  if (req.method !== 'POST') return res.status(405).end();

  const me = await member(user);
  if (!me || !me.orgId) return res.status(401).json({ error: { message: 'unauthorized' } });

  const b = req.body || {};
  const cfg = resolveApiConfig(await getUserSettings(user.userId), { model: typeof b.model === 'string' ? b.model : '' });

  if (b.ping) return res.json(await pingConfig(cfg));

  /* A page loaded before models moved to the platform still speaks Claude's
     shape; a reload gives it the new code. */
  if (b.format === 'anthropic') {
    return res.status(409).json({ error: { message: 'The platform was updated. Reload the page.', code: 'STALE' } });
  }
  const allowed = allowedBody(b.body);
  if (allowed.error) return res.status(400).json({ error: { message: allowed.error } });

  /* The item a call is charged to must be one this person may see: anything
     else (a chatbot not saved yet, or someone else's) is charged to nobody's
     item, only to the member. */
  let itemType = ITEM_TYPES.has(b.itemType) ? b.itemType : null;
  let itemId = itemType && typeof b.itemId === 'string' && b.itemId ? b.itemId.slice(0, 80) : null;
  if (itemType && itemId) {
    const { level } = await accessTo(user, itemType, itemId, me).catch(() => ({ level: 'none' }));
    if (!allows(level, 'view')) { itemType = null; itemId = null; }
  } else {
    itemType = null; itemId = null;
  }

  const meta = {
    orgId: me.orgId,
    userId: user.userId,
    source: SOURCES.has(b.source) ? b.source : 'browser',
    itemType,
    itemId,
  };

  try {
    const out = await llmFetch({ cfg, body: allowed.body, meta });
    return res.status(out.status).json(out.data);
  } catch (err) {
    return res.status(err.status || 502).json({ error: { message: err.message, code: err.code || 'PROVIDER' } });
  }
}
