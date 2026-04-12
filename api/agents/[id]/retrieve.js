import { sql } from '../../_db.js';
import { checkAuth } from '../../_auth.js';

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;

  const { id } = req.query;

  if (req.method === 'POST') {
    const { query, skill_id } = req.body;
    if (!query || !query.trim()) return res.json({ chunks: [] });

    // Retrieve global docs + skill-specific docs (if skill_id provided)
    let chunks;
    if (skill_id) {
      // Specific skill: return skill-specific + global docs
      chunks = await sql`
        select title, content,
               ts_rank(tsv, plainto_tsquery('english', ${query})) as rank
        from documents
        where agent_id = ${id}
          and (skill_id is null or skill_id = ${skill_id})
          and tsv @@ plainto_tsquery('english', ${query})
        order by rank desc
        limit 5
      `;
    } else {
      // No skill specified: return only global docs
      chunks = await sql`
        select title, content,
               ts_rank(tsv, plainto_tsquery('english', ${query})) as rank
        from documents
        where agent_id = ${id}
          and skill_id is null
          and tsv @@ plainto_tsquery('english', ${query})
        order by rank desc
        limit 5
      `;
    }
    return res.json({ chunks });
  }

  res.status(405).end();
}
