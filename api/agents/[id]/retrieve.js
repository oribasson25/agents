import { sql } from '../../_db.js';
import { checkAuth } from '../../_auth.js';
import { searchDocuments } from '../../_knowledge.js';

export default async function handler(req, res) {
  const user = checkAuth(req, res);
  if (!user) return;
  if (req.method !== 'POST') return res.status(405).end();

  const { id } = req.query;
  const { query, skill_id } = req.body || {};

  // Someone else's agent id must not read out their knowledge base.
  const [owned] = await sql`select id from agents where id = ${id} and user_id = ${user.userId}`;
  if (!owned) return res.status(404).json({ error: 'Agent not found', chunks: [] });

  if (!query || !query.trim()) return res.json({ chunks: [] });

  // Global documents always; the active skill's documents on top of them.
  const chunks = await searchDocuments({
    agentId: id,
    query,
    skillIds: skill_id ? [skill_id] : [],
    limit: 6,
  });

  return res.json({ chunks });
}
