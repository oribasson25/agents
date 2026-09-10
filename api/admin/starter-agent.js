import { sql } from '../_db.js';
import { checkAdmin } from '../_auth.js';
import { TEMPLATE_AGENT_NAMES, findTemplateAgents } from '../_defaultAgent.js';

/**
 * Reports, per starter agent, whether new sign-ups will actually receive it —
 * and when they won't, why. The templates are found by name, so one can
 * silently stop matching after a rename or an ownership change.
 */
export default async function handler(req, res) {
  const admin = checkAdmin(req, res);
  if (!admin) return;
  if (req.method !== 'GET') return res.status(405).end();

  try {
    const found = await findTemplateAgents();

    // Everything named like a template, so a miss explains itself.
    const candidates = await sql`
      select a.id,
             a.data->>'name'  as name,
             a.user_id,
             u.username,
             coalesce(u.is_admin, false) as owner_is_admin
      from agents a
      left join users u on u.id = a.user_id
      where lower(trim(coalesce(a.data->>'name', ''))) = any(${TEMPLATE_AGENT_NAMES})
         or exists (
           select 1 from unnest(${TEMPLATE_AGENT_NAMES}::text[]) n
           where lower(trim(coalesce(a.data->>'name', ''))) like '%' || n || '%'
         )
      order by a.updated_at desc
      limit 20
    `;

    const counts = found.length
      ? await sql`
          select agent_id, count(*)::int as documents
          from documents
          where agent_id = any(${found.map(f => f.id)})
          group by agent_id
        `
      : [];

    const templates = TEMPLATE_AGENT_NAMES.map(name => {
      const hit = found.find(f => f.template_name === name);
      if (hit) {
        return {
          name,
          found: true,
          agentId: hit.id,
          owner: hit.username,
          skills: (hit.data?.skills || []).length,
          tools: (hit.data?.tools || []).length,
          documents: (counts.find(c => c.agent_id === hit.id) || {}).documents || 0,
        };
      }
      const near = candidates.filter(c => (c.name || '').toLowerCase().includes(name));
      const reason = near.length === 0
        ? `אין סוכן בשם "${name}".`
        : near.some(c => !c.user_id)
          ? `יש סוכן בשם "${name}" אבל בלי בעלים.`
          : near.some(c => !c.owner_is_admin)
            ? `יש סוכן בשם "${name}" אבל הבעלים שלו לא אדמין.`
            : `יש סוכן דומה אבל השם שלו לא בדיוק "${name}".`;
      return { name, found: false, reason, near };
    });

    return res.json({
      templateNames: TEMPLATE_AGENT_NAMES,
      templates,
      allFound: templates.every(t => t.found),
      candidates,
    });
  } catch (err) {
    return res.status(500).json({
      templateNames: TEMPLATE_AGENT_NAMES,
      templates: [],
      allFound: false,
      error: err.message,
    });
  }
}
