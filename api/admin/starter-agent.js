import { sql } from '../_db.js';
import { checkAdmin } from '../_auth.js';
import { TEMPLATE_AGENT_NAME, findTemplateAgent } from '../_defaultAgent.js';

/**
 * Reports whether new sign-ups will actually receive a starter agent, and when
 * they won't, why — the template is found by name, so it can silently stop
 * matching after a rename or an ownership change.
 */
export default async function handler(req, res) {
  const admin = checkAdmin(req, res);
  if (!admin) return;
  if (req.method !== 'GET') return res.status(405).end();

  try {
    const template = await findTemplateAgent();

    // Everything named like the template, so a miss explains itself.
    const candidates = await sql`
      select a.id,
             a.data->>'name'  as name,
             a.user_id,
             u.username,
             coalesce(u.is_admin, false) as owner_is_admin
      from agents a
      left join users u on u.id = a.user_id
      where lower(trim(coalesce(a.data->>'name', ''))) like ${'%' + TEMPLATE_AGENT_NAME + '%'}
      order by a.updated_at desc
      limit 10
    `;

    if (!template) {
      const reason = candidates.length === 0
        ? `No agent whose name contains "${TEMPLATE_AGENT_NAME}" exists.`
        : candidates.some(c => !c.user_id)
          ? 'A matching agent exists but has no owner, so it cannot be used as the template.'
          : candidates.some(c => !c.owner_is_admin)
            ? 'A matching agent exists but its owner is not an admin. Only an admin-owned agent can be the template.'
            : `A matching agent exists but its name is not exactly "${TEMPLATE_AGENT_NAME}".`;
      return res.json({ found: false, templateName: TEMPLATE_AGENT_NAME, reason, candidates });
    }

    const [{ count }] = await sql`
      select count(*)::int as count from documents where agent_id = ${template.id}
    `;

    return res.json({
      found: true,
      templateName: TEMPLATE_AGENT_NAME,
      agentId: template.id,
      name: template.data?.name || '',
      owner: template.username,
      documents: count,
      skills: (template.data?.skills || []).length,
      tools: (template.data?.tools || []).length,
      candidates,
    });
  } catch (err) {
    return res.status(500).json({ found: false, templateName: TEMPLATE_AGENT_NAME, reason: err.message });
  }
}
