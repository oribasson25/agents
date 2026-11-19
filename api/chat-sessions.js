import { sql } from './_db.js';
import { requireSession } from './_auth.js';
import { member, visible, accessTo, allows, refuse } from './_access.js';
import { validSessionId } from './_agentRunner.js';

/** The ids of the agents whose conversations this person may read. */
async function readableAgentIds(user) {
  const me = await member(user);
  if (!me) return [];
  const rows = await sql`select id, org_id from agents where org_id = ${me.orgId}`;
  return (await visible(me, 'agent', rows)).map(({ row }) => row.id);
}

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
 *
 *   GET ?…filters                → { sessions, total, sources } — each with its whole transcript
 *   GET ?…filters&preview=1      → the same, each with first_user_message instead of messages
 *   GET ?id=<id>                 → { session } — one conversation, whole
 */
export default async function handler(req, res) {
  const user = await requireSession(req, res);
  if (!user) return;
  if (req.method === 'PUT')    return saveTestSession(req, res, user);
  if (req.method === 'DELETE') return deleteSession(req, res, user);
  if (req.method !== 'GET') return res.status(405).end();
  if (req.query.id) return oneSession(req, res, user);

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
  /* A list needs a line per conversation, not its transcript: with
     preview=1 only the first thing the person said comes back, and the
     whole conversation is read by id when it is opened. */
  const full         = req.query.preview !== '1';

  const toEnd = to ? `${to}T23:59:59.999Z` : null;
  /* A conversation is readable by whoever may see the chatbot it was with. */
  const readable = allUsers ? [] : await readableAgentIds(user);

  /* The usual order (newest first) is a plain column, so the index on
     started_at serves it; the others are worked out per row. */
  const byStarted = sort === 'started' && dir === 'desc';
  const listed = byStarted
    ? sql`
    select
      cs.id, cs.agent_id, cs.source,
      case when ${full}::boolean then cs.messages end as messages,
      case when ${full}::boolean then null else left((select m->>'content' from jsonb_array_elements(cs.messages) m where m->>'role' = 'user' limit 1), 300) end as first_user_message,
      cs.started_at, cs.updated_at,
      greatest(extract(epoch from (cs.updated_at - cs.started_at)), 0)::int as duration_seconds,
      jsonb_array_length(cs.messages)                                      as message_count,
      a.data->>'name'   as agent_name,
      a.data->>'avatar' as agent_avatar,
      u.username        as owner_username
    from chat_sessions cs
    join agents a on a.id = cs.agent_id
    left join users u on u.id = a.user_id
    where (${allUsers}::boolean or cs.agent_id = any(${readable}::text[]))
      and (${agentId}::text is null or cs.agent_id = ${agentId})
      and (case when ${source}::text is null then cs.source <> 'test' else cs.source = ${source} end)
      and (${q}::text is null or cs.messages::text ilike '%' || ${q} || '%')
      and (${from}::timestamptz is null or cs.started_at >= ${from}::timestamptz)
      and (${toEnd}::timestamptz is null or cs.started_at <= ${toEnd}::timestamptz)
      and (${minSeconds}::int is null or extract(epoch from (cs.updated_at - cs.started_at)) >= ${minSeconds})
      and (${maxSeconds}::int is null or extract(epoch from (cs.updated_at - cs.started_at)) <= ${maxSeconds})
      and (${minMessages}::int is null or jsonb_array_length(cs.messages) >= ${minMessages})
    order by cs.started_at desc
    limit ${limit} offset ${offset}
  `
    : sql`
    select
      cs.id, cs.agent_id, cs.source,
      case when ${full}::boolean then cs.messages end as messages,
      case when ${full}::boolean then null else left((select m->>'content' from jsonb_array_elements(cs.messages) m where m->>'role' = 'user' limit 1), 300) end as first_user_message,
      cs.started_at, cs.updated_at,
      greatest(extract(epoch from (cs.updated_at - cs.started_at)), 0)::int as duration_seconds,
      jsonb_array_length(cs.messages)                                      as message_count,
      a.data->>'name'   as agent_name,
      a.data->>'avatar' as agent_avatar,
      u.username        as owner_username
    from chat_sessions cs
    join agents a on a.id = cs.agent_id
    left join users u on u.id = a.user_id
    where (${allUsers}::boolean or cs.agent_id = any(${readable}::text[]))
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

  const counted = sql`
    select count(*)::int as total
    from chat_sessions cs
    join agents a on a.id = cs.agent_id
    where (${allUsers}::boolean or cs.agent_id = any(${readable}::text[]))
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
  const present = sql`
    select cs.source, count(*)::int as count
    from chat_sessions cs
    join agents a on a.id = cs.agent_id
    where (${allUsers}::boolean or cs.agent_id = any(${readable}::text[]))
      and cs.source <> 'test'
    group by cs.source
    order by cs.source
  `;

  /* Three independent questions: asked at once rather than one after another. */
  const [rows, [countRow], sources] = await Promise.all([listed, counted, present]);
  return res.json({ sessions: rows, total: countRow.total, sources, limit, offset });
}

/** One conversation, whole, for whoever may see the chatbot it was with. */
async function oneSession(req, res, user) {
  const id = str(req.query.id);
  const [row] = await sql`
    select cs.id, cs.agent_id, cs.source, cs.messages, cs.started_at, cs.updated_at,
           greatest(extract(epoch from (cs.updated_at - cs.started_at)), 0)::int as duration_seconds,
           jsonb_array_length(cs.messages) as message_count,
           a.data->>'name' as agent_name, a.data->>'avatar' as agent_avatar
    from chat_sessions cs join agents a on a.id = cs.agent_id
    where cs.id = ${id}
  `;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!(user.isAdmin && req.query.scope === 'all')) {
    const { level } = await accessTo(user, 'agent', row.agent_id);
    if (!allows(level, 'view')) return res.status(404).json({ error: 'Not found' });
  }
  return res.json({ session: row });
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

  /* Testing is reading: anyone who may see the chatbot may talk to it. */
  const { level } = await accessTo(user, 'agent', agentId);
  if (!allows(level, 'view')) return res.status(404).json({ error: 'Agent not found' });

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

  /* The id is the browser's to choose, so a conversation already stored
     under it is only replaced when it is this chatbot's own test: never
     somebody's widget or WhatsApp conversation, never another chatbot's. */
  if (!validSessionId(id)) return res.status(400).json({ error: 'id must be up to 120 letters, digits or _ . : + -, and may not start with wa_ or wal_' });
  const written = await sql`
    insert into chat_sessions (id, agent_id, source, messages)
    values (${id}, ${agentId}, 'test', ${JSON.stringify(clean)}::jsonb)
    on conflict (id) do update set
      messages   = excluded.messages,
      updated_at = now()
    where chat_sessions.agent_id = excluded.agent_id and chat_sessions.source = 'test'
    returning id
  `;
  if (!written.length) return res.status(409).json({ error: 'That conversation id is taken. Start a new test conversation.' });
  return res.json({ ok: true, id, stored: clean.length });
}

/** A conversation, deleted by someone who may edit the chatbot it was with. */
async function deleteSession(req, res, user) {
  const id = str(req.query.id);
  if (!id) return res.status(400).json({ error: 'id is required' });
  const [found] = await sql`select agent_id from chat_sessions where id = ${id}`;
  if (!found) return res.status(404).json({ error: 'Not found' });
  const { level } = await accessTo(user, 'agent', found.agent_id);
  if (!allows(level, 'edit')) return refuse(res, level, 'this AI Chatbot');
  const rows = await sql`delete from chat_sessions where id = ${id} returning id`;
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
