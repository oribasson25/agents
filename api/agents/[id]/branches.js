import { checkAuthOrToken } from '../../_auth.js';
import {
  listBranches, createBranch, deleteBranch, mergeBranch,
  setTraffic, stopExperiments, loadAgent, getOrCreateDraft, MAIN,
} from '../../_branches.js';

/**
 * Everything about an agent's branches, in one function.
 *
 *   GET    ?diff=<branch>         the branches, or one branch against main
 *   POST   {name, from}           open a branch
 *   POST   {action:'merge'}       apply a branch to main and close it
 *   POST   {action:'publish'}     the interface's draft, applied to main
 *   PUT    {branch, weight}       share of conversations, 0-100
 *   PUT    {action:'stop'}        all traffic back to main
 *   DELETE ?branch=<name>         throw a branch away
 *
 * They live together because they are one screen's worth of operations, and
 * because every serverless function is a separate deployment unit to pay for.
 */
export default async function handler(req, res) {
  const user = await checkAuthOrToken(req, res);
  if (!user) return;
  const { id } = req.query;
  const body = req.body || {};

  const fail = (e) => {
    const codes = { NO_BRANCH: 404, EXISTS: 409, BAD_NAME: 400, OVER_100: 409, BAD_TARGET: 400 };
    if (e.code && codes[e.code]) return res.status(codes[e.code]).json({ error: e.message });
    throw e;
  };

  try {
    if (req.method === 'GET') {
      const branches = await listBranches(id, user);
      if (!branches) return res.status(404).json({ error: 'Agent not found' });

      /* A diff against main is what the merge screen is built on. */
      const against = req.query.diff;
      if (against) {
        const [theirs, ours] = await Promise.all([
          loadAgent({ agentId: id, user, branch: against }),
          loadAgent({ agentId: id, user, branch: MAIN }),
        ]);
        return res.json({ branches, diff: diffAgents(ours.agent, theirs.agent), branch: theirs.branch });
      }
      return res.json({ branches });
    }

    if (req.method === 'POST') {
      if (body.action === 'merge') {
        const merged = await mergeBranch({ agentId: id, user, branch: body.branch });
        if (!merged) return res.status(404).json({ error: 'Agent not found' });
        return res.json(merged);
      }
      if (body.action === 'publish') {
        const draft = await getOrCreateDraft(id, user);
        if (!draft) return res.status(404).json({ error: 'Agent not found' });
        const merged = await mergeBranch({ agentId: id, user, branch: draft.id });
        return res.json({ ...merged, published: true });
      }
      const made = await createBranch({ agentId: id, user, name: body.name, from: body.from || MAIN });
      if (!made) return res.status(404).json({ error: 'Agent not found' });
      return res.status(201).json(made);
    }

    if (req.method === 'PUT') {
      if (body.action === 'stop') {
        const stopped = await stopExperiments({ agentId: id, user });
        if (!stopped) return res.status(404).json({ error: 'Agent not found' });
        return res.json(stopped);
      }
      const set = await setTraffic({ agentId: id, user, branch: body.branch, weight: body.weight });
      if (!set) return res.status(404).json({ error: 'Agent not found' });
      return res.json(set);
    }

    if (req.method === 'DELETE') {
      const gone = await deleteBranch({ agentId: id, user, branch: req.query.branch || body.branch });
      if (!gone) return res.status(404).json({ error: 'Agent not found' });
      return res.status(200).json(gone);
    }
  } catch (e) { return fail(e); }

  res.status(405).end();
}

/**
 * What changed between two versions of an agent, field by field.
 *
 * Lists are matched by id, not by position, so a skill that moved reads as
 * moved rather than as one deletion and one unrelated addition.
 */
export function diffAgents(main, branch) {
  const out = { fields: [], skills: [], tools: [] };
  const scalars = ['name', 'avatar', 'openingMessage', 'basePrompt', 'emailEnabled'];
  for (const key of scalars) {
    if (JSON.stringify(main?.[key]) !== JSON.stringify(branch?.[key])) {
      out.fields.push({ key, main: main?.[key], branch: branch?.[key] });
    }
  }
  for (const key of ['dlp', 'scrapeUrls']) {
    if (JSON.stringify(main?.[key]) !== JSON.stringify(branch?.[key])) {
      out.fields.push({ key, main: main?.[key], branch: branch?.[key] });
    }
  }
  for (const [listKey, target] of [['skills', out.skills], ['tools', out.tools]]) {
    const byId = (list) => new Map((list || []).map(x => [x.id, x]));
    const ours = byId(main?.[listKey]);
    const theirs = byId(branch?.[listKey]);
    for (const [itemId, item] of theirs) {
      if (!ours.has(itemId)) target.push({ change: 'added', id: itemId, name: item.name });
      else if (JSON.stringify(ours.get(itemId)) !== JSON.stringify(item)) {
        target.push({ change: 'changed', id: itemId, name: item.name,
                      main: ours.get(itemId), branch: item });
      }
    }
    for (const [itemId, item] of ours) {
      if (!theirs.has(itemId)) target.push({ change: 'removed', id: itemId, name: item.name });
    }
  }
  return out;
}
