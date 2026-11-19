import { sql } from '../../../_db.js';
import { requireAdmin } from '../../../_auth.js';
import { findPhoneNumberConflict, PHONE_CONFLICT_MESSAGE } from '../../../_whatsappClaim.js';

export default async function handler(req, res) {
  /* Admin as the database says now, not as a week-old token says. */
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { id } = req.query;

  if (req.method === 'PUT') {
    /* Stored under this row's id whatever the body says: the interface builds
       request paths from it. */
    const agent = { ...(req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}), id };

    if (await findPhoneNumberConflict(agent?.whatsapp?.phoneNumberId, id)) {
      return res.status(409).json({ error: PHONE_CONFLICT_MESSAGE });
    }

    await sql`update agents set data = ${JSON.stringify(agent)}::jsonb, updated_at = now() where id = ${id}`;
    return res.json(agent);
  }

  if (req.method === 'DELETE') {
    await sql`delete from agents where id = ${id}`;
    return res.status(204).end();
  }

  res.status(405).end();
}
