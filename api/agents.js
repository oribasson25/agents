import { sql } from './_db.js';
import { checkAuth } from './_auth.js';
import { findPhoneNumberConflict, PHONE_CONFLICT_MESSAGE } from './_whatsappClaim.js';

export default async function handler(req, res) {
  const user = checkAuth(req, res);
  if (!user) return;

  if (req.method === 'GET') {
    const rows = await sql`
      select data from agents
      where user_id = ${user.userId}
      order by created_at desc
    `;
    return res.json(rows.map(r => r.data));
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
