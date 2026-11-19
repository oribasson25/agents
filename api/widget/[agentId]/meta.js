import { sql } from '../../_db.js';
import { markSvg, markColor } from '../../_mark.js';

/**
 * What the floating button of the embed snippet shows on someone else's
 * website: the chatbot's mark and its name. The snippet puts avatarHtml into
 * the button with innerHTML, so it is only ever the mark drawn by markSvg —
 * which draws a hex colour and nothing of the chatbot's own text — never
 * anything stored on the chatbot.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const agentId = String(req.query.agentId || '');
  const [row] = await sql`select data from agents where id = ${agentId}`;
  if (!row) return res.status(404).json({ error: 'Agent not found' });

  const agent = row.data || {};
  const avatarHtml = markSvg(markColor(agent.avatar), 32);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.json({ avatarHtml, name: String(agent.name || 'Agent') });
}
