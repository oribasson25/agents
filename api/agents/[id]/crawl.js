import { sql } from '../../_db.js';
import { checkAuth } from '../../_auth.js';
import { crawlSite } from '../../_crawlSite.js';

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;

  const { id } = req.query;

  if (req.method === 'GET') {
    const rows = await sql`SELECT data FROM agents WHERE id = ${id}`;
    if (!rows.length) return res.status(404).json({ error: 'Agent not found' });
    const crawlConfig = rows[0].data.crawlConfig || { urls: [], status: 'idle' };
    return res.json(crawlConfig);
  }

  if (req.method === 'POST') {
    const { url, maxPages = 100 } = req.body || {};
    if (!url || !url.startsWith('http')) {
      return res.status(400).json({ error: 'Valid URL required' });
    }

    // Load agent
    const rows = await sql`SELECT data FROM agents WHERE id = ${id}`;
    if (!rows.length) return res.status(404).json({ error: 'Agent not found' });

    const agentData = rows[0].data;
    const existingUrls = agentData.crawlConfig?.urls || [];

    // Add URL to config if not already there
    const urls = existingUrls.includes(url) ? existingUrls : [...existingUrls, url];

    // Mark as running
    await sql`
      UPDATE agents
      SET data = data || ${JSON.stringify({ crawlConfig: { urls, status: 'running', lastCrawledAt: null, pagesCrawled: 0, maxPages } })}::jsonb
      WHERE id = ${id}
    `;

    try {
      const result = await crawlSite({ startUrl: url, agentId: id, maxPages });

      // Mark as done
      await sql`
        UPDATE agents
        SET data = data || ${JSON.stringify({
          crawlConfig: {
            urls,
            status: 'done',
            lastCrawledAt: new Date().toISOString(),
            pagesCrawled: result.pagesCrawled,
            totalChars: result.totalChars,
            maxPages,
          }
        })}::jsonb
        WHERE id = ${id}
      `;

      return res.json({ success: true, ...result });
    } catch (err) {
      await sql`
        UPDATE agents
        SET data = data || ${JSON.stringify({ crawlConfig: { urls, status: 'error', errorMessage: err.message, maxPages } })}::jsonb
        WHERE id = ${id}
      `;
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'DELETE') {
    // Remove a URL from crawlConfig and delete its documents
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: 'URL required' });

    const rows = await sql`SELECT data FROM agents WHERE id = ${id}`;
    if (!rows.length) return res.status(404).json({ error: 'Agent not found' });

    const agentData = rows[0].data;
    const normalizedUrl = url.split('?')[0].split('#')[0].replace(/\/$/, '') || url;
    const urls = (agentData.crawlConfig?.urls || []).filter(u => u !== url && u !== normalizedUrl);

    await sql`DELETE FROM documents WHERE agent_id = ${id} AND source_url = ${normalizedUrl}`;
    await sql`
      UPDATE agents
      SET data = data || ${JSON.stringify({ crawlConfig: { ...agentData.crawlConfig, urls } })}::jsonb
      WHERE id = ${id}
    `;

    return res.json({ success: true });
  }

  res.status(405).end();
}
