import { sql } from '../../_db.js';
import { requireSession } from '../../_auth.js';
import { findPhoneNumberConflict, PHONE_CONFLICT_MESSAGE } from '../../_whatsappClaim.js';
import { loadAgent, saveAgent, getOrCreateDraft, MAIN } from '../../_branches.js';
import { accessTo, allows, refuse } from '../../_access.js';
import { redactAgentSecrets } from '../../_agentFiles.js';

/* Someone who may only look does not get the chatbot's credentials. */
const shown = (data, level) => (level === 'edit' ? data : redactAgentSecrets(data));

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
  const user = await requireSession(req, res);
  if (!user) return;

  const { id } = req.query;
  const asked = req.query.branch;

  try {
    if (req.method === 'GET') {
      if (asked) {
        const loaded = await loadAgent({ agentId: id, user, branch: asked });
        if (!loaded) return res.status(404).end();
        return res.json({ ...shown(loaded.agent, loaded.access), id, _branch: loaded.branch, _access: loaded.access });
      }
      const { level } = await accessTo(user, 'agent', id);
      if (!allows(level, 'view')) return res.status(404).end();
      const [row] = await sql`
        select a.data,
               (select b.id from agent_branches b
                 where b.agent_id = a.id and b.kind = 'draft' and b.merged_at is null) as draft_id,
               (select b.data from agent_branches b
                 where b.agent_id = a.id and b.kind = 'draft' and b.merged_at is null) as draft
        from agents a
        where a.id = ${id}
      `;
      if (!row) return res.status(404).end();
      return res.json(row.draft
        ? { ...shown(row.draft, level), id, _branch: 'draft', _draftOf: id, _access: level }
        : { ...shown(row.data, level), id, _branch: MAIN, _access: level });
    }

    if (req.method === 'PUT') {
      /* saveAgent stores it under this row's id, whatever the body says. */
      const agent = { ...(req.body && typeof req.body === 'object' ? req.body : {}), id };

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
      const { level } = await accessTo(user, 'agent', id);
      if (!allows(level, 'edit')) return refuse(res, level, 'this AI Chatbot');
      /* agent_branches cascades from agents, so the branches go too. */
      await sql`delete from agents where id = ${id}`;
      return res.status(204).end();
    }
  } catch (e) {
    if (e.code === 'NO_BRANCH') return res.status(404).json({ error: e.message });
    if (e.code === 'READ_ONLY') return res.status(403).json({ error: e.message, code: e.code });
    if (e.code === 'PHONE_CONFLICT') return res.status(409).json({ error: e.message });
    throw e;
  }

  res.status(405).end();
}
