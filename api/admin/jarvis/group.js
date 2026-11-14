import { sql } from '../../_db.js';
import { checkAdmin } from '../../_auth.js';
import { getNumber } from '../../_waControl.js';
import { getGroup, sanitizeGroupPatch } from '../../_waGroups.js';
import { jobState } from '../../_waGroupKnowledge.js';

/**
 * One WhatsApp group of a linked number. Admins only.
 *
 *   GET   ?numberId&jid → its settings, what it learned (summary), and the activity log
 *   PATCH ?numberId&jid → { mode, agentId, instructions, engagement, replyLength, allowReactions }
 *
 * The activity log is what the number did and why, with the message that
 * prompted it; the group's conversation itself is not listed here.
 */
export default async function handler(req, res) {
  const admin = checkAdmin(req, res);
  if (!admin) return;

  const numberId = String(req.query.numberId || '');
  const jid = String(req.query.jid || '');
  const number = await getNumber(numberId);
  const group = number && (await getGroup(numberId, jid));
  if (!group) return res.status(404).json({ error: 'No such group.' });

  if (req.method === 'GET') return res.json(await view(number, group));

  if (req.method === 'PATCH') {
    const { patch, error } = sanitizeGroupPatch(req.body || {});
    if (error) return res.status(400).json({ error });
    if (patch.agentId) {
      // Only the owner's own AI Chatbots: their key pays for the group.
      const [agent] = await sql`select id from agents where id = ${patch.agentId} and user_id = ${number.owner_user_id}`;
      if (!agent) return res.status(400).json({ error: 'That AI Chatbot does not belong to this number’s account.' });
    }
    const next = {
      mode: patch.mode ?? group.mode,
      agentId: patch.agentId !== undefined ? patch.agentId : group.agent_id,
      instructions: patch.instructions ?? group.instructions,
      engagement: patch.engagement ?? group.engagement,
      replyLength: patch.replyLength ?? group.reply_length,
      allowReactions: patch.allowReactions ?? group.allow_reactions,
    };
    await sql`
      update wa_groups set mode = ${next.mode}, agent_id = ${next.agentId}, instructions = ${next.instructions},
             engagement = ${next.engagement}, reply_length = ${next.replyLength}, allow_reactions = ${next.allowReactions},
             updated_at = now()
      where number_id = ${numberId} and jid = ${jid}
    `;
    return res.json(await view(number, await getGroup(numberId, jid)));
  }

  return res.status(405).end();
}

async function view(number, group) {
  const k = group.knowledge || null;
  const events = await sql`
    select id, at, action, unsolicited, details from wa_group_events
    where number_id = ${number.id} and jid = ${group.jid}
    order by at desc limit 60
  `;
  const [counts] = await sql`
    select count(*) filter (where action in ('reply', 'react') and at > now() - interval '1 hour')::int as last_hour,
           count(*) filter (where action in ('reply', 'react') and at > now() - interval '24 hours')::int as today
    from wa_group_events where number_id = ${number.id} and jid = ${group.jid}
  `;
  const agents = await sql`select id, data->>'name' as name from agents where user_id = ${number.owner_user_id} order by data->>'name'`;
  const [numberAgent] = number.agent_id ? await sql`select data->>'name' as name from agents where id = ${number.agent_id}` : [];
  return {
    numberId: number.id,
    numberLabel: number.label,
    jid: group.jid,
    name: group.name,
    mode: group.mode,
    agentId: group.agent_id,
    numberAgentName: numberAgent?.name || null,
    instructions: group.instructions,
    engagement: group.engagement,
    replyLength: group.reply_length,
    allowReactions: group.allow_reactions,
    lastActivityAt: group.last_activity_at,
    createdAt: group.created_at,
    knowledge: k && { importedAt: k.importedAt || null, stats: k.stats || null, job: jobState(k) },
    counts,
    events: events.map((e) => ({ id: Number(e.id), at: e.at, action: e.action, unsolicited: e.unsolicited, ...e.details })),
    agents,
  };
}
