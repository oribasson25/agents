import { sql } from '../_db.js';
import { manageableOrg, errorReply } from '../_orgs.js';

/**
 * An organization's model money, for its admin (or the platform admin, with
 * ?org=<id>): what it has left, its top-ups, what it was charged this month
 * and for what, and the monthly limits on its items and members.
 *
 *   GET → { balance, low, stopped, topups, month: { from, charged, calls, items, members } }
 *   PUT { kind, targetId, monthlyUsd } → sets a monthly limit; monthlyUsd null removes it.
 *       kind: 'agent' | 'app' | 'automation' | 'number' | 'member'
 *
 * Only what the organization is charged is shown here (OpenRouter's cost plus
 * its markup). What the calls cost the platform, and the markup itself, are
 * the platform admin's and never leave Admin › Billing.
 */
export default async function handler(req, res) {
  const scope = await manageableOrg(req, res);
  if (!scope) return;
  try {
    if (req.method === 'GET') return res.json(await orgBilling(scope.orgId));
    if (req.method === 'PUT') {
      const b = req.body || {};
      const kind = String(b.kind || '');
      const targetId = String(b.targetId || '');
      if (!KINDS.includes(kind) || !targetId) return res.status(400).json({ error: 'A limit needs a kind and what it is on.' });
      if (!(await belongs(scope.orgId, kind, targetId))) return res.status(404).json({ error: 'That is not this organization\'s.' });
      if (b.monthlyUsd === null || b.monthlyUsd === undefined || b.monthlyUsd === '') {
        await sql`delete from usage_limits where org_id = ${scope.orgId} and kind = ${kind} and target_id = ${targetId}`;
      } else {
        const usd = Math.round(Number(b.monthlyUsd) * 100) / 100;
        if (!Number.isFinite(usd) || usd < 0 || usd > 100000) {
          return res.status(400).json({ error: 'A monthly limit is an amount in dollars, like 10 (0 stops it).' });
        }
        await sql`
          insert into usage_limits (org_id, kind, target_id, monthly_usd, updated_by, updated_at)
          values (${scope.orgId}, ${kind}, ${targetId}, ${usd}, ${scope.me.userId || null}, now())
          on conflict (org_id, kind, target_id) do update
            set monthly_usd = excluded.monthly_usd, updated_by = excluded.updated_by, updated_at = now()
        `;
      }
      return res.json(await orgBilling(scope.orgId));
    }
  } catch (err) {
    return errorReply(res, err);
  }
  return res.status(405).end();
}

const KINDS = ['agent', 'app', 'automation', 'number', 'member'];
const round = (v) => Math.round(Number(v || 0) * 10000) / 10000;

/* A limit may only be set on something of the organization's own. */
async function belongs(orgId, kind, id) {
  const [row] = kind === 'agent' ? await sql`select 1 as x from agents where id = ${id} and org_id = ${orgId}`
    : kind === 'app' ? await sql`select 1 as x from apps where id = ${id} and org_id = ${orgId}`
    : kind === 'automation' ? await sql`select 1 as x from automations where id = ${id} and org_id = ${orgId}`
    : kind === 'number' ? await sql`select 1 as x from wa_numbers n join users u on u.id = n.owner_user_id where n.id = ${id} and u.org_id = ${orgId}`
    : await sql`select 1 as x from users where id = ${id} and org_id = ${orgId}`;
  return !!row;
}

/* What a call that belongs to no single item was for. */
const SOURCE_NAMES = {
  home: 'Home chat', assistant: 'The platform assistant', autopilot: 'Autopilot', builder: 'Building with the assistant',
  'test-chat': 'Test chats', knowledge: 'Reading knowledge files', 'group-learning': 'Learning WhatsApp groups',
  browser: 'Other', other: 'Other',
};

export async function orgBilling(orgId) {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const [[b], topups, used, things, people, limits] = await Promise.all([
    sql`
      select ob.balance_usd,
             (select t.amount_usd from org_topups t where t.org_id = o.id and t.amount_usd > 0 order by t.at desc, t.id desc limit 1) as last_topup
      from organizations o left join org_billing ob on ob.org_id = o.id
      where o.id = ${orgId}
    `,
    sql`
      select amount_usd, balance_after, note, at from org_topups
      where org_id = ${orgId} order by at desc, id desc limit 50
    `,
    sql`
      select item_type, item_id, source, user_id,
             count(*)::int as calls,
             coalesce(sum(charged_usd), 0) as charged
      from llm_usage
      where org_id = ${orgId} and at >= ${from}
      group by 1, 2, 3, 4
    `,
    /* Everything a limit can be set on, used this month or not. */
    sql`
      select 'agent' as kind, id, coalesce(data->>'name', '') as name from agents where org_id = ${orgId}
      union all
      select 'app', id, coalesce(data->>'name', '') from apps where org_id = ${orgId}
      union all
      select 'automation', id, coalesce(data->>'name', '') from automations where org_id = ${orgId}
      union all
      select 'number', n.id, coalesce(nullif(n.label, ''), n.id) from wa_numbers n join users u on u.id = n.owner_user_id where u.org_id = ${orgId}
    `,
    sql`select id, username from users where org_id = ${orgId} order by username`,
    sql`select kind, target_id, monthly_usd from usage_limits where org_id = ${orgId}`,
  ]);

  const limitOf = new Map(limits.map((l) => [`${l.kind}:${l.target_id}`, Number(l.monthly_usd)]));

  /* One line per item, every item listed; calls tied to no item are grouped by what they were for. */
  const lines = new Map();
  for (const t of things) {
    lines.set(`${t.kind}:${t.id}`, { kind: t.kind, id: t.id, name: t.name || '(unnamed)', calls: 0, charged: 0, limit: limitOf.get(`${t.kind}:${t.id}`) ?? null });
  }
  for (const r of used) {
    const key = r.item_id ? `${r.item_type}:${r.item_id}` : `source:${r.source}`;
    const line = lines.get(key) || {
      kind: r.item_id ? r.item_type : 'platform',
      id: r.item_id || r.source,
      name: r.item_id ? '(deleted)' : (SOURCE_NAMES[r.source] || r.source),
      calls: 0, charged: 0, limit: r.item_id ? (limitOf.get(key) ?? null) : null,
    };
    line.calls += r.calls;
    line.charged = round(line.charged + Number(r.charged));
    lines.set(key, line);
  }
  const items = [...lines.values()].sort((x, y) => y.charged - x.charged || y.calls - x.calls || x.name.localeCompare(y.name));

  /* What each member set off in the platform (the home chat, tests, the assistants). */
  const byUser = new Map();
  for (const r of used) {
    if (!r.user_id) continue;
    const u = byUser.get(r.user_id) || { calls: 0, charged: 0 };
    u.calls += r.calls;
    u.charged = round(u.charged + Number(r.charged));
    byUser.set(r.user_id, u);
  }
  const members = people.map((p) => ({
    id: p.id, username: p.username,
    calls: (byUser.get(p.id) || {}).calls || 0,
    charged: (byUser.get(p.id) || {}).charged || 0,
    limit: limitOf.get(`member:${p.id}`) ?? null,
  })).sort((x, y) => y.charged - x.charged || x.username.localeCompare(y.username));

  const balance = b && b.balance_usd !== null && b.balance_usd !== undefined ? round(b.balance_usd) : null;
  const lastTopup = b && b.last_topup !== null && b.last_topup !== undefined ? Number(b.last_topup) : null;
  return {
    balance,
    low: balance !== null && balance > 0 && lastTopup !== null && balance < lastTopup * 0.2,
    stopped: balance !== null && balance <= 0,
    topups: topups.map((t) => ({
      amountUsd: Number(t.amount_usd), balanceAfter: t.balance_after === null ? null : Number(t.balance_after), note: t.note, at: t.at,
    })),
    month: {
      from,
      charged: round(items.reduce((a, l) => a + l.charged, 0)),
      calls: items.reduce((a, l) => a + l.calls, 0),
      items,
      members,
    },
  };
}
