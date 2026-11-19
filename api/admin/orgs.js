import { checkAdmin } from '../_auth.js';
import { sql } from '../_db.js';
import { listOrgs, createOrg, errorReply } from '../_orgs.js';
import { topUpOrg } from '../_llm.js';

/**
 * Organizations, for the platform admin.
 *
 *   GET   → every organization, with how many people and items it holds
 *   POST  → { name, adminUsername, openingBalanceUsd?, markupPct? } — a new organization and
 *           its first admin. No opening balance: no limit of its own. The admin's
 *           temporary password comes back once.
 */
export default async function handler(req, res) {
  const admin = checkAdmin(req, res);
  if (!admin) return;
  try {
    if (req.method === 'GET') return res.json({ orgs: await listOrgs() });
    if (req.method === 'POST') {
      const { name, adminUsername, openingBalanceUsd, markupPct } = req.body || {};
      /* Checked before anything is created, so a typo in the money leaves no half-made organization. */
      const opening = openingBalanceUsd === undefined || openingBalanceUsd === null || openingBalanceUsd === '' ? null : Math.round(Number(openingBalanceUsd) * 100) / 100;
      if (opening !== null && (!Number.isFinite(opening) || opening < 0 || opening > 100000)) {
        return res.status(400).json({ error: 'The opening balance is an amount in dollars, like 20, or empty for no limit.' });
      }
      const markup = markupPct === undefined || markupPct === null || markupPct === '' ? 0 : Number(markupPct);
      if (!Number.isFinite(markup) || markup < 0 || markup > 1000) {
        return res.status(400).json({ error: 'The markup is a percentage from 0 to 1000, like 30.' });
      }
      const made = await createOrg({ name, adminUsername, createdBy: admin.userId });
      if (markup) {
        await sql`insert into org_billing (org_id, markup_pct) values (${made.id}, ${markup})
                  on conflict (org_id) do update set markup_pct = excluded.markup_pct, updated_at = now()`;
      }
      if (opening !== null) await topUpOrg(made.id, opening, 'Opening balance', admin.userId);
      return res.status(201).json(made);
    }
  } catch (err) {
    return errorReply(res, err);
  }
  return res.status(405).end();
}
