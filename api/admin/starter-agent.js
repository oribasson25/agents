import { sql } from '../_db.js';
import { checkAdmin } from '../_auth.js';
import { listStarters, snapshotAgent, removeStarter } from '../_defaultAgent.js';

/**
 * The starters a new account is handed, and the admin-owned agents that could
 * become one.
 *
 * A starter is frozen when it is marked, so the interesting thing to report is
 * whether the agent it was taken from has moved on since — that is the one
 * state an admin cannot see from anywhere else, and the reason the Refresh
 * button exists.
 */
export default async function handler(req, res) {
  const admin = checkAdmin(req, res);
  if (!admin) return;

  try {
    if (req.method === 'GET') {
      const starters = await listStarters();

      /* Every agent an admin owns; the picker offers the ones not already
         frozen, and the rest explain why a starter says "source is gone". */
      const candidates = await sql`
        select a.id, a.data->>'name' as name, a.user_id, u.username,
               (select count(*)::int from documents d where d.agent_id = a.id and d.parent_id is null) as documents
        from agents a
        join users u on u.id = a.user_id
        where u.is_admin
        order by a.updated_at desc
        limit 100
      `;

      return res.json({
        starters: starters.map(s => ({
          id: s.id,
          name: s.name,
          sourceAgentId: s.source_agent_id,
          sourceExists: !!s.source_data,
          /* Frozen means the copy can drift from the agent it came from, and
             only a comparison says whether it has. */
          sourceChanged: !!s.source_data && JSON.stringify(s.source_data) !== JSON.stringify(s.data),
          skills: (s.data?.skills || []).length,
          tools: (s.data?.tools || []).length,
          documents: Array.isArray(s.documents) ? s.documents.length : 0,
          createdBy: s.created_by_name,
          takenAt: s.updated_at || s.created_at,
        })),
        candidates: candidates.map(c => ({
          id: c.id,
          name: c.name || '(unnamed)',
          owner: c.username,
          documents: c.documents,
          isStarter: starters.some(s => s.source_agent_id === c.id),
        })),
      });
    }

    if (req.method === 'POST') {
      const { agentId } = req.body || {};
      if (!agentId) return res.status(400).json({ error: 'agentId is required' });
      const result = await snapshotAgent({ agentId, admin });
      if (result.error) return res.status(400).json(result);
      return res.json(result);
    }

    /* Re-freezing: the same agent, as it is now. */
    if (req.method === 'PUT') {
      const { id, agentId } = req.body || {};
      if (!id || !agentId) return res.status(400).json({ error: 'id and agentId are required' });
      const result = await snapshotAgent({ agentId, admin, starterId: id });
      if (result.error) return res.status(400).json(result);
      return res.json(result);
    }

    if (req.method === 'DELETE') {
      const id = (req.query.id || '').trim();
      if (!id) return res.status(400).json({ error: 'id is required' });
      await removeStarter(id);
      return res.json({ ok: true });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  return res.status(405).end();
}
