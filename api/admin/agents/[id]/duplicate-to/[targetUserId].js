import { sql } from '../../../../_db.js';
import { checkAdmin } from '../../../../_auth.js';
import crypto from 'crypto';

export default async function handler(req, res) {
  const admin = checkAdmin(req, res);
  if (!admin) return;

  if (req.method !== 'POST') return res.status(405).end();

  const { id, targetUserId } = req.query;

  const [sourceRow] = await sql`select data from agents where id = ${id} and user_id = ${admin.userId}`;
  if (!sourceRow) return res.status(404).json({ error: 'source agent not found or not yours' });

  const [targetUser] = await sql`select id from users where id = ${targetUserId}`;
  if (!targetUser) return res.status(404).json({ error: 'target user not found' });

  const newId = crypto.randomUUID();
  const copy = {
    ...sourceRow.data,
    id: newId,
    name: sourceRow.data.name + ' (Copy)',
    createdAt: new Date().toISOString(),
  };

  await sql`insert into agents (id, data, user_id) values (${newId}, ${JSON.stringify(copy)}::jsonb, ${targetUserId})`;

  return res.status(201).json(copy);
}
