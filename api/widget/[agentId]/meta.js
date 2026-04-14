import { sql } from '../../_db.js';

function he(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const { agentId } = req.query;
  const [row] = await sql`select data from agents where id = ${agentId}`;
  if (!row) return res.status(404).json({ error: 'Agent not found' });

  const agent = row.data;
  const avatarRaw = agent.avatar || '\uD83E\uDD16';
  const avatarIsImage = avatarRaw.startsWith('data:') || avatarRaw.startsWith('http');
  const avatarHtml = avatarIsImage
    ? `<img src="${he(avatarRaw)}" style="width:32px;height:32px;border-radius:50%;object-fit:cover">`
    : he(avatarRaw);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.json({ avatarHtml, name: agent.name || 'Agent' });
}
