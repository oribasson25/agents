import { sql } from '../../_db.js';
import { checkAuth } from '../../_auth.js';
import { findPhoneNumberConflict, PHONE_CONFLICT_MESSAGE } from '../../_whatsappClaim.js';
import { loadAgent, saveAgent, getOrCreateDraft, MAIN } from '../../_branches.js';

/**
 * Reading and writing one agent.
 *
 * Editing in the browser no longer writes to the live agent. A PUT lands on
 * the agent's draft branch, and the live agent moves only when someone
 * publishes — so a half-finished prompt cannot be what a customer is talking
 * to. `?branch=main` opts out of that deliberately, and the CLI names the
 * branch it means.
 *
 * A GET answers with the draft when one is open, because that is what the
 * person editing last left behind; `_branch` says which one they are looking
 * at so the interface can say so too.
 */
export default async function handler(req, res) {
  const user = checkAuth(req, res);
  if (!user) return;

  const { id } = req.query;
  const asked = req.query.branch;

  try {
    if (req.method === 'GET') {
      if (asked) {
        const loaded = await loadAgent({ agentId: id, user, branch: asked });
        if (!loaded) return res.status(404).end();
        return res.json({ ...loaded.agent, _branch: loaded.branch });
      }
      const [row] = await sql`
        select a.data,
               (select b.id from agent_branches b
                 where b.agent_id = a.id and b.kind = 'draft' and b.merged_at is null) as draft_id,
               (select b.data from agent_branches b
                 where b.agent_id = a.id and b.kind = 'draft' and b.merged_at is null) as draft
        from agents a
        where a.id = ${id} and (a.user_id = ${user.userId} or ${!!user.isAdmin})
      `;
      if (!row) return res.status(404).end();
      return res.json(row.draft
        ? { ...row.draft, _branch: 'draft', _draftOf: id }
        : { ...row.data, _branch: MAIN });
    }

    if (req.method === 'PUT') {
      const agent = req.body;

      /* A number may be claimed by one agent platform-wide, and a draft that
         claimed one would hold it hostage without ever going live. */
      if (await findPhoneNumberConflict(agent?.whatsapp?.phoneNumberId, id)) {
        return res.status(409).json({ error: PHONE_CONFLICT_MESSAGE });
      }

      if (asked === MAIN) {
        const saved = await saveAgent({ agentId: id, user, branch: MAIN, data: agent });
        if (!saved) return res.status(404).end();
        return res.json({ ...agent, _branch: MAIN });
      }
      if (asked) {
        const saved = await saveAgent({ agentId: id, user, branch: asked, data: agent });
        if (!saved) return res.status(404).end();
        return res.json({ ...agent, _branch: saved.branch });
      }

      const draft = await getOrCreateDraft(id, user);
      if (!draft) return res.status(404).end();
      const saved = await saveAgent({ agentId: id, user, branch: draft.id, data: agent });
      return res.json({ ...agent, _branch: saved.branch, _draftCreated: draft.created });
    }

    if (req.method === 'DELETE') {
      /* agent_branches cascades from agents, so the branches go too. */
      await sql`
        delete from agents
        where id = ${id} and (user_id = ${user.userId} or ${!!user.isAdmin})
      `;
      return res.status(204).end();
    }
  } catch (e) {
    if (e.code === 'NO_BRANCH') return res.status(404).json({ error: e.message });
    throw e;
  }

  res.status(405).end();
}
