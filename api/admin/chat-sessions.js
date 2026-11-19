import { sql } from '../_db.js';
import { requireAdmin } from '../_auth.js';

/**
 * Every organization's conversations, for the platform admin (not the
 * builders' own test runs, which live with each chatbot). The total counts
 * exactly what the list can show.
 *
 *   GET ?agentId&limit&offset → { sessions, total, offset, limit }
 */
export default async function handler(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  if (req.method !== 'GET') return res.status(405).end();

  const agentId = req.query.agentId ? String(req.query.agentId) : null;
  const limit   = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset  = req.query.offset === undefined || req.query.offset === '' ? 0 : Number(req.query.offset);
  if (!Number.isInteger(offset) || offset < 0) return res.status(400).json({ error: 'offset must be a whole number, 0 or more' });

  const [rows, [countRow]] = await Promise.all([
    sql`
      select
        cs.id,
        cs.agent_id,
        cs.source,
        cs.messages,
        cs.started_at,
        cs.updated_at,
        a.data->>'name' as agent_name,
        a.data->>'avatar' as agent_avatar
      from chat_sessions cs
      join agents a on a.id = cs.agent_id
      where (${agentId}::text is null or cs.agent_id = ${agentId})
        and cs.source <> 'test'   -- the builder's own test runs live in the agent, not here
      order by cs.updated_at desc
      limit ${limit} offset ${offset}
    `,
    sql`
      select count(*)::int as total
      from chat_sessions cs
      join agents a on a.id = cs.agent_id
      where (${agentId}::text is null or cs.agent_id = ${agentId})
        and cs.source <> 'test'
    `,
  ]);

  return res.json({ sessions: rows, total: countRow.total, offset, limit });
}
