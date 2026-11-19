import { sql } from './_db.js';

/*
 * The stored side of a WhatsApp conversation with an AI Chatbot, shared by the
 * Cloud API webhook (api/whatsapp/webhook.js) and linked numbers
 * (_waRouter.mjs).
 *
 * A conversation grows for as long as the customer keeps writing, so it is
 * never read whole: only the last HISTORY_TURNS messages come back from the
 * database, and a new exchange is appended in the same statement that checks
 * the row belongs to this chatbot and to WhatsApp. A session id is
 * predictable (wa_<agent>_<phone>), so a row someone else made under it — a
 * widget visitor guessing the id, say — is neither read as history nor
 * written to.
 */

export const HISTORY_TURNS = 20;

/** Only what a customer and the chatbot said: no system, tool or other role, and only text. */
export function normalizeHistory(messages) {
  const clean = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim());
  const start = clean.findIndex((m) => m.role === 'user');
  if (start === -1) return [];
  // Claude requires strict user/assistant alternation: a burst from one side becomes one turn.
  const merged = [];
  for (const m of clean.slice(start)) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content = `${last.content}\n${m.content}`;
    else merged.push({ role: m.role, content: m.content });
  }
  return merged;
}

/** The last HISTORY_TURNS messages of a WhatsApp session of this chatbot; [] when there is none. */
export async function recentMessages(sessionId, agentId) {
  const [row] = await sql`
    select case when jsonb_typeof(cs.messages) = 'array' then coalesce((
             select jsonb_agg(t.e order by t.i)
             from jsonb_array_elements(cs.messages) with ordinality as t(e, i)
             where t.i > jsonb_array_length(cs.messages) - ${HISTORY_TURNS}
           ), '[]'::jsonb) else '[]'::jsonb end as messages
    from chat_sessions cs
    where cs.id = ${sessionId} and cs.agent_id = ${agentId} and cs.source = 'whatsapp'
  `;
  return Array.isArray(row?.messages) ? row.messages : [];
}

/**
 * Appends one exchange in one statement, so two invocations for the same
 * sender cannot lose each other's turn. Returns false when a row with this id
 * exists but is not this chatbot's WhatsApp conversation (nothing is written).
 */
export async function appendExchange({ sessionId, agentId, branchId = null, exchange }) {
  const rows = await sql`
    insert into chat_sessions (id, agent_id, source, messages, branch_id, started_at, updated_at)
    values (${sessionId}, ${agentId}, 'whatsapp', ${JSON.stringify(exchange)}, ${branchId}, now(), now())
    on conflict (id) do update
      set messages   = chat_sessions.messages || excluded.messages,
          updated_at = now()
      where chat_sessions.agent_id = excluded.agent_id and chat_sessions.source = 'whatsapp'
    returning id
  `;
  return rows.length > 0;
}

/** `prefix` as a LIKE pattern that matches only itself followed by anything. */
export function likePrefix(prefix) {
  return `${String(prefix).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
