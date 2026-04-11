import { sql } from '../../_db.js';
import { checkAuth } from '../../_auth.js';

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;

  const { id } = req.query;

  if (req.method === 'GET') {
    const rows = await sql`
      select id, agent_id, skill_id, title, content, created_at
      from documents
      where agent_id = ${id}
      order by created_at desc
    `;
    return res.json(rows);
  }

  if (req.method === 'POST') {
    const { docId, skillId, title, content } = req.body;
    await sql`
      insert into documents (id, agent_id, skill_id, title, content)
      values (${docId}, ${id}, ${skillId || null}, ${title}, ${content})
    `;
    return res.status(201).json({
      id: docId,
      agent_id: id,
      skill_id: skillId || null,
      title,
      content,
      created_at: new Date().toISOString(),
    });
  }

  res.status(405).end();
}
