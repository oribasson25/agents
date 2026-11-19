import { requireSession } from './_auth.js';
import { sql } from './_db.js';
import { getUserSettings, saveUserSettings, emptySettings, configUsable, resolveApiConfig } from './_settings.js';

/**
 * A person's settings: their interface language, and which model their
 * organization runs on.
 *
 * Models come only from the platform (OpenRouter, through api/_llm.js), so
 * there is no key here to read or to set: `model` is what the platform admin
 * chose for the organization, and `usable` says whether the platform has
 * finished setting it up. A save changes the language and nothing else.
 *
 * `balance` says whether the organization has run out of model money or is
 * running low, for the banner every member sees; the amount itself only
 * reaches the organization's admins.
 */
export default async function handler(req, res) {
  const user = await requireSession(req, res, { allowPasswordChange: req.method === 'GET' });   // the language, read while a temporary password is being changed
  if (!user) return;

  if (req.method === 'GET') {
    const row = await getUserSettings(user.userId);
    return res.json({ ...view(row || emptySettings()), balance: await balanceOf(user.userId) });
  }

  if (req.method === 'PUT') {
    const saved = await saveUserSettings(user.userId, req.body || {});
    return res.json({ ...view(saved || emptySettings()), balance: await balanceOf(user.userId) });
  }

  return res.status(405).end();
}

function view(settings) {
  return {
    provider: 'openrouter',
    model: settings.model,
    assistantLanguage: settings.assistant_language,
    languageChosen: !!settings.language_chosen,
    usable: configUsable(resolveApiConfig(settings)),
    managed: true,
    canEditModel: false,
  };
}

/* Low: under a fifth of the last top-up, as on Admin › Billing. */
async function balanceOf(userId) {
  try {
    const [r] = await sql`
      select u.org_role, b.balance_usd,
             (select t.amount_usd from org_topups t
              where t.org_id = u.org_id and t.amount_usd > 0 order by t.at desc, t.id desc limit 1) as last_topup
      from users u left join org_billing b on b.org_id = u.org_id
      where u.id = ${userId}
    `;
    if (!r || r.balance_usd === null || r.balance_usd === undefined) return { limited: false, stopped: false, low: false };
    const usd = Math.round(Number(r.balance_usd) * 100) / 100;
    const last = r.last_topup === null || r.last_topup === undefined ? null : Number(r.last_topup);
    return {
      limited: true,
      stopped: usd <= 0,
      low: usd > 0 && last !== null && usd < last * 0.2,
      ...(r.org_role === 'admin' ? { usd } : {}),
    };
  } catch (err) {
    console.warn('[settings] could not read the organization\'s balance:', err.message);
    return { limited: false, stopped: false, low: false };
  }
}
