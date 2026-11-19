import { sql } from './_db.js';
import { requireSession } from './_auth.js';
import { getUserSettings } from './_settings.js';
import { openRouterModels } from './_llm.js';

/**
 * The models a member's organization may run its items on: the list the
 * platform admin gave it, and its default. For the model pickers on an AI
 * Chatbot, an app and an automation's AI step.
 *
 *   GET → { defaultModel, models: [{ id, name, inputPerM, outputPerM, tools, ... }] }
 *
 * Prices are what the organization is charged per million tokens: OpenRouter's
 * price with its markup. The markup itself is not shown.
 */
export default async function handler(req, res) {
  const user = await requireSession(req, res);
  if (!user) return;
  if (req.method !== 'GET') return res.status(405).end();
  try {
    return res.json(await orgModels(user.userId));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

export async function orgModels(userId) {
  const settings = await getUserSettings(userId);
  if (!settings) return { defaultModel: '', models: [] };
  const [b] = settings.org_id
    ? await sql`select markup_pct from org_billing where org_id = ${settings.org_id}`
    : [null];
  const factor = 1 + Number((b && b.markup_pct) || 0) / 100;
  const ids = [...new Set([settings.model, ...(settings.allowed_models || [])].filter(Boolean))];
  const catalog = await openRouterModels().catch(() => []);
  const byId = new Map(catalog.map((m) => [m.id, m]));
  const price = (v) => (v === null || v === undefined ? null : Math.round(v * factor * 10000) / 10000);
  const models = ids.map((id) => {
    const m = byId.get(id);
    if (!m) return { id, name: id, inputPerM: null, outputPerM: null, tools: true, structured: false, images: false, files: false, contextLength: null, about: '', created: null, expires: null };
    return { ...m, inputPerM: price(m.inputPerM), outputPerM: price(m.outputPerM) };
  });
  return { defaultModel: settings.model || '', models };
}
