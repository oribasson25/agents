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

  const skippedUrls = [];

  try {
    // Find all agents that have crawl URLs configured
    const agents = await sql`
      SELECT id, data
      FROM agents
      WHERE (data->'crawlConfig'->'urls') IS NOT NULL
        AND jsonb_array_length(data->'crawlConfig'->'urls') > 0
    `;

    // One deadline for the whole run, shared out as we go. Each crawl used to
    // get the full default budget, so the second agent's crawl could still be
    // running when this function was killed — leaving that agent's status stuck
    // on "running" with its previous documents already deleted.
    const deadline = Date.now() + 260000;

    for (const agent of agents) {
      const crawlConfig = agent.data.crawlConfig || {};
      const urls = crawlConfig.urls || [];
      const maxPages = Math.min(Math.max(parseInt(crawlConfig.maxPages, 10) || 100, 1), 500);
      // Carried across this agent's URLs, so the second crawl's write does not
      // overwrite the first one's counts with a stale copy of the config.
      let latest = { ...crawlConfig, urls, maxPages };

      for (const url of urls) {
        const left = deadline - Date.now();
        if (left < 20000) { skippedUrls.push(`${agent.id} ${url}`); continue; }
        try {
          // Mark as running
          latest = { ...latest, status: 'running', startedAt: new Date().toISOString() };
          await sql`
            UPDATE agents
            SET data = data || ${JSON.stringify({ crawlConfig: latest })}::jsonb
            WHERE id = ${agent.id}
          `;

          const result = await crawlSite({ startUrl: url, agentId: agent.id, maxPages, budgetMs: left - 10000 });

          // A site that would not answer is a failure. Saying "done, 0 pages"
          // would look like the site had nothing on it, and the previous
          // crawl's documents are in fact still there.
          latest = result.failed
            ? { ...latest, status: 'error', startedAt: null, errorMessage: result.errors[0] || 'The site did not answer' }
            : {
                ...latest,
                status: 'done',
                startedAt: null,
                lastCrawledAt: new Date().toISOString(),
                pagesCrawled: result.pagesCrawled,
                pagesFound: result.pagesFound,
                totalChars: result.totalChars,
                stoppedEarly: result.stoppedEarly || false,
                thinPages: result.thinPages || 0,
              };
          await sql`
            UPDATE agents
            SET data = data || ${JSON.stringify({ crawlConfig: latest })}::jsonb
            WHERE id = ${agent.id}
          `;

          results.push({ agentId: agent.id, url, success: !result.failed, pagesCrawled: result.pagesCrawled });
        } catch (err) {
          latest = { ...latest, status: 'error', startedAt: null, errorMessage: err.message };
          await sql`
            UPDATE agents
            SET data = data || ${JSON.stringify({ crawlConfig: latest })}::jsonb
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
  console.log(`[CronCrawl] Done in ${elapsed}s. Processed ${results.length} URL(s), skipped ${skippedUrls.length} for time.`);
  return res.json({ success: true, elapsed: `${elapsed}s`, results, skipped: skippedUrls });
}
