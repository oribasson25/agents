import { sql } from '../../_db.js';
import { jarvisGate, numberInScope, ownerInScope } from '../../_jarvisAccess.js';
import { getNumber } from '../../_waControl.js';
import { getGroup, groupSettingsOf, listDates, listSchedules, proactiveOf, sanitizeGroupPatch, sanitizeProactive } from '../../_waGroups.js';
import { SHABBAT_CITIES } from '../../_waGroupCalendar.js';
import { jobState } from '../../_waGroupKnowledge.js';

/**
 * One WhatsApp group of a linked number. Admins only.
 *
 *   GET   ?numberId&jid → its settings, what it learned (summary), and the activity log
 *   PATCH ?numberId&jid → { mode, agentId, instructions, engagement, replyLength, allowReactions,
 *                           muteHours (0 unmutes), proactive: { birthdays, holidays, shabbat, welcome } }
 *
 * The activity log is what the number did and why, with the message that
 * prompted it; the group's conversation itself is not listed here.
 */
export default async function handler(req, res) {
  const admin = await jarvisGate(req, res);
  if (!admin) return;

  const numberId = String(req.query.numberId || '');
  const jid = String(req.query.jid || '');
  const found = await getNumber(numberId);
  const number = (await numberInScope(admin, found)) ? found : null;
  const group = number && (await getGroup(numberId, jid));
  if (!group) return res.status(404).json({ error: 'No such group.' });

  if (req.method === 'GET') return res.json(await view(number, group));

  if (req.method === 'PATCH') {
    const { patch, error } = sanitizeGroupPatch(req.body || {});
    if (error) return res.status(400).json({ error });
    if (patch.agentId) {
      // Only the owner's own AI Chatbots: their key pays for the group.
      const [agent] = await sql`select id from agents where id = ${patch.agentId} and org_id = (select org_id from users where id = ${number.owner_user_id})`;
      if (!agent) return res.status(400).json({ error: 'That AI Chatbot does not belong to this number’s account.' });
    }
    let proactive = group.proactive || {};
    if (req.body?.proactive !== undefined) {
      const clean = sanitizeProactive(req.body.proactive || {}, group);
      if (clean.error) return res.status(400).json({ error: clean.error });
      proactive = clean.proactive;
    }
    const next = {
      mutedUntil: patch.mutedUntil !== undefined ? patch.mutedUntil : group.muted_until,
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
             muted_until = ${next.mutedUntil}, proactive = ${JSON.stringify(proactive)},
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
    select count(*) filter (where action in ('reply', 'react', 'poll') and at > now() - interval '1 hour')::int as last_hour,
           count(*) filter (where action in ('reply', 'react', 'poll') and at > now() - interval '24 hours')::int as today
    from wa_group_events where number_id = ${number.id} and jid = ${group.jid}
  `;
  const agents = await sql`select id, data->>'name' as name from agents where org_id = (select org_id from users where id = ${number.owner_user_id}) order by data->>'name'`;
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
    mutedUntil: group.muted_until && new Date(group.muted_until) > new Date() ? group.muted_until : null,
    timezone: groupSettingsOf(number).timezone,
    proactive: proactiveOf(group),
    cities: Object.entries(SHABBAT_CITIES).map(([id, c]) => ({ id, name: c.name })),
    schedules: (await listSchedules(number.id, group.jid)).map(scheduleView),
    dates: (await listDates(number.id, group.jid)).map(({ greeted_on, ...d }) => d),
    events: events.map((e) => ({ id: Number(e.id), at: e.at, action: e.action, unsolicited: e.unsolicited, ...e.details })),
    agents,
  };
}

/** A schedule as the screens read it. */
export function scheduleView(r) {
  return {
    id: Number(r.id), title: r.title, kind: r.kind, body: r.body, pollOptions: r.poll_options || [],
    repeat: r.repeat, onDate: r.on_date, atTime: r.at_time, weekdays: r.weekdays || [], monthDay: r.month_day,
    nextRunAt: r.next_run_at, enabled: r.enabled, sending: r.run_now, lastRunAt: r.last_run_at, lastStatus: r.last_status,
  };
}
