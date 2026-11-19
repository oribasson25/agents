import { sql } from '../_db.js';
import { checkAdmin } from '../_auth.js';
import { listOrgs } from '../_orgs.js';
import {
  platformKey, savePlatformKey, savePlatformSettings, describeOpenRouterKey, openRouterModels, monthSpendUsd, STOP_MESSAGE_DEFAULT, topUpOrg,
} from '../_llm.js';

/**
 * The platform's models: the OpenRouter key, the default model, the monthly
 * ceiling, the model each organization runs on, each organization's balance
 * and markup, and what each organization used and was charged this month.
 * Platform admin only.
 *
 *   GET                         → { key, defaultModel, ceilingUsd, stopMessage, month, orgs }
 *   GET ?catalog=1              → { models } — OpenRouter's catalog, with prices
 *   GET ?topups=<orgId>         → { topups } — that organization's top-ups, newest first
 *   PUT { key }                 → stores the key once OpenRouter has accepted it ('' removes it)
 *   PUT { defaultModel?, ceilingUsd?, stopMessage?: { he?, en? } }
 *   PUT { orgId, model }        → the organization's own model ('' = the platform's default)
 *   PUT { orgId, models: [ids] } → the models its items may choose from (its default always may)
 *   PUT { orgId, topupUsd, note? }  → adds to its balance (negative corrects it). The first
 *                                   one gives an organization with no limit a balance.
 *   PUT { orgId, markupPct }    → percent added to OpenRouter's cost for that organization
 *   PUT { orgId, unlimited: true } → removes its balance: only the platform's ceiling applies
 */
export default async function handler(req, res) {
  const admin = checkAdmin(req, res);
  if (!admin) return;

  try {
    if (req.method === 'GET') {
      if (req.query && req.query.catalog) return res.json({ models: await openRouterModels() });
      if (req.query && req.query.topups) {
        const topups = await sql`
          select t.id, t.amount_usd, t.balance_after, t.note, t.at, u.username as by
          from org_topups t left join users u on u.id = t.by_user
          where t.org_id = ${String(req.query.topups)}
          order by t.at desc, t.id desc limit 100
        `;
        return res.json({ topups: topups.map((t) => ({
          id: Number(t.id), amountUsd: Number(t.amount_usd), balanceAfter: t.balance_after === null ? null : Number(t.balance_after),
          note: t.note, at: t.at, by: t.by || null,
        })) });
      }
      return res.json(await view());
    }

    if (req.method === 'PUT') {
      const b = req.body || {};
      const has = (k) => Object.prototype.hasOwnProperty.call(b, k);

      if (has('key')) {
        const key = String(b.key || '').trim();
        if (key) {
          const info = await describeOpenRouterKey(key);
          if (!info.ok) return res.status(400).json({ error: `OpenRouter refused that key: ${info.why}` });
        }
        await savePlatformKey(key, admin.userId);
        return res.json(await view());
      }

      if (b.orgId) {
        const orgId = String(b.orgId);
        const [org] = await sql`select id from organizations where id = ${orgId}`;
        if (!org) return res.status(404).json({ error: 'No such organization.' });

        if (has('topupUsd')) {
          const amount = Math.round(Number(b.topupUsd) * 100) / 100;
          if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 100000) {
            return res.status(400).json({ error: 'A top-up is an amount in dollars, like 20 (or -5 to correct one).' });
          }
          await topUpOrg(orgId, amount, String(b.note || '').trim().slice(0, 200), admin.userId);
          return res.json(await view());
        }
        if (has('markupPct')) {
          const pct = Number(b.markupPct);
          if (!Number.isFinite(pct) || pct < 0 || pct > 1000) {
            return res.status(400).json({ error: 'The markup is a percentage from 0 to 1000, like 30.' });
          }
          await sql`
            insert into org_billing (org_id, markup_pct, updated_at) values (${orgId}, ${pct}, now())
            on conflict (org_id) do update set markup_pct = excluded.markup_pct, updated_at = now()
          `;
          return res.json(await view());
        }
        if (has('models')) {
          if (!Array.isArray(b.models) || b.models.length > 200) {
            return res.status(400).json({ error: 'models must be a list of OpenRouter model ids.' });
          }
          const ids = [...new Set(b.models.map((m) => String(m || '').trim()).filter(Boolean))];
          for (const id of ids) {
            const bad = await unknownModel(id);
            if (bad) return res.status(400).json({ error: bad });
          }
          await sql`
            insert into org_billing (org_id, allowed_models, updated_at) values (${orgId}, ${ids}, now())
            on conflict (org_id) do update set allowed_models = excluded.allowed_models, updated_at = now()
          `;
          return res.json(await view());
        }
        if (b.unlimited === true) {
          const [was] = await sql`select balance_usd from org_billing where org_id = ${orgId}`;
          if (was && was.balance_usd !== null) {
            await sql`update org_billing set balance_usd = null, updated_at = now() where org_id = ${orgId}`;
            await sql`
              insert into org_topups (org_id, amount_usd, balance_after, note, by_user)
              values (${orgId}, 0, null, ${`Limit removed (the balance was $${Number(was.balance_usd).toFixed(2)})`}, ${admin.userId})
            `;
          }
          return res.json(await view());
        }

        const model = String(b.model || '').trim();
        if (model) {
          const bad = await unknownModel(model);
          if (bad) return res.status(400).json({ error: bad });
        }
        await sql`
          insert into org_billing (org_id, default_model, updated_at) values (${orgId}, ${model}, now())
          on conflict (org_id) do update set default_model = excluded.default_model, updated_at = now()
        `;
        return res.json(await view());
      }

      if (has('defaultModel') || has('ceilingUsd') || has('stopMessage')) {
        const patch = {};
        if (has('stopMessage')) {
          const m = b.stopMessage || {};
          if (m.he !== undefined) patch.stopMessageHe = String(m.he || '');
          if (m.en !== undefined) patch.stopMessageEn = String(m.en || '');
        }
        if (has('defaultModel')) {
          const model = String(b.defaultModel || '').trim();
          if (model) {
            const bad = await unknownModel(model);
            if (bad) return res.status(400).json({ error: bad });
          }
          patch.defaultModel = model;
        }
        if (has('ceilingUsd')) {
          const usd = Number(b.ceilingUsd);
          if (!Number.isFinite(usd) || usd < 0 || usd > 100000) {
            return res.status(400).json({ error: 'The monthly ceiling must be an amount in dollars, like 50.' });
          }
          patch.monthlyCeilingUsd = usd;
        }
        await savePlatformSettings(patch, admin.userId);
        return res.json(await view());
      }

      return res.status(400).json({ error: 'Nothing to change.' });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  return res.status(405).end();
}

/* A typo would leave every chatbot it reaches answering with an error, so a
   model must be one OpenRouter lists. If the list cannot be read right now,
   the id is taken as given. */
async function unknownModel(model) {
  const models = await openRouterModels().catch(() => null);
  if (models && !models.some((m) => m.id === model)) return `OpenRouter has no model "${model}".`;
  return '';
}

async function view() {
  const [p] = await sql`
    select key_hint, updated_at, default_model, monthly_ceiling_usd, stop_message_he, stop_message_en
    from platform_billing where id = true
  `;
  const key = await platformKey();
  const info = key ? await describeOpenRouterKey(key) : null;

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const [orgs, billing, usage] = await Promise.all([
    listOrgs(),
    sql`
      select b.org_id, b.default_model, b.balance_usd, b.markup_pct, b.allowed_models,
             (select t.amount_usd from org_topups t where t.org_id = b.org_id and t.amount_usd > 0 order by t.at desc, t.id desc limit 1) as last_topup
      from org_billing b
    `,
    sql`
      select org_id, count(*)::int as calls,
             coalesce(sum(input_tokens), 0)::bigint  as input,
             coalesce(sum(output_tokens), 0)::bigint as output,
             coalesce(sum(cost_usd), 0)               as usd,
             coalesce(sum(charged_usd), 0)            as charged,
             -- Profit counts only calls that were charged: those before balances existed never were.
             coalesce(sum(cost_usd) filter (where charged_usd is not null), 0) as charged_cost
      from llm_usage where at >= ${monthStart}
      group by org_id
    `,
  ]);
  const own = new Map(billing.map((r) => [r.org_id, r.default_model || '']));
  const money = new Map(billing.map((r) => [r.org_id, r]));
  const used = new Map(usage.map((u) => [u.org_id, u]));
  const round = (v) => Math.round(Number(v || 0) * 10000) / 10000;
  const ceiling = p && p.monthly_ceiling_usd != null ? Number(p.monthly_ceiling_usd) : 50;
  const defaultModel = (p && p.default_model) || '';
  const spent = round(await monthSpendUsd({ fresh: true }));

  const charged = round(usage.reduce((a, u) => a + Number(u.charged || 0), 0));
  const rows = orgs.map((o) => {
      const u = used.get(o.id);
      const usd = round(u && u.usd);
      const m = money.get(o.id);
      const balance = m && m.balance_usd !== null && m.balance_usd !== undefined ? round(m.balance_usd) : null;
      const markupPct = m ? Number(m.markup_pct || 0) : 0;
      const lastTopup = m && m.last_topup !== null && m.last_topup !== undefined ? Number(m.last_topup) : null;
      return {
        id: o.id,
        name: o.name,
        members: o.members,
        agents: o.agents,
        model: own.get(o.id) || '',
        runsOn: own.get(o.id) || defaultModel,
        // What its AI Chatbots, apps and automations may choose from, besides runsOn.
        models: (m && Array.isArray(m.allowed_models)) ? m.allowed_models : [],
        // null: no limit of its own. Otherwise what it has left, in USD as it is charged.
        balance,
        markupPct,
        lastTopup,
        // Low: under a fifth of its last top-up. Stopped: nothing left.
        low: balance !== null && balance > 0 && lastTopup !== null && balance < lastTopup * 0.2,
        stopped: balance !== null && balance <= 0,
        // What its balance can still buy of OpenRouter, at its markup.
        canStillCostUsd: balance === null ? null : round(Math.max(balance, 0) / (1 + markupPct / 100)),
        month: {
          calls: u ? u.calls : 0,
          input: u ? Number(u.input) : 0,
          output: u ? Number(u.output) : 0,
          usd,
          charged: round(u && u.charged),
          profit: round(Number((u && u.charged) || 0) - Number((u && u.charged_cost) || 0)),
          share: ceiling > 0 ? usd / ceiling : null,
        },
      };
    }).sort((a, b) => b.month.usd - a.month.usd || a.name.localeCompare(b.name));

  /* What the balances handed out can still spend at OpenRouter, against what
     is left under this month's ceiling: past it, the ceiling stops everyone
     before their balances run out. */
  const promised = round(rows.reduce((a, o) => a + (o.canStillCostUsd || 0), 0));
  const left = ceiling > 0 ? round(Math.max(ceiling - spent, 0)) : null;

  return {
    key: { set: !!key, hint: (p && p.key_hint) || '', updatedAt: (p && p.updated_at) || null, info },
    defaultModel,
    ceilingUsd: ceiling,
    stopMessage: {
      he: (p && p.stop_message_he) || '',
      en: (p && p.stop_message_en) || '',
      defaults: STOP_MESSAGE_DEFAULT,
    },
    month: {
      from: monthStart,
      usd: spent,
      charged,
      profit: round(charged - usage.reduce((a, u) => a + Number(u.charged_cost || 0), 0)),
      calls: usage.reduce((a, u) => a + u.calls, 0),
      input: usage.reduce((a, u) => a + Number(u.input), 0),
      output: usage.reduce((a, u) => a + Number(u.output), 0),
      share: ceiling > 0 ? Math.min(spent / ceiling, 1) : null,
    },
    balances: { promisedCostUsd: promised, leftUnderCeilingUsd: left, over: left !== null && promised > left },
    orgs: rows,
  };
}
