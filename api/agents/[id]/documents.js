import { sql } from '../../_db.js';
import { checkAuth } from '../../_auth.js';
import { getUserSettings, resolveApiConfig } from '../../_settings.js';
import { storeDocument } from '../../_knowledge.js';

/** The agent must belong to the caller — a document id is not a capability. */
async function ownsAgent(agentId, userId) {
  const [row] = await sql`select id from agents where id = ${agentId} and user_id = ${userId}`;
  return !!row;
}

export default async function handler(req, res) {
  const user = checkAuth(req, res);
  if (!user) return;

  const { id } = req.query;
  if (!(await ownsAgent(id, user.userId))) return res.status(404).json({ error: 'Agent not found' });

  if (req.method === 'GET') {
    // Chunks are a search detail; the list shows documents.
    const rows = await sql`
      select id, agent_id, skill_id, title, content, normalized,
             (raw_content is not null) as has_original,
             source_type, source_url, created_at,
             (select count(*)::int from documents c where c.parent_id = documents.id) as chunks
      from documents
      where agent_id = ${id} and parent_id is null
      order by created_at desc
    `;
    return res.json(rows);
  }

  if (req.method === 'POST') {
    const { docId, skillId, title, content } = req.body || {};
    if (!docId || !title || !content) {
      return res.status(400).json({ error: 'docId, title, and content are required' });
    }

    try {
      // The rewrite runs on the account's own model, so it needs the account's key.
      const settings = await getUserSettings(user.userId);
      const apiConfig = resolveApiConfig(settings, null);

      const stored = await storeDocument({
        docId, agentId: id, skillId, title, content, apiConfig,
      });
      return res.status(201).json(stored);
    } catch (err) {
      console.error('Error inserting document:', err);
      return res.status(500).json({ error: 'Database error', message: err.message });
    }
  }

  res.status(405).end();
}
