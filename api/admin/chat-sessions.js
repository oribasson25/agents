import { sql } from '../_db.js';
import { checkAdmin } from '../_auth.js';

export default async function handler(req, res) {
  const admin = checkAdmin(req, res);
  if (!admin) return;

  if (req.method !== 'GET') return res.status(405).end();

  const agentId = req.query.agentId || null;
  const limit   = Math.min(parseInt(req.query.limit)  || 50, 200);
  const offset  = parseInt(req.query.offset) || 0;

  const rows = agentId
    ? await sql`
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
        where cs.agent_id = ${agentId}
          and cs.source <> 'test'   -- the builder's own test runs live in the agent, not here
        order by cs.updated_at desc
        limit ${limit} offset ${offset}
      `
    : await sql`
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
        where cs.source <> 'test'
        order by cs.updated_at desc
        limit ${limit} offset ${offset}
      `;

  const [countRow] = agentId
    ? await sql`select count(*)::int as total from chat_sessions where agent_id = ${agentId}`
    : await sql`select count(*)::int as total from chat_sessions`;

  return res.json({ sessions: rows, total: countRow.total, offset, limit });
}
