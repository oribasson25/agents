import { checkAuth } from './_auth.js';
import { recentErrors } from './_errorLog.js';
import { member, grantsOf, levelFor } from './_access.js';

/** Recent failures across the caller's agents, newest first. */
export default async function handler(req, res) {
  const user = checkAuth(req, res);
  if (!user) return;
  if (req.method !== 'GET') return res.status(405).end();

  const errors = await recentErrors(user.userId, {
    agentId: (req.query.agentId || '').trim() || null,
    source: (req.query.source || '').trim() || null,
    limit: req.query.limit,
  });
  /* The organization's failures, narrowed to the chatbots this person may see. */
  const me = await member(user);
  const grants = await grantsOf(me, 'agent');
  const mine = errors.filter(e => levelFor(me, me && me.orgId, grants.get(e.agent_id)) !== 'none');
  return res.json({ errors: mine });
}
