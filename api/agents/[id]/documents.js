import { sql } from '../../_db.js';
import { checkAuth } from '../../_auth.js';

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;

  const { id } = req.query;

  if (req.method === 'GET') {
    const rows = await sql`
      select id, agent_id, skill_id, title, content, source_type, source_url, created_at
      from documents
      where agent_id = ${id}
      order by created_at desc
    `;
    return res.json(rows);
  }

  if (req.method === 'POST') {
    const { docId, skillId, title, content } = req.body;
    
    // Validation
    if (!docId || !title || !content) {
      return res.status(400).json({ error: 'docId, title, and content are required' });
    }
    
    try {
      const result = await sql`
        insert into documents (id, agent_id, skill_id, title, content)
        values (${docId}, ${id}, ${skillId || null}, ${title}, ${content})
        returning id, agent_id, skill_id, title, content, created_at
      `;
      
      if (!result || result.length === 0) {
        return res.status(500).json({ error: 'Failed to insert document' });
      }
      
      return res.status(201).json(result[0]);
    } catch (err) {
      console.error('Error inserting document:', err);
      return res.status(500).json({ 
        error: 'Database error', 
        message: err.message 
      });
    }
  }

  res.status(405).end();
}
