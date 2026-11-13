import { sql } from './_db.js';
import { checkAuth } from './_auth.js';
import { CreditError, creditSummary, keyHint, todayCents } from './_claudeCredit.js';

/**
 * The account's Claude credit: the balance it typed in from the Console, minus
 * what Anthropic's cost report says the organization spent since.
 *
 *   GET     → { configured, keyHint, balanceUsd, balanceAt, spentSinceUsd, remainingUsd, monthUsd, asOf, error }
 *   PUT     → { adminKey?, balanceUsd? } — a new key is tried before it is kept
 *   DELETE  → forgets the Admin key and the balance
 *
 * The Admin key never leaves the server: only its last four characters do.
 */
export default async function handler(req, res) {
  const user = checkAuth(req, res);
  if (!user) return;
  const userId = user.userId;

  if (req.method === 'GET') {
    const row = await load(userId);
    return res.json(await view(row));
  }

  if (req.method === 'PUT') {
    const body = req.body || {};
    const existing = await load(userId);
    const newKey = typeof body.adminKey === 'string' ? body.adminKey.trim() : '';
    const adminKey = newKey || existing?.admin_key;
    if (!adminKey) return res.status(400).json({ error: 'Add an Admin key first.' });

    let balanceCents;
    if (body.balanceUsd !== undefined && body.balanceUsd !== null && body.balanceUsd !== '') {
      const usd = Number(body.balanceUsd);
      if (!Number.isFinite(usd) || usd < 0 || usd > 1_000_000) {
        return res.status(400).json({ error: 'The balance must be an amount in dollars, like 42.50.' });
      }
      balanceCents = Math.round(usd * 100);
    }

    // Asking for today's spend tries the key as well, so a key that cannot
    // read costs is refused here rather than stored.
    let offset;
    try {
      offset = await todayCents(adminKey);
    } catch (err) {
      if (err instanceof CreditError) return res.status(400).json({ error: err.message });
      throw err;
    }

    if (balanceCents !== undefined) {
      await sql`
        insert into claude_credit (user_id, admin_key, balance_cents, balance_at, spend_offset_cents, updated_at)
        values (${userId}, ${adminKey}, ${balanceCents}, now(), ${offset}, now())
        on conflict (user_id) do update set
          admin_key = excluded.admin_key, balance_cents = excluded.balance_cents,
          balance_at = excluded.balance_at, spend_offset_cents = excluded.spend_offset_cents,
          updated_at = now()
      `;
    } else {
      await sql`
        insert into claude_credit (user_id, admin_key, updated_at)
        values (${userId}, ${adminKey}, now())
        on conflict (user_id) do update set admin_key = excluded.admin_key, updated_at = now()
      `;
    }
    return res.json(await view(await load(userId)));
  }

  if (req.method === 'DELETE') {
    await sql`delete from claude_credit where user_id = ${userId}`;
    return res.json(await view(null));
  }

  return res.status(405).end();
}

async function load(userId) {
  const [row] = await sql`
    select admin_key, balance_cents, balance_at, spend_offset_cents
    from claude_credit where user_id = ${userId}
  `;
  return row || null;
}

const usd = (cents) => (cents === null || cents === undefined ? null : Math.round(Number(cents)) / 100);

async function view(row) {
  if (!row) return { configured: false };
  const base = {
    configured: true,
    keyHint: keyHint(row.admin_key),
    balanceUsd: usd(row.balance_cents),
    balanceAt: row.balance_at,
  };
  try {
    const s = await creditSummary(row);
    return {
      ...base,
      spentSinceUsd: usd(s.spentSinceCents),
      remainingUsd: usd(s.remainingCents),
      monthUsd: usd(s.monthCents),
      asOf: s.asOf,
      error: null,
    };
  } catch (err) {
    if (!(err instanceof CreditError)) throw err;
    return { ...base, error: err.message };
  }
}
