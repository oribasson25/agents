import { sql } from './_db.js';
import { checkAuth } from './_auth.js';
import { recordUsage } from './_usage.js';

/**
 * The account's Claude credit: the balance it typed in from the Console,
 * minus what 8legs has spent with the account's key since (claude_usage).
 * A regular key cannot read the real balance from Anthropic, so anything else
 * using the same Anthropic organization is not counted.
 *
 *   GET     → { balanceUsd, balanceAt, spentSinceUsd, remainingUsd, monthUsd, bySource, unpricedCalls, countingSince }
 *   PUT     → { balanceUsd } — the balance as the Console shows it now
 *   DELETE  → forgets the balance
 *   POST    → { model, usage, source } — a call the browser made to Claude
 *             with this account's key (the builder, the test chat, the
 *             assistant). The price is worked out here, from the tokens.
 */
const BROWSER_SOURCES = new Set(['builder', 'test-chat', 'assistant']);

export default async function handler(req, res) {
  const user = checkAuth(req, res);
  if (!user) return;
  const userId = user.userId;

  if (req.method === 'GET') return res.json(await view(userId));

  if (req.method === 'PUT') {
    const usd = Number((req.body || {}).balanceUsd);
    if (!Number.isFinite(usd) || usd < 0 || usd > 1_000_000) {
      return res.status(400).json({ error: 'The balance must be an amount in dollars, like 42.50.' });
    }
    await sql`
      insert into claude_credit (user_id, balance_cents, balance_at, updated_at)
      values (${userId}, ${Math.round(usd * 100)}, now(), now())
      on conflict (user_id) do update set
        balance_cents = excluded.balance_cents, balance_at = excluded.balance_at, updated_at = now()
    `;
    return res.json(await view(userId));
  }

  if (req.method === 'DELETE') {
    await sql`delete from claude_credit where user_id = ${userId}`;
    return res.json(await view(userId));
  }

  if (req.method === 'POST') {
    const { model, usage, source } = req.body || {};
    if (!BROWSER_SOURCES.has(source) || typeof model !== 'string' || !usage || typeof usage !== 'object') {
      return res.status(400).json({ error: 'model, usage and a known source are required' });
    }
    // Implausible counts are a bug or a forgery; either way not a real call.
    const counts = [usage.input_tokens, usage.output_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens];
    if (counts.some((c) => c !== undefined && c !== null && !(Number(c) >= 0 && Number(c) <= 5_000_000))) {
      return res.status(400).json({ error: 'usage is out of range' });
    }
    await recordUsage({ userId, model, usage, source });
    return res.status(204).end();
  }

  return res.status(405).end();
}

const usd = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 10000) / 10000);

async function view(userId) {
  const [credit] = await sql`select balance_cents, balance_at from claude_credit where user_id = ${userId}`;
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const balanceAt = credit?.balance_at ? new Date(credit.balance_at) : null;
  // The breakdown covers what the headline number covers.
  const from = balanceAt || monthStart;

  const [sums] = await sql`
    select coalesce(sum(cost_usd) filter (where at >= ${monthStart.toISOString()}), 0) as month,
           coalesce(sum(cost_usd) filter (where at >= ${from.toISOString()}), 0)       as since,
           count(*) filter (where cost_usd is null and at >= ${from.toISOString()})    as unpriced,
           min(at)                                                                     as first_at
    from claude_usage where user_id = ${userId}
  `;
  const bySource = await sql`
    select source, coalesce(sum(cost_usd), 0) as usd, count(*)::int as calls
    from claude_usage where user_id = ${userId} and at >= ${from.toISOString()}
    group by source order by 2 desc
  `;

  const balanceUsd = credit ? Number(credit.balance_cents) / 100 : null;
  const spentSinceUsd = balanceAt ? Number(sums.since) : null;
  return {
    balanceUsd,
    balanceAt: balanceAt ? balanceAt.toISOString() : null,
    spentSinceUsd: usd(spentSinceUsd),
    remainingUsd: balanceAt ? usd(balanceUsd - spentSinceUsd) : null,
    monthUsd: usd(sums.month),
    bySource: bySource.map((r) => ({ source: r.source, usd: usd(r.usd), calls: r.calls })),
    unpricedCalls: Number(sums.unpriced || 0),
    countingSince: sums.first_at ? new Date(sums.first_at).toISOString() : null,
  };
}
