import { sql } from './_db.js';
import { checkAuth } from './_auth.js';

/**
 * Conversations ("interactions") for the signed-in user's agents, with the
 * filters the Interactions view offers. Admins may pass scope=all to see every
 * user's conversations.
 *
 * Every filter is sent as a nullable parameter and tested with
 * `(param is null or …)`, so the statement stays static and fully parameterized.
 */
export default async function handler(req, res) {
  const user = checkAuth(req, res);
  if (!user) return;
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
      and (${source}::text is null or cs.source = ${source})
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
      and (${source}::text is null or cs.source = ${source})
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
    group by cs.source
    order by cs.source
  `;

  return res.json({ sessions: rows, total: countRow.total, sources, limit, offset });
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
