import { sql } from '../_db.js';
import { crawlSite } from '../_crawlSite.js';

export default async function handler(req, res) {
  // Vercel Crons send an Authorization header with CRON_SECRET
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).end();
  }

  const startTime = Date.now();
  const results = [];

  try {
    // Find all agents that have crawl URLs configured
    const agents = await sql`
      SELECT id, data
      FROM agents
      WHERE (data->'crawlConfig'->'urls') IS NOT NULL
        AND jsonb_array_length(data->'crawlConfig'->'urls') > 0
    `;

    for (const agent of agents) {
      const crawlConfig = agent.data.crawlConfig || {};
      const urls = crawlConfig.urls || [];
      const maxPages = crawlConfig.maxPages || 100;

      for (const url of urls) {
        try {
          // Mark as running
          await sql`
            UPDATE agents
            SET data = jsonb_set(data, '{crawlConfig,status}', '"running"')
            WHERE id = ${agent.id}
          `;

          const result = await crawlSite({ startUrl: url, agentId: agent.id, maxPages });

          // Update with success stats
          await sql`
            UPDATE agents
            SET data = data || ${JSON.stringify({
              crawlConfig: {
                ...crawlConfig,
                status: 'done',
                lastCrawledAt: new Date().toISOString(),
                pagesCrawled: result.pagesCrawled,
                totalChars: result.totalChars,
              }
            })}::jsonb
            WHERE id = ${agent.id}
          `;

          results.push({ agentId: agent.id, url, success: true, pagesCrawled: result.pagesCrawled });
        } catch (err) {
          await sql`
            UPDATE agents
            SET data = jsonb_set(data, '{crawlConfig,status}', '"error"')
            WHERE id = ${agent.id}
          `;
          results.push({ agentId: agent.id, url, success: false, error: err.message });
        }
      }
    }
  } catch (err) {
    console.error('[CronCrawl] Fatal error:', err);
    return res.status(500).json({ error: err.message });
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[CronCrawl] Done in ${elapsed}s. Processed ${results.length} URL(s).`);
  return res.json({ success: true, elapsed: `${elapsed}s`, results });
}
