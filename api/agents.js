import { sql } from './_db.js';
import { checkAuth } from './_auth.js';
import { findPhoneNumberConflict, PHONE_CONFLICT_MESSAGE } from './_whatsappClaim.js';

export default async function handler(req, res) {
  const user = checkAuth(req, res);
  if (!user) return;

  if (req.method === 'GET') {
    /* An agent with an open draft is shown as its draft, because that is what
       the person editing last left behind — main is what customers see, and
       returning main here would make every unpublished edit look lost. */
    const rows = await sql`
      select a.data,
             (select b.data from agent_branches b
               where b.agent_id = a.id and b.kind = 'draft' and b.merged_at is null) as draft
      from agents a
      where a.user_id = ${user.userId}
      order by a.created_at desc
    `;
    return res.json(rows.map(r => (r.draft ? { ...r.draft, _branch: 'draft' } : { ...r.data, _branch: 'main' })));
  }

  if (req.method === 'POST') {
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
