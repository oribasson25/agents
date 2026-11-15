import { sql } from '../../../_db.js';
import { checkAdmin } from '../../../_auth.js';
import { removeMember, deleteOrg } from '../../../_orgs.js';

export default async function handler(req, res) {
  const admin = checkAdmin(req, res);
  if (!admin) return;

  const { userId } = req.query;

  if (req.method !== 'DELETE') return res.status(405).end();

  const [target] = await sql`
    select id, username, org_id,
           (select count(*)::int from users o where o.org_id = users.org_id) as org_size
    from users where id = ${userId}
  `;
  if (!target) return res.status(404).json({ error: 'User not found' });

  if (target.id === admin.userId) {
    return res.status(400).json({ error: "You can't delete your own account." });
  }

  // The caller must echo the username back, so a misplaced click can't wipe an
  // account and everything it owns.
  if ((req.query.confirm || '') !== target.username) {
    return res.status(400).json({ error: 'Confirmation does not match the username.' });
  }

  /* Someone alone in their organization takes it with them, as deleting an
     account always did. Someone with colleagues leaves their work to the
     organization: it passes to one of its admins. */
  if (target.org_size <= 1) {
    const [{ count: agentCount }] = await sql`
      select count(*)::int as count from agents where org_id = ${target.org_id}
    `;
    await deleteOrg(target.org_id);
    await sql`delete from users where id = ${userId}`;
    return res.json({ ok: true, username: target.username, deletedAgents: agentCount });
  }
  try {
    await removeMember({ orgId: target.org_id, userId });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.code });
  }
  return res.json({ ok: true, username: target.username, deletedAgents: 0 });
}
