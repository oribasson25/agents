import { sql } from '../../_db.js';
import { checkAuth } from '../../_auth.js';
import { findPhoneNumberConflict, PHONE_CONFLICT_MESSAGE } from '../../_whatsappClaim.js';

export default async function handler(req, res) {
  const user = checkAuth(req, res);
  if (!user) return;

  const { id } = req.query;

  if (req.method === 'GET') {
    const [row] = await sql`
      select data from agents
      where id = ${id} and (user_id = ${user.userId} or ${user.isAdmin})
    `;
    return row ? res.json(row.data) : res.status(404).end();
  }

  if (req.method === 'PUT') {
    const agent = req.body;

    if (await findPhoneNumberConflict(agent?.whatsapp?.phoneNumberId, id)) {
      return res.status(409).json({ error: PHONE_CONFLICT_MESSAGE });
    }

    await sql`
      update agents
      set data = ${JSON.stringify(agent)}::jsonb, updated_at = now()
      where id = ${id} and (user_id = ${user.userId} or ${user.isAdmin})
    `;
    return res.json(agent);
  }

  if (req.method === 'DELETE') {
    await sql`
      delete from agents
      where id = ${id} and (user_id = ${user.userId} or ${user.isAdmin})
    `;
    return res.status(204).end();
  }

  res.status(405).end();
}
