import { sql } from './_db.js';
import { checkAuthOrToken } from './_auth.js';
import { findPhoneNumberConflict, PHONE_CONFLICT_MESSAGE } from './_whatsappClaim.js';
import { member, visible, canCreate } from './_access.js';

export default async function handler(req, res) {
  /* The CLI lists agents here to find an id, and `8legs login` calls it to
     check the token it was just given — so this has to take one. */
  const user = await checkAuthOrToken(req, res);
  if (!user) return;

  const me = await member(user);
  if (!me) return res.status(401).json({ error: 'unauthorized' });

  if (req.method === 'GET') {
    /* An agent with an open draft is shown as its draft, because that is what
       the person editing last left behind — main is what customers see, and
       returning main here would make every unpublished edit look lost. */
    const rows = await sql`
      select a.id, a.org_id, a.data,
             (select b.data from agent_branches b
               where b.agent_id = a.id and b.kind = 'draft' and b.merged_at is null) as draft
      from agents a
      where a.org_id = ${me.orgId}
      order by a.created_at desc
    `;
    /* The organization's agents this person may see, each saying how far. */
    const shown = await visible(me, 'agent', rows);
    return res.json(shown.map(({ row: r, level }) => (r.draft
      ? { ...r.draft, _branch: 'draft', _access: level }
      : { ...r.data, _branch: 'main', _access: level })));
  }

  if (req.method === 'POST') {
    if (!canCreate(me)) {
      return res.status(403).json({ error: 'Only the organization\'s admin, or a member who can edit everything, can add an AI Chatbot.', code: 'READ_ONLY' });
    }
    const agent = req.body;

    if (await findPhoneNumberConflict(agent?.whatsapp?.phoneNumberId, agent?.id)) {
      return res.status(409).json({ error: PHONE_CONFLICT_MESSAGE });
    }

    await sql`
      insert into agents (id, data, user_id)
      values (${agent.id}, ${JSON.stringify(agent)}::jsonb, ${user.userId})
    `;
    return res.status(201).json(agent);
  }

  res.status(405).end();
}
