import { sql } from '../_db.js';
import { manageableOrg, errorReply } from '../_orgs.js';

/**
 * An organization's model money, for its admin (or the platform admin, with
 * ?org=<id>): what it has left, its top-ups, and what it was charged this
 * month and for what.
 *
 *   GET → { balance, low, stopped, topups, month: { from, charged, calls, items } }
 *
 * Only what the organization is charged is shown here (OpenRouter's cost plus
 * its markup). What the calls cost the platform, and the markup itself, are
 * the platform admin's and never leave Admin › Billing.
 */
export default async function handler(req, res) {
  const scope = await manageableOrg(req, res);
  if (!scope) return;
  if (req.method !== 'GET') return res.status(405).end();
  try {
    return res.json(await orgBilling(scope.orgId));
  } catch (err) {
    return errorReply(res, err);
  }
}

const round = (v) => Math.round(Number(v || 0) * 10000) / 10000;

/* What a call that belongs to no single item was for. */
const SOURCE_NAMES = {
  home: 'Home chat', assistant: 'The platform assistant', autopilot: 'Autopilot', builder: 'Building with the assistant',
  'test-chat': 'Test chats', knowledge: 'Reading knowledge files', 'group-learning': 'Learning WhatsApp groups',
  browser: 'Other', other: 'Other',
};

export async function orgBilling(orgId) {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const [[b], topups, items] = await Promise.all([
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
      select l.item_type, l.item_id, l.source,
             count(*)::int as calls,
             coalesce(sum(l.charged_usd), 0) as charged,
             coalesce(sum(l.input_tokens + l.output_tokens), 0)::bigint as tokens,
             coalesce(a.data->>'name', ap.data->>'name', au.data->>'name', n.label) as name
      from llm_usage l
      left join agents      a  on l.item_type = 'agent'      and a.id  = l.item_id
      left join apps        ap on l.item_type = 'app'        and ap.id = l.item_id
      left join automations au on l.item_type = 'automation' and au.id = l.item_id
      left join wa_numbers  n  on l.item_type = 'number'     and n.id  = l.item_id
      where l.org_id = ${orgId} and l.at >= ${from}
      group by 1, 2, 3, 7
      order by charged desc
    `,
  ]);

  /* One line per item; calls tied to no item are grouped by what they were for. */
  const lines = new Map();
  for (const r of items) {
    const key = r.item_id ? `${r.item_type}:${r.item_id}` : `source:${r.source}`;
    const line = lines.get(key) || {
      kind: r.item_id ? r.item_type : 'platform',
      id: r.item_id || r.source,
      name: r.item_id ? (r.name || '(deleted)') : (SOURCE_NAMES[r.source] || r.source),
      calls: 0, tokens: 0, charged: 0,
    };
    line.calls += r.calls;
    line.tokens += Number(r.tokens);
    line.charged = round(line.charged + Number(r.charged));
    lines.set(key, line);
  }
  const list = [...lines.values()].sort((x, y) => y.charged - x.charged || y.calls - x.calls);

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
      charged: round(list.reduce((a, l) => a + l.charged, 0)),
      calls: list.reduce((a, l) => a + l.calls, 0),
      items: list,
    },
  };
}
