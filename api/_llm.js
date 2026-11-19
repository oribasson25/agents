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
 * Money, before each call: what the call can cost at most is HELD, in one
 * statement, against everything that may refuse it — the platform's monthly
 * ceiling, the share of it one organization's strangers may use, the
 * organization's balance, and the monthly limits its admin set on the item
 * and on the member. Any one refuses the call, with a message, and nothing is
 * sent. Holding (rather than only checking) is what stops fifty calls sent at
 * once from all seeing the same balance and all going through.
 *
 * After the call, the hold is settled to what the call really cost: the
 * llm_usage row is written, the organization charged (OpenRouter's cost plus
 * its markup), and the monthly counters (llm_month_spend) moved on, all in
 * one statement. A call that failed gives its hold back, and is still counted
 * when OpenRouter says it cost something.
 *
 * Where it cannot tell, it refuses: a database that cannot be read means no
 * call is made (money fails closed), except while migration 037 has not run
 * yet, when the older sum-based checks are used.
 */
import { sql } from './_db.js';
import { seal, unseal } from './_connections.js';
import { logError } from './_errorLog.js';

/* Overridable for local testing against a stand-in server; never set in production. */
export const OPENROUTER_BASE = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');

const fail = (message, code, status) => Object.assign(new Error(message), { code, status });

/* ─────────────────── the platform's settings ─────────────────── */

let platformCache = null;   // { at, key, defaultModel, ceiling, publicPct, stopHe, stopEn }
const PLATFORM_TTL_MS = 30_000;

async function platform() {
  if (platformCache && Date.now() - platformCache.at < PLATFORM_TTL_MS) return platformCache;
  let row = null;
  try {
    [row] = await sql`select * from platform_billing where id = true`;
  } catch (err) {
    console.warn('[llm] could not read the platform settings:', err.message);
  }
  let key = '';
  try { key = row && row.openrouter_key ? String(unseal(row.openrouter_key) || '') : ''; } catch (err) {
    console.warn('[llm] the stored OpenRouter key cannot be read:', err.message);
  }
  const pct = row && row.org_public_cap_pct != null && Number.isFinite(Number(row.org_public_cap_pct)) ? Number(row.org_public_cap_pct) : 50;
  platformCache = {
    at: Date.now(),
    key,
    defaultModel: (row && row.default_model) || '',
    ceiling: row && row.monthly_ceiling_usd != null ? Number(row.monthly_ceiling_usd) : 50,
    publicPct: pct,
    stopHe: (row && row.stop_message_he) || '',
    stopEn: (row && row.stop_message_en) || '',
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

/**
 * The platform's default model, monthly ceiling (USD, more than 0), stop
 * message, and the share of the ceiling (percent) one organization's
 * strangers may use up.
 */
export async function savePlatformSettings({ defaultModel, monthlyCeilingUsd, stopMessageHe, stopMessageEn, orgPublicCapPct }, userId) {
  if (stopMessageHe !== undefined || stopMessageEn !== undefined) {
    await sql`
      update platform_billing
      set stop_message_he = coalesce(${stopMessageHe === undefined ? null : String(stopMessageHe).trim().slice(0, 500)}, stop_message_he),
          stop_message_en = coalesce(${stopMessageEn === undefined ? null : String(stopMessageEn).trim().slice(0, 500)}, stop_message_en),
          updated_by = ${userId || null}, updated_at = now()
      where id = true
    `;
  }
  if (defaultModel !== undefined) {
    await sql`update platform_billing set default_model = ${String(defaultModel || '').trim()}, updated_by = ${userId || null}, updated_at = now() where id = true`;
  }
  if (monthlyCeilingUsd !== undefined) {
    await sql`update platform_billing set monthly_ceiling_usd = ${Number(monthlyCeilingUsd)}, updated_by = ${userId || null}, updated_at = now() where id = true`;
  }
  if (orgPublicCapPct !== undefined) {
    await sql`update platform_billing set org_public_cap_pct = ${Number(orgPublicCapPct)}, updated_by = ${userId || null}, updated_at = now() where id = true`;
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
      // For the admin's model picker: when OpenRouter added it, the start of
      // its description, and the day OpenRouter stops serving it, if set.
      created: Number(m.created) || null,
      about: String(m.description || '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')   // markdown links → their words
        .replace(/[*_`#]+/g, '')
        .replace(/\s+/g, ' ').trim().slice(0, 220),
      expires: m.expiration_date || null,
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
  catalogCache = { at: Date.now(), models };
  return models;
}

/** One model from the catalog, or null (also null when the catalog cannot be read). */
export async function modelInfo(id, { fetchImpl = fetch } = {}) {
  try { return (await openRouterModels({ fetchImpl })).find((m) => m.id === id) || null; } catch { return null; }
}

/* ─────────────────── what a call can cost ─────────────────── */

/* USD per million tokens, for a model the catalog has no price for (or before
   this instance has read the catalog). On the high side on purpose: it only
   decides how much is held while the call runs, never what is charged. */
const FALLBACK_PRICE = { input: 10, output: 40 };
const DEFAULT_MAX_OUT = 4096;
const round6 = (v) => Math.round(Number(v) * 1e6) / 1e6;

/* Characters of text a request sends; a picture or a file counts as ~1,500 tokens. */
function requestChars(body) {
  let chars = 0;
  const add = (c) => {
    if (typeof c === 'string') chars += c.length;
    else if (Array.isArray(c)) for (const part of c) add(part && typeof part === 'object' ? (part.type === 'text' ? part.text : 4500) : part);
    else if (typeof c === 'number') chars += c;
  };
  for (const m of (body && Array.isArray(body.messages) ? body.messages : [])) {
    if (!m) continue;
    add(m.content);
    if (m.tool_calls) { try { chars += JSON.stringify(m.tool_calls).length; } catch { /* left out */ } }
  }
  if (body && body.tools) { try { chars += JSON.stringify(body.tools).length; } catch { /* left out */ } }
  return chars;
}

/**
 * The most a request can cost at OpenRouter, in USD, as well as it can be
 * told before it is sent: its text at ~3 characters a token, and every token
 * it allows the answer.
 */
export function estimateCostUsd(model, body) {
  const m = catalogCache && catalogCache.models.find((x) => x.id === model);
  const price = m && m.inputPerM != null && m.outputPerM != null ? { input: m.inputPerM, output: m.outputPerM } : FALLBACK_PRICE;
  const inTokens = Math.ceil(requestChars(body) / 3) + 50;
  const asked = Number(body && (body.max_tokens || body.max_completion_tokens));
  const outTokens = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 128000) : DEFAULT_MAX_OUT;
  return round6((inTokens * price.input + outTokens * price.output) / 1e6);
}

/* ─────────────────── the monthly ceiling ─────────────────── */

const monthStart = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
const monthKey = (now = new Date()) => monthStart(now).slice(0, 10);

/* Migration 037 adds the counters. Until it has run, this instance uses the
   older sums; it looks again after a few minutes. */
let countersMissingAt = 0;
const COUNTERS_RETRY_MS = 5 * 60_000;
const countersReady = () => !countersMissingAt || Date.now() - countersMissingAt > COUNTERS_RETRY_MS;
const isMissingSchema = (err) => !!err && (err.code === '42P01' || err.code === '42703');

let spendCache = null;   // { at, month, usd }
const SPEND_TTL_MS = 15_000;

/** What the platform has spent through OpenRouter this calendar month (UTC), in USD. */
export async function monthSpendUsd({ fresh = false } = {}) {
  const month = monthStart();
  if (!fresh && spendCache && spendCache.month === month && Date.now() - spendCache.at < SPEND_TTL_MS) return spendCache.usd;
  let usd = 0;
  try {
    let row = null;
    if (countersReady()) {
      try {
        [row] = await sql`select spent_usd as usd from llm_month_spend where scope = 'platform' and key = '' and month = ${monthKey()}::date`;
        if (!row) row = { usd: 0 };
      } catch (err) {
        if (!isMissingSchema(err)) throw err;
        countersMissingAt = Date.now();
      }
    }
    if (!row) [row] = await sql`select coalesce(sum(cost_usd), 0) as usd from llm_usage where at >= ${month}`;
    usd = Number(row && row.usd) || 0;
  } catch (err) {
    console.warn('[llm] could not read this month\'s spend:', err.message);
    throw fail(BILLING_UNAVAILABLE_MESSAGE, 'BILLING_UNAVAILABLE', 503);
  }
  spendCache = { at: Date.now(), month, usd };
  return usd;
}

export const BUDGET_MESSAGE = 'The platform\'s model budget for this month is used up. It starts again on the 1st.';
export const ORG_PUBLIC_CAP_MESSAGE = 'This organization\'s chatbots reached their share of the platform\'s model budget for this month.';
export const ORG_BALANCE_MESSAGE = 'Your organization\'s model balance is used up. Ask the platform admin to top it up.';
export const ITEM_LIMIT_MESSAGE = 'This reached its monthly model limit. It starts again on the 1st, or when the organization\'s admin raises it.';
export const MEMBER_LIMIT_MESSAGE = 'You reached your monthly model limit. Ask your organization\'s admin to raise it.';
export const BILLING_UNAVAILABLE_MESSAGE = 'The model budget cannot be checked right now. Try again in a moment.';

/* ─────────────────── the organization's balance ─────────────────── */

/** The organization a call is charged to: the one named, or the person's. */
async function orgFor(cfg, meta = {}) {
  return meta.orgId || (cfg && cfg.orgId) || (await orgOf(meta.userId || meta.ownerId).catch(() => null)) || null;
}

/** What the organization has left in USD, or null when it has no limit of its own. */
export async function orgBalanceUsd(orgId) {
  if (!orgId) return null;
  try {
    const [row] = await sql`select balance_usd from org_billing where org_id = ${orgId}`;
    return row && row.balance_usd !== null && row.balance_usd !== undefined ? Number(row.balance_usd) : null;
  } catch (err) {
    console.warn('[llm] could not read an organization\'s balance:', err.message);
    return null;
  }
}

/*
 * Adds to an organization's balance and writes it down, in one statement.
 * An organization with no limit yet starts from zero, so its first top-up is
 * its balance.
 */
export async function topUpOrg(orgId, amount, note, userId) {
  const [row] = await sql`
    with b as (
      insert into org_billing (org_id, balance_usd, updated_at) values (${orgId}, ${amount}, now())
      on conflict (org_id) do update
        set balance_usd = coalesce(org_billing.balance_usd, 0) + excluded.balance_usd, updated_at = now()
      returning balance_usd
    )
    insert into org_topups (org_id, amount_usd, balance_after, note, by_user)
    select ${orgId}, ${amount}, balance_usd, ${note || ''}, ${userId || null} from b
    returning balance_after
  `;
  return row ? Number(row.balance_after) : null;
}

/* ─────────────────── holding ─────────────────── */

const SCOPE_REFUSALS = {
  platform: () => fail(BUDGET_MESSAGE, 'BUDGET', 402),
  'org-public': () => fail(ORG_PUBLIC_CAP_MESSAGE, 'ORG_PUBLIC_CAP', 402),
  item: () => fail(ITEM_LIMIT_MESSAGE, 'ITEM_LIMIT', 402),
  member: () => fail(MEMBER_LIMIT_MESSAGE, 'MEMBER_LIMIT', 402),
};
const SCOPE_ORDER = ['platform', 'org-public', 'item', 'member'];

/* The counters a call moves, and whether each counts what the organization is charged (or OpenRouter's cost). */
function scopesFor(orgId, meta) {
  const out = [{ scope: 'platform', key: '', charged: false }];
  if (orgId && meta.public) out.push({ scope: 'org-public', key: String(orgId), charged: false });
  if (orgId && meta.itemType && meta.itemId) out.push({ scope: 'item', key: `${orgId}:${meta.itemType}:${meta.itemId}`, charged: true });
  if (orgId && meta.userId) out.push({ scope: 'member', key: `${orgId}:${meta.userId}`, charged: true });
  return out;
}

const asList = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const x = JSON.parse(v); return Array.isArray(x) ? x : []; } catch { return []; } }
  return [];
};

/**
 * Holds what a call can cost against everything that may refuse it, in one
 * statement, and returns the hold (for settle / release). Throws the refusal.
 */
async function reserve({ p, orgId, meta, est }) {
  if (!(p.ceiling > 0)) throw SCOPE_REFUSALS.platform();
  const month = monthKey();
  if (!countersReady()) return legacyGate({ p, orgId, meta, month });

  const itemType = meta.itemType ? String(meta.itemType) : null;
  const itemId = meta.itemId ? String(meta.itemId) : null;
  const userId = meta.userId ? String(meta.userId) : null;
  const itemKey = orgId && itemType && itemId ? `${orgId}:${itemType}:${itemId}` : null;
  const memberKey = orgId && userId ? `${orgId}:${userId}` : null;
  const publicKey = orgId && meta.public ? String(orgId) : null;
  const publicDefault = p.publicPct > 0 && p.publicPct < 100 ? round6(p.ceiling * p.publicPct / 100) : null;

  let row;
  try {
    [row] = await sql`
      with want as (
        select * from (values
          ('platform'::text, ''::text, ${p.ceiling}::numeric, false),
          ('org-public', ${publicKey}::text,
             coalesce((select public_monthly_cap_usd from org_billing where org_id = ${orgId}), ${publicDefault}::numeric), false),
          ('item', ${itemKey}::text,
             (select monthly_usd from usage_limits where org_id = ${orgId} and kind = ${itemType} and target_id = ${itemId}), true),
          ('member', ${memberKey}::text,
             (select monthly_usd from usage_limits where org_id = ${orgId} and kind = 'member' and target_id = ${userId}), true)
        ) as v(scope, key, cap, charged)
        where v.key is not null and v.cap is not null
      ), priced as (
        select scope, key, cap,
               round(${est}::numeric * (case when charged
                 then 1 + coalesce((select markup_pct from org_billing where org_id = ${orgId}), 0) / 100 else 1 end), 6) as amt
        from want
      ), held as (
        insert into llm_month_spend as s (scope, key, month, cap_usd, held_usd, held_at)
        select scope, key, ${month}::date, cap, amt, now() from priced where cap > 0
        on conflict (scope, key, month) do update
          set held_usd = (case when s.held_at < now() - interval '10 minutes' then 0 else s.held_usd end) + excluded.held_usd,
              held_at  = now(),
              cap_usd  = excluded.cap_usd
          where s.spent_usd + (case when s.held_at < now() - interval '10 minutes' then 0 else s.held_usd end) < excluded.cap_usd
        returning s.scope
      ), bal as (
        update org_billing
           set last_hold_usd = least(round(${est}::numeric * (1 + markup_pct / 100), 6), balance_usd),
               balance_usd   = balance_usd - least(round(${est}::numeric * (1 + markup_pct / 100), 6), balance_usd)
         where org_id = ${orgId} and balance_usd > 0
        returning last_hold_usd
      )
      select (select balance_usd from org_billing where org_id = ${orgId}) as balance,
             (select last_hold_usd from bal) as balance_hold,
             coalesce((select json_agg(json_build_object('scope', scope, 'key', key, 'amt', amt)) from priced), '[]'::json) as wanted,
             coalesce((select json_agg(scope) from held), '[]'::json) as held
    `;
  } catch (err) {
    if (isMissingSchema(err)) {
      countersMissingAt = Date.now();
      console.warn('[llm] the spend counters are not there yet (migration 037); using the older checks');
      return legacyGate({ p, orgId, meta, month });
    }
    console.error('[llm] could not hold the cost of a call:', err.message);
    throw fail(BILLING_UNAVAILABLE_MESSAGE, 'BILLING_UNAVAILABLE', 503);
  }

  const wanted = asList(row && row.wanted).map((w) => ({ scope: w.scope, key: w.key, amt: Number(w.amt) || 0 }));
  const heldScopes = new Set(asList(row && row.held));
  const hold = {
    month, orgId,
    scopes: wanted.filter((w) => heldScopes.has(w.scope)),
    balanceHold: row && row.balance_hold != null ? Number(row.balance_hold) || 0 : 0,
  };
  const refusedScope = SCOPE_ORDER.find((sc) => wanted.some((w) => w.scope === sc) && !heldScopes.has(sc));
  const balance = row && row.balance !== null && row.balance !== undefined ? Number(row.balance) : null;
  /* `balance` is the statement's starting snapshot, so under a race it can
     still read positive after another call took the last of it; the `bal`
     update re-checks after the row lock. An organization that has a balance
     and got no hold is out of money, whatever the snapshot says. */
  const balanceHeld = !!row && row.balance_hold !== null && row.balance_hold !== undefined;
  let refusal = null;
  if (refusedScope === 'platform' || refusedScope === 'org-public') refusal = SCOPE_REFUSALS[refusedScope]();
  else if (balance !== null && !balanceHeld) refusal = fail(ORG_BALANCE_MESSAGE, 'ORG_BALANCE', 402);
  else if (refusedScope) refusal = SCOPE_REFUSALS[refusedScope]();
  if (refusal) {
    await release(hold);
    if (refusal.code === 'ORG_PUBLIC_CAP') {
      await logError({ source: 'billing', message: `An organization's public chatbots reached their share of the platform's monthly budget`, context: { org: orgId, from: meta.source || null } });
    }
    throw refusal;
  }
  return hold;
}

/** Gives a hold back, whole. Never throws. */
async function release(hold) {
  if (!hold || hold.legacy) return;
  const scopes = hold.scopes || [];
  if (!scopes.length && !(hold.balanceHold > 0)) return;
  try {
    await sql`
      with c as (
        update llm_month_spend s set held_usd = greatest(s.held_usd - r.amt, 0)
        from unnest(${scopes.map((x) => x.scope)}::text[], ${scopes.map((x) => x.key)}::text[], ${scopes.map((x) => x.amt)}::numeric[]) as r(scope, key, amt)
        where s.scope = r.scope and s.key = r.key and s.month = ${hold.month}::date
        returning 1
      )
      update org_billing set balance_usd = balance_usd + ${hold.balanceHold || 0}::numeric
      where org_id = ${hold.orgId} and ${hold.balanceHold || 0}::numeric > 0 and balance_usd is not null
    `;
  } catch (err) {
    console.warn('[llm] could not give a hold back:', err.message);
  }
}

/*
 * Before migration 037: the platform's spend against the ceiling, then the
 * balance and the limits as sums. Nothing is held.
 */
async function legacyGate({ p, orgId, meta, month }) {
  if ((await monthSpendUsd()) >= p.ceiling) throw fail(BUDGET_MESSAGE, 'BUDGET', 402);
  if (orgId) {
    const itemType = meta.itemType ? String(meta.itemType) : null;
    const itemId = meta.itemId ? String(meta.itemId) : null;
    const userId = meta.userId ? String(meta.userId) : null;
    let row;
    try {
      [row] = await sql`
        select (select balance_usd from org_billing where org_id = ${orgId}) as balance,
               (select monthly_usd from usage_limits where org_id = ${orgId} and kind = ${itemType} and target_id = ${itemId}) as item_limit,
               (select monthly_usd from usage_limits where org_id = ${orgId} and kind = 'member' and target_id = ${userId}) as member_limit
      `;
    } catch (err) {
      console.error('[llm] could not read the organization\'s balance and limits:', err.message);
      throw fail(BILLING_UNAVAILABLE_MESSAGE, 'BILLING_UNAVAILABLE', 503);
    }
    if (row) {
      if (row.balance !== null && row.balance !== undefined && Number(row.balance) <= 0) throw fail(ORG_BALANCE_MESSAGE, 'ORG_BALANCE', 402);
      const itemLimit = row.item_limit === null || row.item_limit === undefined ? null : Number(row.item_limit);
      const memberLimit = row.member_limit === null || row.member_limit === undefined ? null : Number(row.member_limit);
      if (itemLimit !== null || memberLimit !== null) {
        const [used] = await sql`
          select coalesce(sum(charged_usd) filter (where item_type = ${itemType} and item_id = ${itemId}), 0) as item,
                 coalesce(sum(charged_usd) filter (where user_id = ${userId}), 0) as member
          from llm_usage where org_id = ${orgId} and at >= ${monthStart()}
        `;
        if (itemLimit !== null && Number(used.item) >= itemLimit) throw fail(ITEM_LIMIT_MESSAGE, 'ITEM_LIMIT', 402);
        if (memberLimit !== null && Number(used.member) >= memberLimit) throw fail(MEMBER_LIMIT_MESSAGE, 'MEMBER_LIMIT', 402);
      }
    }
  }
  return { legacy: true, month, orgId, scopes: [], balanceHold: 0 };
}

/**
 * Whether an error means a stranger should get the stop message: the platform
 * or the organization is out of money, the organization's public share is
 * used up, or the item reached its monthly limit. (A member's own limit only
 * ever stops calls that member set off.)
 */
export const isStopped = (err) => !!err && (err.code === 'BUDGET' || err.code === 'ORG_BALANCE' || err.code === 'ITEM_LIMIT' || err.code === 'ORG_PUBLIC_CAP');

export const STOP_MESSAGE_DEFAULT = {
  he: 'השירות לא זמין כרגע. נסו שוב מאוחר יותר.',
  en: 'This service is not available right now. Please try again later.',
};

/**
 * What a stranger on a widget or WhatsApp reads when the organization has run
 * out or the platform reached its ceiling: the platform admin's message, in
 * Hebrew when they wrote in Hebrew.
 */
export async function stopMessage(theirText) {
  const p = await platform();
  return /[֐-׿]/.test(String(theirText || ''))
    ? (p.stopHe || STOP_MESSAGE_DEFAULT.he)
    : (p.stopEn || STOP_MESSAGE_DEFAULT.en);
}

/* ─────────────────── sending ─────────────────── */

/**
 * Sends one chat-completions request on the platform's key and returns
 * `{ ok, status, data }` — `data` is OpenRouter's JSON (an error body when not
 * ok). Throws only when the call cannot be made at all; `err.code` is
 * NO_MODEL, NO_PLATFORM_KEY, BUDGET (the platform's ceiling), ORG_PUBLIC_CAP
 * (the organization's strangers used their share of it), ORG_BALANCE (the
 * organization's balance is used up), ITEM_LIMIT or MEMBER_LIMIT (a monthly
 * limit its admin set) or BILLING_UNAVAILABLE, and `err.status` says how to
 * answer it.
 *
 * @param {object} p
 * @param {object} p.cfg      what resolveApiConfig returns: { model, ready, orgId }
 * @param {object} p.body     the request; its `model` is replaced by the organization's
 * @param {object} [p.meta]   { orgId, userId, ownerId, source, itemType, itemId, public } — for
 *                            llm_usage; `public` marks a call a stranger set off (widget, app, WhatsApp)
 */
export async function llmFetch({ cfg, body, meta = {}, fetchImpl = fetch }) {
  const p = await platform();
  if (!p.key) throw fail('The platform has no OpenRouter key yet.', 'NO_PLATFORM_KEY', 503);
  if (!cfg || !cfg.model) throw fail('The platform has not chosen a model for this organization yet.', 'NO_MODEL', 400);
  const orgId = await orgFor(cfg, meta);

  /* Never streamed: an answer that is not one JSON body cannot be counted. */
  const request = { ...body, model: cfg.model, stream: false, usage: { include: true } };
  delete request.stream_options;
  const hold = await reserve({ p, orgId, meta, est: estimateCostUsd(cfg.model, request) });

  let r;
  let text;
  try {
    r = await fetchImpl(`${OPENROUTER_BASE}/chat/completions`, { method: 'POST', headers: orHeaders(p.key), body: JSON.stringify(request) });
    text = await r.text();
  } catch (err) {
    await release(hold);
    throw err;
  }
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: { message: text.slice(0, 500) || `HTTP ${r.status}` } }; }

  // OpenRouter can answer 200 with an error inside, when the upstream provider failed mid-way.
  const ok = r.ok && !!data && Array.isArray(data.choices) && !data.error;
  if (ok) {
    await recordCall({ orgId, meta, model: data.model || request.model, usage: data.usage || {}, hold, fetchImpl });
    return { ok, status: r.status, data };
  }
  /* A failed call that still cost something (OpenRouter says so in `usage`)
     is counted like any other; one that cost nothing just gives its hold back. */
  if (data && data.usage && chatUsage(data.usage).cost) {
    await recordCall({ orgId, meta, model: data.model || request.model, usage: data.usage, hold, fetchImpl });
  } else {
    await release(hold);
  }
  const status = r.ok ? 502 : r.status;
  const said = (data && data.error && (data.error.message || data.error.code)) || `HTTP ${status}`;
  /* OpenRouter's own words go to the error log, where the platform admin and
     the assistants can read why, whatever the person on screen was told. */
  await logError({
    source: 'openrouter',
    message: `OpenRouter answered ${status}: ${String(said).slice(0, 500)}`,
    context: { model: request.model, from: meta.source || null, org: orgId, metadata: (data && data.error && data.error.metadata) || null },
  });
  /* 402 (credit) and 403 (a guardrail) are OpenRouter refusing the
     platform's account, not this request being wrong. Say so, in OpenRouter's
     words: "Insufficient credits" and "budget exceeded" need different fixes. */
  if (status === 402 || status === 403) {
    data = { error: { message: `The platform's model account was refused: ${said}`, code: 'PROVIDER_REFUSED', upstream: data && data.error } };
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

/*
 * When OpenRouter leaves the cost out, it is the tokens at the catalog's
 * price, rather than nothing: a call written down as free is a call nobody
 * pays for.
 */
async function costOf(u, model, fetchImpl) {
  if (u.cost !== null) return u.cost;
  if (!u.input && !u.output) return null;
  const info = await modelInfo(model, { fetchImpl });
  const price = info && info.inputPerM != null && info.outputPerM != null ? { input: info.inputPerM, output: info.outputPerM } : FALLBACK_PRICE;
  return round6((u.input * price.input + u.output * price.output) / 1e6);
}

/*
 * One statement settles a call: it writes the llm_usage row, takes what the
 * call is charged from the organization's balance (giving back what was held
 * for it), and moves the month's counters on (releasing their holds).
 * charged = OpenRouter's cost × (1 + markup / 100); an organization with no
 * balance (null) is charged on paper only.
 */
async function recordCall({ orgId, meta, model, usage, hold, fetchImpl = fetch }) {
  try {
    const u = chatUsage(usage);
    const cost = await costOf(u, model, fetchImpl);
    const source = String(meta.source || 'other').slice(0, 40);
    const itemType = meta.itemType ? String(meta.itemType).slice(0, 20) : null;
    const itemId = meta.itemId ? String(meta.itemId).slice(0, 80) : null;
    const modelName = String(model || 'unknown').slice(0, 120);

    if (!hold || hold.legacy) {
      await sql`
        with pct as (
          select coalesce((select markup_pct from org_billing where org_id = ${orgId}), 0) as markup
        ), charge as (
          select (${cost}::numeric * (1 + markup / 100)) as usd from pct
        ), taken as (
          update org_billing set balance_usd = balance_usd - (select usd from charge)
          where org_id = ${orgId} and balance_usd is not null and (select usd from charge) is not null
        )
        insert into llm_usage (org_id, user_id, via, source, item_type, item_id, model,
                               input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, charged_usd)
        values (${orgId || null}, ${meta.userId || null}, 'openrouter', ${source}, ${itemType}, ${itemId},
                ${modelName}, ${u.input}, ${u.output}, ${u.read}, ${u.write}, ${cost},
                (select usd from charge))
      `;
    } else {
      const heldOf = new Map((hold.scopes || []).map((x) => [x.scope, x.amt]));
      const scopes = scopesFor(orgId, { ...meta, itemType, itemId });
      await sql`
        with pct as (
          select coalesce((select markup_pct from org_billing where org_id = ${orgId}), 0) as markup
        ), charge as (
          select (${cost}::numeric * (1 + markup / 100)) as usd from pct
        ), taken as (
          update org_billing set balance_usd = balance_usd + ${hold.balanceHold || 0}::numeric - coalesce((select usd from charge), 0)
          where org_id = ${orgId} and balance_usd is not null
            and ((select usd from charge) is not null or ${hold.balanceHold || 0}::numeric > 0)
        ), r as (
          select * from unnest(${scopes.map((x) => x.scope)}::text[], ${scopes.map((x) => x.key)}::text[],
                               ${scopes.map((x) => x.charged)}::boolean[], ${scopes.map((x) => heldOf.get(x.scope) || 0)}::numeric[])
                   as r(scope, key, charged, hold)
        ), settled as (
          update llm_month_spend s
             set spent_usd = s.spent_usd + coalesce(case when r.charged then (select usd from charge) else ${cost}::numeric end, 0),
                 held_usd  = greatest(s.held_usd - r.hold, 0)
            from r
           where r.hold > 0 and s.scope = r.scope and s.key = r.key and s.month = ${hold.month}::date
        ), counted as (
          insert into llm_month_spend as s (scope, key, month, spent_usd)
          select r.scope, r.key, ${hold.month}::date,
                 coalesce(case when r.charged then (select usd from charge) else ${cost}::numeric end, 0)
            from r where r.hold <= 0
          on conflict (scope, key, month) do update set spent_usd = s.spent_usd + excluded.spent_usd
        )
        insert into llm_usage (org_id, user_id, via, source, item_type, item_id, model,
                               input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, charged_usd)
        values (${orgId || null}, ${meta.userId || null}, 'openrouter', ${source}, ${itemType}, ${itemId},
                ${modelName}, ${u.input}, ${u.output}, ${u.read}, ${u.write}, ${cost},
                (select usd from charge))
      `;
    }
    if (spendCache && cost) spendCache.usd += cost;
  } catch (err) {
    console.warn('[llm] could not record a call:', err.message);
    await release(hold);
  }
}

/* ─────────────────── checking ─────────────────── */

/** Whether a config can reach a model right now. For the browser, which holds no key. */
export async function pingConfig(cfg, { fetchImpl = fetch } = {}) {
  if (!cfg || !cfg.model) return { ok: false, why: 'The platform has not chosen a model for this organization yet.' };
  const p = await platform();
  if (!(p.ceiling > 0)) return { ok: false, why: BUDGET_MESSAGE };
  let spent;
  try { spent = await monthSpendUsd(); } catch { return { ok: false, why: BILLING_UNAVAILABLE_MESSAGE }; }
  if (spent >= p.ceiling) return { ok: false, why: BUDGET_MESSAGE };
  const balance = await orgBalanceUsd(cfg.orgId);
  if (balance !== null && balance <= 0) return { ok: false, why: ORG_BALANCE_MESSAGE };
  const info = await describeOpenRouterKey(p.key, { fetchImpl });
  return info.ok ? { ok: true } : { ok: false, why: info.why };
}
