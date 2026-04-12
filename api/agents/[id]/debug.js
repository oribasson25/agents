// API endpoint to debug documents in database
import { sql } from '../_db.js';
import { checkAuth } from '../_auth.js';

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;

  const { id } = req.query;

  if (req.method === 'GET') {
    try {
      // Get all documents for agent with debugging info
      const rows = await sql`
        select id, agent_id, skill_id, title, 
               left(content, 100) as content_preview,
               length(content) as content_length,
               (tsv is not null and tsv != ''::tsvector) as has_tsv,
               created_at
        from documents
        where agent_id = ${id}
        order by created_at desc
      `;
      
      return res.json({
        total: rows.length,
        documents: rows,
        debug: `${rows.length} documents stored. ${rows.filter(r => r.has_tsv).length} have valid tsv.`
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  res.status(405).end();
}
