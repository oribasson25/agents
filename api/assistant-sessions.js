import { sql } from './_db.js';
import { checkAuth } from './_auth.js';

const KINDS = ['platform', 'tool', 'skill'];

/**
 * The account's conversations with the assistants. Saved once per turn, so the
 * Assistant tab can show what was asked and what the assistant did.
 */
export default async function handler(req, res) {
  const user = checkAuth(req, res);
  if (!user) return;

  if (req.method === 'GET') {
    const kind = KINDS.includes(req.query.kind) ? req.query.kind : null;
    const agentId = (req.query.agentId || '').trim() || null;
    const q = (req.query.q || '').trim() || null;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);

    const sessions = await sql`
      select s.id, s.kind, s.agent_id, s.subject, s.title, s.messages, s.started_at, s.updated_at,
             a.data->>'name' as agent_name,
             jsonb_array_length(s.messages) as message_count
      from assistant_sessions s
      left join agents a on a.id = s.agent_id
      where s.user_id = ${user.userId}
        and (${kind}::text is null or s.kind = ${kind})
        and (${agentId}::text is null or s.agent_id = ${agentId})
        and (${q}::text is null or s.messages::text ilike '%' || ${q} || '%')
      order by s.updated_at desc
      limit ${limit}
    `;
    return res.json({ sessions });
  }

  if (req.method === 'PUT') {
    const { id, kind, agentId, subject, title, messages } = req.body || {};
    if (!id || !KINDS.includes(kind)) return res.status(400).json({ error: 'id and a valid kind are required' });
    if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: 'messages required' });

    await sql`
      insert into assistant_sessions (id, user_id, kind, agent_id, subject, title, messages, started_at, updated_at)
      values (${id}, ${user.userId}, ${kind}, ${agentId || null}, ${subject || ''},
              ${(title || '').slice(0, 200)}, ${JSON.stringify(messages)}, now(), now())
      on conflict (id) do update set
        messages   = excluded.messages,
        title      = case when assistant_sessions.title = '' then excluded.title else assistant_sessions.title end,
        subject    = excluded.subject,
        updated_at = now()
      where assistant_sessions.user_id = ${user.userId}
    `;
    return res.json({ ok: true });
  }

  if (req.method === 'DELETE') {
    const id = (req.query.id || '').trim();
    if (!id) return res.status(400).json({ error: 'id required' });
    await sql`delete from assistant_sessions where id = ${id} and user_id = ${user.userId}`;
    return res.json({ ok: true });
  }

  return res.status(405).end();
}
