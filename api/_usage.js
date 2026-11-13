import { sql } from './_db.js';

/*
 * What a call to Claude cost, from the token counts its response reports, and
 * a record of it against the account whose key paid.
 *
 * A regular API key cannot read the account's balance or spend from Anthropic,
 * so this is how the Settings card knows what 8legs has spent. It only sees
 * calls 8legs makes: anything else using the same Anthropic organization is
 * not here.
 */

/* USD per million tokens, standard tier, from
   https://platform.claude.com/docs/en/about-claude/pricing (2026-11-13):
   [input, 5-minute cache write, 1-hour cache write, cache read, output].
   Update this when Anthropic changes a price or 8legs offers a new model. */
const P = (input, write5m, write1h, read, output) => ({ input, write5m, write1h, read, output });
const OPUS_45_TO_5 = P(5, 6.25, 10, 0.5, 25);
const SONNET_4X = P(3, 3.75, 6, 0.3, 15);
const OPUS_4X = P(15, 18.75, 30, 1.5, 75);
export const PRICES = {
  'claude-fable-5-2': P(8, 10, 16, 0.2, 40),
  'claude-mythos-5-2': P(8, 10, 16, 0.2, 40),
  'claude-fable-5-1': P(10, 12.5, 20, 0.25, 50),
  'claude-mythos-5-1': P(10, 12.5, 20, 0.25, 50),
  'claude-fable-5': P(10, 12.5, 20, 1, 50),
  'claude-mythos-5': P(10, 12.5, 20, 1, 50),
  'claude-opus-5-5': P(4, 5, 8, 0.2, 20),
  'claude-opus-5': OPUS_45_TO_5,
  'claude-opus-4-8': OPUS_45_TO_5,
  'claude-opus-4-7': OPUS_45_TO_5,
  'claude-opus-4-6': OPUS_45_TO_5,
  'claude-opus-4-5': OPUS_45_TO_5,
  'claude-opus-4-1': OPUS_4X,
  'claude-opus-4': OPUS_4X,
  'claude-sonnet-5-5': P(2, 2.5, 4, 0.1, 10),
  'claude-sonnet-5': P(2, 2.5, 4, 0.2, 10),
  'claude-sonnet-4-6': SONNET_4X,
  'claude-sonnet-4-5': SONNET_4X,
  'claude-sonnet-4': SONNET_4X,
  'claude-haiku-5-5': P(0.1, 0.125, 0.2, 0.01, 0.5),
  'claude-haiku-4-5': P(1, 1.25, 2, 0.1, 5),
};
// Claude Haiku 5.5 charges more for a prompt over 100,000 tokens (cache reads and writes count).
const HAIKU_55_LONG = P(0.5, 0.625, 1, 0.05, 2.5);
const WEB_SEARCH_USD = 10 / 1000;   // $10 per 1,000 searches, on top of tokens

// Longest id first, so "claude-opus-4-5-20251101" is Opus 4.5 and not Opus 4.
const IDS = Object.keys(PRICES).sort((a, b) => b.length - a.length);
export function priceFor(model) {
  const m = String(model || '');
  const id = IDS.find((k) => m === k || m.startsWith(`${k}-`));
  return id ? { id, price: PRICES[id] } : null;
}

const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);

/** The token counts of a Messages API `usage` object, normalised. */
export function tokensOf(usage = {}) {
  const writes = n(usage.cache_creation_input_tokens);
  const write1h = n(usage.cache_creation?.ephemeral_1h_input_tokens);
  return {
    input: n(usage.input_tokens),
    output: n(usage.output_tokens),
    write1h: Math.min(write1h, writes),
    write5m: writes - Math.min(write1h, writes),   // without the breakdown, a write is a 5-minute write
    read: n(usage.cache_read_input_tokens),
    searches: n(usage.server_tool_use?.web_search_requests),
  };
}

/** USD for one response, or null when the model has no known price. */
export function costUsd(model, usage) {
  const found = priceFor(model);
  if (!found) return null;
  const t = tokensOf(usage);
  let p = found.price;
  if (found.id === 'claude-haiku-5-5' && t.input + t.write5m + t.write1h + t.read > 100_000) p = HAIKU_55_LONG;
  return (t.input * p.input + t.write5m * p.write5m + t.write1h * p.write1h + t.read * p.read + t.output * p.output) / 1e6
    + t.searches * WEB_SEARCH_USD;
}

const owners = new Map();   // agentId -> owner's user id, for the life of this instance
async function ownerOf(agentId) {
  if (!owners.has(agentId)) {
    const [row] = await sql`select user_id from agents where id = ${agentId}`;
    owners.set(agentId, row?.user_id || null);
  }
  return owners.get(agentId);
}

/**
 * Records one call against the account that paid for it: `userId`, or the
 * owner of `agentId`. Never throws — a reply must not fail over bookkeeping.
 */
export async function recordUsage({ userId, agentId, model, usage, source }) {
  try {
    if (!usage) return;
    const uid = userId || (agentId ? await ownerOf(agentId) : null);
    if (!uid) return;
    const t = tokensOf(usage);
    await sql`
      insert into claude_usage (user_id, source, model, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, web_searches, cost_usd)
      values (${uid}, ${String(source || 'other').slice(0, 40)}, ${String(model || 'unknown').slice(0, 80)},
              ${t.input}, ${t.output}, ${t.write5m + t.write1h}, ${t.read}, ${t.searches}, ${costUsd(model, usage)})
    `;
  } catch (err) {
    console.warn('[usage] could not record a Claude call:', err.message);
  }
}
