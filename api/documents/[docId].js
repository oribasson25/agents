import { sql } from '../_db.js';
import { checkAuth } from '../_auth.js';
import { getUserSettings, resolveApiConfig } from '../_settings.js';
import { rechunk, normalizeDocument } from '../_knowledge.js';

/** Loads the document only if the caller owns the agent it belongs to. */
async function ownedDoc(docId, userId) {
  const [row] = await sql`
    select d.id, d.agent_id, d.skill_id, d.title, d.content, d.raw_content, d.normalized
    from documents d join agents a on a.id = d.agent_id
    where d.id = ${docId} and a.user_id = ${userId}
  `;
  return row || null;
}

export default async function handler(req, res) {
  const user = checkAuth(req, res);
  if (!user) return;

  const { docId } = req.query;
  const doc = await ownedDoc(docId, user.userId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  /* An edit has to rebuild the chunks, or search keeps answering from the old text. */
  if (req.method === 'PATCH') {
    const { title, content } = req.body || {};
    if (!title || !content) return res.status(400).json({ error: 'title and content required' });
    await sql`
      update documents set title = ${title}, content = ${content}, updated_at = now()
      where id = ${docId}
    `;
    const chunks = await rechunk(docId, doc.agent_id, doc.skill_id, title, content);
    return res.status(200).json({ id: docId, title, content, chunks });
  }

  /* Re-run the model over this document, or put the original back. */
  if (req.method === 'POST') {
    const action = (req.body || {}).action;

    if (action === 'restore') {
      if (!doc.raw_content) return res.status(400).json({ error: 'No original stored for this document' });
      await sql`
        update documents
        set content = ${doc.raw_content}, raw_content = null, normalized = false, updated_at = now()
        where id = ${docId}
      `;
      const chunks = await rechunk(docId, doc.agent_id, doc.skill_id, doc.title, doc.raw_content);
      return res.json({ id: docId, content: doc.raw_content, normalized: false, chunks });
    }

    if (action === 'normalize') {
      const settings = await getUserSettings(user.userId);
      const apiConfig = resolveApiConfig(settings, null);
      // Always rewrite from the original, so running this twice does not
      // compound one rewrite on top of another.
      const source = doc.raw_content || doc.content;
      const { text, normalized, reason } = await normalizeDocument({
        title: doc.title, content: source, apiConfig, agentId: doc.agent_id,
      });
      if (!normalized) return res.status(422).json({ error: reason || 'Could not reorganise this document' });

      await sql`
        update documents
        set content = ${text}, raw_content = ${source}, normalized = true, updated_at = now()
        where id = ${docId}
      `;
      const chunks = await rechunk(docId, doc.agent_id, doc.skill_id, doc.title, text);
      return res.json({ id: docId, content: text, normalized: true, chunks });
    }

    return res.status(400).json({ error: 'Unknown action' });
  }

  if (req.method === 'DELETE') {
    // Chunks go with it: the foreign key cascades.
    await sql`delete from documents where id = ${docId}`;
    return res.status(204).end();
  }

  res.status(405).end();
}
