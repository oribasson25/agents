import { sql } from '../../_db.js';
import { requireSession } from '../../_auth.js';
import { getUserSettings, resolveApiConfig } from '../../_settings.js';
import { accessTo, allows, refuse } from '../../_access.js';
import { storeDocument } from '../../_knowledge.js';
import { logError } from '../../_errorLog.js';

/** The caller's level on the agent — a document id is not a capability. */
async function agentLevel(agentId, user) {
  return (await accessTo(user, 'agent', agentId)).level;
}


export default async function handler(req, res) {
  const user = await requireSession(req, res);
  if (!user) return;

  const { id } = req.query;
  const level = await agentLevel(id, user);
  if (!allows(level, 'view')) return res.status(404).json({ error: 'Agent not found' });
  if (req.method !== 'GET' && !allows(level, 'edit')) return refuse(res, level, 'this AI Chatbot');

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
    if (typeof docId !== 'string' || typeof title !== 'string' || typeof content !== 'string'
        || docId.length > 100 || docId.includes('#')) {
      return res.status(400).json({ error: 'docId, title and content must be text, and docId a plain id' });
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
      if (err.code === 'DOC_CONFLICT') {
        return res.status(409).json({ error: 'A document with this id already exists. Upload it again as a new document.', code: 'DOC_CONFLICT' });
      }
      /* The reason goes to the log, not to the browser: it is database text. */
      console.error('Error inserting document:', err);
      await logError({ agentId: id, source: 'knowledge', message: err.message, context: { step: 'upload' } }).catch(() => {});
      return res.status(500).json({ error: 'The document could not be saved. Try again.' });
    }
  }

  res.status(405).end();
}
