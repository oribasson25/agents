import { sql } from './_db.js';
import { checkAuth } from './_auth.js';

/**
 * Conversations for the signed-in user's agents, with the filters the
 * Interactions view offers. Admins may pass scope=all to see every user's
 * conversations.
 *
 * Manual test chats live in the same table under source 'test', because they
 * are the same thing — a conversation with an agent. They are NOT interactions
 * though: they are the builder talking to their own agent, so they are hidden
 * unless asked for by name (source=test), which is what the agent's Manual
 * tests tab does.
 *
 * Every filter is sent as a nullable parameter and tested with
 * `(param is null or …)`, so the statement stays static and fully parameterized.
 */
export default async function handler(req, res) {
  const user = checkAuth(req, res);
  if (!user) return;
  if (req.method === 'PUT')    return saveTestSession(req, res, user);
  if (req.method === 'DELETE') return deleteSession(req, res, user);
  if (req.method !== 'GET') return res.status(405).end();

  const q            = str(req.query.q);
  const agentId      = str(req.query.agentId);
  const source       = str(req.query.source);
  const from         = str(req.query.from);          // ISO date (inclusive)
  const to           = str(req.query.to);            // ISO date (inclusive, end of day added below)
  const minSeconds   = int(req.query.minSeconds);
  const maxSeconds   = int(req.query.maxSeconds);
  const minMessages  = int(req.query.minMessages);
  const sort         = ['started', 'duration', 'messages', 'updated'].includes(req.query.sort) ? req.query.sort : 'started';
  const dir          = req.query.dir === 'asc' ? 'asc' : 'desc';
  const limit        = Math.min(parseInt(req.query.limit) || 25, 200);
  const offset       = Math.max(parseInt(req.query.offset) || 0, 0);
  const allUsers     = !!user.isAdmin && req.query.scope === 'all';

  const toEnd = to ? `${to}T23:59:59.999Z` : null;

  const rows = await sql`
    select
      cs.id,
      cs.agent_id,
      cs.source,
      cs.messages,
      cs.started_at,
      cs.updated_at,
      greatest(extract(epoch from (cs.updated_at - cs.started_at)), 0)::int as duration_seconds,
      jsonb_array_length(cs.messages)                                      as message_count,
      a.data->>'name'   as agent_name,
      a.data->>'avatar' as agent_avatar,
      u.username        as owner_username
    from chat_sessions cs
    join agents a on a.id = cs.agent_id
    left join users u on u.id = a.user_id
    where (${allUsers}::boolean or a.user_id = ${user.userId})
      and (${agentId}::text is null or cs.agent_id = ${agentId})
      and (case when ${source}::text is null then cs.source <> 'test' else cs.source = ${source} end)
      and (${q}::text is null or cs.messages::text ilike '%' || ${q} || '%')
      and (${from}::timestamptz is null or cs.started_at >= ${from}::timestamptz)
      and (${toEnd}::timestamptz is null or cs.started_at <= ${toEnd}::timestamptz)
      and (${minSeconds}::int is null or extract(epoch from (cs.updated_at - cs.started_at)) >= ${minSeconds})
      and (${maxSeconds}::int is null or extract(epoch from (cs.updated_at - cs.started_at)) <= ${maxSeconds})
      and (${minMessages}::int is null or jsonb_array_length(cs.messages) >= ${minMessages})
    order by (
      case ${sort}::text
        when 'duration' then extract(epoch from (cs.updated_at - cs.started_at))
        when 'messages' then jsonb_array_length(cs.messages)::numeric
        when 'updated'  then extract(epoch from cs.updated_at)
        else extract(epoch from cs.started_at)
      end
    ) * (case when ${dir}::text = 'asc' then -1 else 1 end) desc
    limit ${limit} offset ${offset}
  `;

  const [countRow] = await sql`
    select count(*)::int as total
    from chat_sessions cs
    join agents a on a.id = cs.agent_id
    where (${allUsers}::boolean or a.user_id = ${user.userId})
      and (${agentId}::text is null or cs.agent_id = ${agentId})
      and (case when ${source}::text is null then cs.source <> 'test' else cs.source = ${source} end)
      and (${q}::text is null or cs.messages::text ilike '%' || ${q} || '%')
      and (${from}::timestamptz is null or cs.started_at >= ${from}::timestamptz)
      and (${toEnd}::timestamptz is null or cs.started_at <= ${toEnd}::timestamptz)
      and (${minSeconds}::int is null or extract(epoch from (cs.updated_at - cs.started_at)) >= ${minSeconds})
      and (${maxSeconds}::int is null or extract(epoch from (cs.updated_at - cs.started_at)) <= ${maxSeconds})
      and (${minMessages}::int is null or jsonb_array_length(cs.messages) >= ${minMessages})
  `;

  // Channels actually present, for the source filter's options.
  const sources = await sql`
    select cs.source, count(*)::int as count
    from chat_sessions cs
    join agents a on a.id = cs.agent_id
    where (${allUsers}::boolean or a.user_id = ${user.userId})
      and cs.source <> 'test'
    group by cs.source
    order by cs.source
  `;

  return res.json({ sessions: rows, total: countRow.total, sources, limit, offset });
}

/**
 * Upsert one manual test conversation. Written after every turn rather than on
 * close, so a shut tab does not lose the run that just revealed the bug.
 * started_at is kept from the first write; updated_at is what gives the
 * conversation its duration.
 */
async function saveTestSession(req, res, user) {
  const { id, agentId, messages } = req.body || {};
  if (!id || !agentId) return res.status(400).json({ error: 'id and agentId are required' });
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages must be a non-empty array' });
  }

  const [owned] = await sql`
    select id from agents where id = ${agentId} and user_id = ${user.userId}
  `;
  if (!owned) return res.status(404).json({ error: 'Agent not found' });

  // Only the conversation itself is stored — no UI bookkeeping, no typing rows.
  const clean = messages
    .filter(m => m && (m.role === 'user' || m.role === 'agent' || m.role === 'assistant'))
    .map(m => ({
      role: m.role === 'agent' ? 'assistant' : m.role,
      content: typeof m.content === 'string' ? m.content : String(m.content ?? ''),
      skill: m.skillName || undefined,
      tools: Array.isArray(m.toolCalls) && m.toolCalls.length
        ? m.toolCalls.map(t => ({ name: t.name, input: t.input, result: t.result })) : undefined,
    }));
  if (clean.length === 0) return res.status(400).json({ error: 'nothing worth storing' });

  await sql`
    insert into chat_sessions (id, agent_id, source, messages)
    values (${id}, ${agentId}, 'test', ${JSON.stringify(clean)}::jsonb)
    on conflict (id) do update set
      messages   = excluded.messages,
      updated_at = now()
  `;
  return res.json({ ok: true, id, stored: clean.length });
}

/** Only ever the caller's own conversation, test or otherwise. */
async function deleteSession(req, res, user) {
  const id = str(req.query.id);
  if (!id) return res.status(400).json({ error: 'id is required' });
  const rows = await sql`
    delete from chat_sessions cs
    using agents a
    where cs.agent_id = a.id and cs.id = ${id} and a.user_id = ${user.userId}
    returning cs.id
  `;
  if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
  return res.json({ ok: true, id });
}

function str(value) {
  const v = (value ?? '').toString().trim();
  return v === '' ? null : v;
}

function int(value) {
  const v = str(value);
  if (v === null) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}
