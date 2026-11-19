import { sql } from '../_db.js';
import { checkAdmin } from '../_auth.js';
import { listOrgs } from '../_orgs.js';
import {
  platformKey, savePlatformKey, savePlatformSettings, describeOpenRouterKey, openRouterModels, monthSpendUsd,
} from '../_llm.js';

/**
 * The platform's models: the OpenRouter key, the default model, the monthly
 * ceiling, the model each organization runs on, and what each organization
 * used this month. Platform admin only.
 *
 *   GET                         → { key, defaultModel, ceilingUsd, month, orgs }
 *   GET ?catalog=1              → { models } — OpenRouter's catalog, with prices
 *   PUT { key }                 → stores the key once OpenRouter has accepted it ('' removes it)
 *   PUT { defaultModel?, ceilingUsd? }
 *   PUT { orgId, model }        → the organization's own model ('' = the platform's default)
 */
export default async function handler(req, res) {
  const admin = checkAdmin(req, res);
  if (!admin) return;

  try {
    if (req.method === 'GET') {
      if (req.query && req.query.catalog) return res.json({ models: await openRouterModels() });
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

      if (has('defaultModel') || has('ceilingUsd')) {
        const patch = {};
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
  const [p] = await sql`select key_hint, updated_at, default_model, monthly_ceiling_usd from platform_billing where id = true`;
  const key = await platformKey();
  const info = key ? await describeOpenRouterKey(key) : null;

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const [orgs, billing, usage] = await Promise.all([
    listOrgs(),
    sql`select org_id, default_model from org_billing`,
    sql`
      select org_id, count(*)::int as calls,
             coalesce(sum(input_tokens), 0)::bigint  as input,
             coalesce(sum(output_tokens), 0)::bigint as output,
             coalesce(sum(cost_usd), 0)               as usd
      from llm_usage where at >= ${monthStart}
      group by org_id
    `,
  ]);
  const own = new Map(billing.map((r) => [r.org_id, r.default_model || '']));
  const used = new Map(usage.map((u) => [u.org_id, u]));
  const round = (v) => Math.round(Number(v || 0) * 10000) / 10000;
  const ceiling = p && p.monthly_ceiling_usd != null ? Number(p.monthly_ceiling_usd) : 50;
  const defaultModel = (p && p.default_model) || '';
  const spent = round(await monthSpendUsd({ fresh: true }));

  return {
    key: { set: !!key, hint: (p && p.key_hint) || '', updatedAt: (p && p.updated_at) || null, info },
    defaultModel,
    ceilingUsd: ceiling,
    month: {
      from: monthStart,
      usd: spent,
      calls: usage.reduce((a, u) => a + u.calls, 0),
      input: usage.reduce((a, u) => a + Number(u.input), 0),
      output: usage.reduce((a, u) => a + Number(u.output), 0),
      share: ceiling > 0 ? Math.min(spent / ceiling, 1) : null,
    },
    orgs: orgs.map((o) => {
      const u = used.get(o.id);
      const usd = round(u && u.usd);
      return {
        id: o.id,
        name: o.name,
        members: o.members,
        agents: o.agents,
        model: own.get(o.id) || '',
        runsOn: own.get(o.id) || defaultModel,
        month: {
          calls: u ? u.calls : 0,
          input: u ? Number(u.input) : 0,
          output: u ? Number(u.output) : 0,
          usd,
          share: ceiling > 0 ? usd / ceiling : null,
        },
      };
    }).sort((a, b) => b.month.usd - a.month.usd || a.name.localeCompare(b.name)),
  };
}
