/**
 * The model gateway: every call to a model goes through here, on the
 * platform's one OpenRouter key. The key never leaves the server, and no
 * organization holds a key of its own.
 *
 * Callers send the chat-completions shape (OpenRouter's, which is OpenAI's)
 * and get OpenRouter's answer back unchanged. The model is always the one the
 * platform admin chose for the caller's organization, whatever the request
 * asked for.
 *
 * Every call that succeeds is written to llm_usage with the cost OpenRouter
 * reports. Before each call the month's spend is compared with the platform's
 * monthly ceiling, and once it is reached every call is refused with a
 * message: the platform stops itself rather than wait for OpenRouter's own
 * budget to refuse it. Nothing here throws over bookkeeping.
 */
import { sql } from './_db.js';
import { seal, unseal } from './_connections.js';

/* Overridable for local testing against a stand-in server; never set in production. */
export const OPENROUTER_BASE = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');

const fail = (message, code, status) => Object.assign(new Error(message), { code, status });

/* ─────────────────── the platform's settings ─────────────────── */

let platformCache = null;   // { at, key, defaultModel, ceiling }
const PLATFORM_TTL_MS = 30_000;

async function platform() {
  if (platformCache && Date.now() - platformCache.at < PLATFORM_TTL_MS) return platformCache;
  let row = null;
  try {
    [row] = await sql`select openrouter_key, default_model, monthly_ceiling_usd from platform_billing where id = true`;
  } catch (err) {
    console.warn('[llm] could not read the platform settings:', err.message);
  }
  let key = '';
  try { key = row && row.openrouter_key ? String(unseal(row.openrouter_key) || '') : ''; } catch (err) {
    console.warn('[llm] the stored OpenRouter key cannot be read:', err.message);
  }
  platformCache = {
    at: Date.now(),
    key,
    defaultModel: (row && row.default_model) || '',
    ceiling: row && row.monthly_ceiling_usd != null ? Number(row.monthly_ceiling_usd) : 50,
  };
  return platformCache;
}

/** The platform's OpenRouter key, or '' when none is set. */
export async function platformKey() {
  return (await platform()).key;
}

/** Stores the platform's OpenRouter key (sealed). An empty key removes it. */
export async function savePlatformKey(key, userId) {
  const k = String(key || '').trim();
  await sql`
    update platform_billing
    set openrouter_key = ${k ? seal(k) : ''}, key_hint = ${k ? k.slice(-4) : ''},
        updated_by = ${userId || null}, updated_at = now()
    where id = true
  `;
  platformCache = null;
}

/** The platform's default model and monthly ceiling. */
export async function savePlatformSettings({ defaultModel, monthlyCeilingUsd }, userId) {
  if (defaultModel !== undefined) {
    await sql`update platform_billing set default_model = ${String(defaultModel || '').trim()}, updated_by = ${userId || null}, updated_at = now() where id = true`;
  }
  if (monthlyCeilingUsd !== undefined) {
    await sql`update platform_billing set monthly_ceiling_usd = ${Number(monthlyCeilingUsd)}, updated_by = ${userId || null}, updated_at = now() where id = true`;
  }
  platformCache = null;
}

const orHeaders = (key) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${key}`,
  // How the calls are labelled on OpenRouter's own activity page.
  'HTTP-Referer': 'https://www.8legs.world',
  'X-Title': '8Legs.ai',
});

/**
 * What OpenRouter says about a key: whether it works, its limit and what is
 * left of it, and the workspace budget (guardrail) that applies to it.
 */
export async function describeOpenRouterKey(key, { fetchImpl = fetch } = {}) {
  if (!key) return { ok: false, why: 'No key.' };
  try {
    const r = await fetchImpl(`${OPENROUTER_BASE}/key`, { headers: orHeaders(key) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, why: (d.error && d.error.message) || `OpenRouter answered ${r.status}.` };
    const k = d.data || {};
    const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
    const budget = k.effective_budget && typeof k.effective_budget === 'object' ? k.effective_budget : null;
    return {
      ok: true,
      label: k.label || '',
      limit: num(k.limit),
      limitRemaining: num(k.limit_remaining),
      limitReset: k.limit_reset || null,
      usage: num(k.usage),
      usageMonthly: num(k.usage_monthly),
      budget,
      isManagementKey: !!k.is_management_key,
    };
  } catch (err) {
    return { ok: false, why: err.message };
  }
}

/* ─────────────────── the catalog ─────────────────── */

let catalogCache = null;   // { at, models }
const CATALOG_TTL_MS = 10 * 60_000;

/**
 * OpenRouter's models, with what each costs (USD per million tokens) and what
 * it can do. Public: needs no key.
 */
export async function openRouterModels({ fetchImpl = fetch } = {}) {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.models;
  const r = await fetchImpl(`${OPENROUTER_BASE}/models`);
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !Array.isArray(d.data)) throw new Error((d.error && d.error.message) || `OpenRouter's model list answered ${r.status}`);
  const perM = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 10000) / 10000 : null;
  };
  const models = d.data.map((m) => {
    const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
    const inputs = (m.architecture && Array.isArray(m.architecture.input_modalities)) ? m.architecture.input_modalities : [];
    return {
      id: m.id,
      name: m.name || m.id,
      contextLength: m.context_length || null,
      inputPerM: perM(m.pricing && m.pricing.prompt),
      outputPerM: perM(m.pricing && m.pricing.completion),
      tools: params.includes('tools'),
      structured: params.includes('structured_outputs'),
      images: inputs.includes('image'),
      files: inputs.includes('file'),
      maxOutput: (m.top_provider && Number(m.top_provider.max_completion_tokens)) || null,
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
  catalogCache = { at: Date.now(), models };
  return models;
}

/** One model from the catalog, or null (also null when the catalog cannot be read). */
export async function modelInfo(id) {
  try { return (await openRouterModels()).find((m) => m.id === id) || null; } catch { return null; }
}

/* ─────────────────── the monthly ceiling ─────────────────── */

const monthStart = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

let spendCache = null;   // { at, month, usd }
const SPEND_TTL_MS = 15_000;

/** What the platform has spent through OpenRouter this calendar month (UTC), in USD. */
export async function monthSpendUsd({ fresh = false } = {}) {
  const month = monthStart();
  if (!fresh && spendCache && spendCache.month === month && Date.now() - spendCache.at < SPEND_TTL_MS) return spendCache.usd;
  let usd = 0;
  try {
    const [row] = await sql`select coalesce(sum(cost_usd), 0) as usd from llm_usage where at >= ${month}`;
    usd = Number(row && row.usd) || 0;
  } catch (err) {
    console.warn('[llm] could not sum this month\'s spend:', err.message);
  }
  spendCache = { at: Date.now(), month, usd };
  return usd;
}

export const BUDGET_MESSAGE = 'The platform\'s model budget for this month is used up. It starts again on the 1st.';

/* ─────────────────── sending ─────────────────── */

/**
 * Sends one chat-completions request on the platform's key and returns
 * `{ ok, status, data }` — `data` is OpenRouter's JSON (an error body when not
 * ok). Throws only when the call cannot be made at all; `err.code` is
 * NO_MODEL, NO_PLATFORM_KEY or BUDGET, and `err.status` says how to answer it.
 *
 * @param {object} p
 * @param {object} p.cfg      what resolveApiConfig returns: { model, ready, orgId }
 * @param {object} p.body     the request; its `model` is replaced by the organization's
 * @param {object} [p.meta]   { orgId, userId, ownerId, source, itemType, itemId } — for llm_usage
 */
export async function llmFetch({ cfg, body, meta = {}, fetchImpl = fetch }) {
  const p = await platform();
  if (!p.key) throw fail('The platform has no OpenRouter key yet.', 'NO_PLATFORM_KEY', 503);
  if (!cfg || !cfg.model) throw fail('The platform has not chosen a model for this organization yet.', 'NO_MODEL', 400);
  if (p.ceiling > 0 && (await monthSpendUsd()) >= p.ceiling) throw fail(BUDGET_MESSAGE, 'BUDGET', 402);

  const request = { ...body, model: cfg.model };
  const r = await fetchImpl(`${OPENROUTER_BASE}/chat/completions`, { method: 'POST', headers: orHeaders(p.key), body: JSON.stringify(request) });
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: { message: text.slice(0, 500) || `HTTP ${r.status}` } }; }

  // OpenRouter can answer 200 with an error inside, when the upstream provider failed mid-way.
  const ok = r.ok && !!data && Array.isArray(data.choices) && !data.error;
  if (ok) {
    await recordCall({ cfg, meta, model: data.model || request.model, usage: data.usage || {} });
    return { ok, status: r.status, data };
  }
  const status = r.ok ? 502 : r.status;
  /* 402: out of credit; 403: a guardrail (the workspace budget) refused it.
     Either way it is the platform's budget, and the people using a chatbot
     should read that, not OpenRouter's wording. */
  if (status === 402 || (status === 403 && /budget|limit|credit/i.test(JSON.stringify(data)))) {
    data = { error: { message: BUDGET_MESSAGE, code: 'BUDGET', upstream: data && data.error } };
  }
  return { ok: false, status, data };
}

/** The text of a chat-completions answer. */
export function replyText(data) {
  const m = data && data.choices && data.choices[0] && data.choices[0].message;
  if (!m) return '';
  if (typeof m.content === 'string') return m.content.trim();
  if (Array.isArray(m.content)) return m.content.map((c) => (typeof c === 'string' ? c : c.text || '')).join('').trim();
  return '';
}

/**
 * Searches the web for one question, with whichever model the organization
 * runs on: OpenRouter's web plugin fetches the results and the model answers
 * from them. Returns the answer and the sources it came from.
 */
export async function webSearch({ cfg, query, meta = {}, fetchImpl = fetch }) {
  const { ok, data } = await llmFetch({
    cfg, meta, fetchImpl,
    body: {
      messages: [
        { role: 'system', content: 'Answer the question from the web results you are given. Be factual and brief; keep the numbers, names and dates. Say when the results do not answer it.' },
        { role: 'user', content: String(query || '').slice(0, 1000) },
      ],
      plugins: [{ id: 'web', max_results: 5 }],
      max_tokens: 1200,
    },
  });
  if (!ok) return { error: (data.error && data.error.message) || 'The search failed.' };
  const annotations = (data.choices[0].message && data.choices[0].message.annotations) || [];
  const sources = annotations.filter((a) => a && a.type === 'url_citation' && a.url_citation)
    .map((a) => ({ url: a.url_citation.url, title: a.url_citation.title || '' }));
  return { answer: replyText(data), sources };
}

/* ─────────────────── counting ─────────────────── */

const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);
const money = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** Token counts and cost of a chat-completions `usage`, as OpenRouter reports them. */
export function chatUsage(usage = {}) {
  const details = usage.prompt_tokens_details || {};
  return {
    input: n(usage.prompt_tokens),
    output: n(usage.completion_tokens),
    read: n(details.cached_tokens),
    write: n(details.cache_write_tokens),
    // OpenRouter reports what the call cost in USD on every response.
    cost: money(usage.cost),
  };
}

const orgOfUser = new Map();   // userId -> org id, for the life of this instance
async function orgOf(userId) {
  if (!userId) return null;
  if (!orgOfUser.has(userId)) {
    const [row] = await sql`select org_id from users where id = ${userId}`;
    orgOfUser.set(userId, (row && row.org_id) || null);
  }
  return orgOfUser.get(userId);
}

async function recordCall({ cfg, meta, model, usage }) {
  try {
    const u = chatUsage(usage);
    const org = meta.orgId || cfg.orgId || (await orgOf(meta.userId || meta.ownerId));
    await sql`
      insert into llm_usage (org_id, user_id, via, source, item_type, item_id, model,
                             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
      values (${org || null}, ${meta.userId || null}, 'openrouter', ${String(meta.source || 'other').slice(0, 40)},
              ${meta.itemType ? String(meta.itemType).slice(0, 20) : null}, ${meta.itemId ? String(meta.itemId).slice(0, 80) : null},
              ${String(model || 'unknown').slice(0, 120)}, ${u.input}, ${u.output}, ${u.read}, ${u.write}, ${u.cost})
    `;
    if (spendCache && u.cost) spendCache.usd += u.cost;
  } catch (err) {
    console.warn('[llm] could not record a call:', err.message);
  }
}

/* ─────────────────── checking ─────────────────── */

/** Whether a config can reach a model right now. For the browser, which holds no key. */
export async function pingConfig(cfg, { fetchImpl = fetch } = {}) {
  if (!cfg || !cfg.model) return { ok: false, why: 'The platform has not chosen a model for this organization yet.' };
  const p = await platform();
  if (p.ceiling > 0 && (await monthSpendUsd()) >= p.ceiling) return { ok: false, why: BUDGET_MESSAGE };
  const info = await describeOpenRouterKey(p.key, { fetchImpl });
  return info.ok ? { ok: true } : { ok: false, why: info.why };
}
