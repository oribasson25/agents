import { sql } from '../../../_db.js';
import { checkAdmin } from '../../../_auth.js';

export default async function handler(req, res) {
  const admin = checkAdmin(req, res);
  if (!admin) return;

  const { userId } = req.query;

  if (req.method !== 'DELETE') return res.status(405).end();

  const [target] = await sql`select id, username from users where id = ${userId}`;
  if (!target) return res.status(404).json({ error: 'User not found' });

  if (target.id === admin.userId) {
    return res.status(400).json({ error: "You can't delete your own account." });
  }

  // The caller must echo the username back, so a misplaced click can't wipe an
  // account and everything it owns.
  if ((req.query.confirm || '') !== target.username) {
    return res.status(400).json({ error: 'Confirmation does not match the username.' });
  }

  const [{ count: agentCount }] = await sql`
    select count(*)::int as count from agents where user_id = ${userId}
  `;

  // whatsapp_messages has no foreign key to agents, so its rows have to go
  // first. documents, chat_sessions and gmail_tokens cascade from agents; the
  // user's own rows in other tables cascade from users.
  await sql`
    delete from whatsapp_messages
    where agent_id in (select id from agents where user_id = ${userId})
  `;
  await sql`delete from agents where user_id = ${userId}`;
  await sql`delete from users where id = ${userId}`;

  return res.json({ ok: true, username: target.username, deletedAgents: agentCount });
}
