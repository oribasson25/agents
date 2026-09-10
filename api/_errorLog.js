import { sql } from './_db.js';

const RETENTION_DAYS = 14;

/**
 * Records a failure so the assistants can read it back later — an error that
 * happened on WhatsApp or in the widget is otherwise invisible to them.
 * Never throws and never delays the caller's own error handling.
 */
export async function logError({ agentId = null, source, message, context = {} }) {
  try {
    const text = String(message || '').slice(0, 4000);
    if (!text) return;
    await sql`
      insert into error_log (agent_id, source, message, context)
      values (${agentId}, ${source || 'unknown'}, ${text}, ${JSON.stringify(context)}::jsonb)
    `;
    // Errors are rare, so pruning on write is cheap enough and needs no cron.
    await sql`delete from error_log where created_at < now() - ${`${RETENTION_DAYS} days`}::interval`;
  } catch (err) {
    console.error('[errorLog] could not record:', err.message);
  }
}

/** Recent failures for the agents a user owns. */
export async function recentErrors(userId, { agentId = null, source = null, limit = 20 } = {}) {
  const capped = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  return sql`
    select e.id, e.agent_id, e.source, e.message, e.context, e.created_at,
           a.data->>'name' as agent_name
    from error_log e
    join agents a on a.id = e.agent_id
    where a.user_id = ${userId}
      and (${agentId}::text is null or e.agent_id = ${agentId})
      and (${source}::text is null or e.source = ${source})
    order by e.created_at desc
    limit ${capped}
  `;
}
