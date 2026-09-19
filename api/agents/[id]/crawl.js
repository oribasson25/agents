import { sql } from '../../_db.js';
import { checkAuth } from '../../_auth.js';
import { crawlSite } from '../../_crawlSite.js';

// The function itself is capped at 300s in vercel.json. A crawl still marked
// running well past that was killed mid-flight and is never coming back, so
// the screen should stop waiting for it rather than spin for ever.
const STALE_MS = 6 * 60 * 1000;

function withStaleCheck(cfg) {
  if (cfg.status !== 'running' || !cfg.startedAt) return cfg;
  if (Date.now() - new Date(cfg.startedAt).getTime() < STALE_MS) return cfg;
  return { ...cfg, status: 'error', errorMessage: 'The crawl ran out of time and was stopped. Try again with fewer pages.' };
}

async function saveConfig(id, cfg) {
  await sql`
    UPDATE agents SET data = data || ${JSON.stringify({ crawlConfig: cfg })}::jsonb WHERE id = ${id}
  `;
}

export default async function handler(req, res) {
  const user = checkAuth(req, res);
  if (!user) return;

  const { id } = req.query;

  // Every branch here reads or writes an agent's knowledge base, so the agent
  // has to be the caller's. Without this, any signed-in account could start a
  // crawl on someone else's agent and write documents into it.
  const [owned] = await sql`select id from agents where id = ${id} and user_id = ${user.userId}`;
  if (!owned) return res.status(404).json({ error: 'Agent not found' });

  if (req.method === 'GET') {
    const rows = await sql`SELECT data FROM agents WHERE id = ${id}`;
    const cfg = rows[0].data.crawlConfig || { urls: [], status: 'idle' };
    const checked = withStaleCheck(cfg);
    if (checked !== cfg) await saveConfig(id, checked);
    return res.json(checked);
  }

  if (req.method === 'POST') {
    const { url } = req.body || {};
    if (!url || !url.startsWith('http')) {
      return res.status(400).json({ error: 'Valid URL required' });
    }
    // What the client asks for is a request, not an instruction.
    const maxPages = Math.min(Math.max(parseInt(req.body?.maxPages, 10) || 100, 1), 500);

    const rows = await sql`SELECT data FROM agents WHERE id = ${id}`;
    if (!rows.length) return res.status(404).json({ error: 'Agent not found' });

    const existingUrls = rows[0].data.crawlConfig?.urls || [];
    const urls = existingUrls.includes(url) ? existingUrls : [...existingUrls, url];

    const running = { urls, status: 'running', startedAt: new Date().toISOString(), pagesCrawled: 0, pagesFound: 0, maxPages };
    await saveConfig(id, running);

    try {
      const result = await crawlSite({
        startUrl: url,
        agentId: id,
        maxPages,
        // Counts land in the row as the crawl goes, so the screen shows it
        // moving and a crawl that is killed still leaves a trail of how far
        // it got.
        onProgress: ({ pagesCrawled, pagesFound }) => saveConfig(id, { ...running, pagesCrawled, pagesFound }),
      });

      // A site that would not answer at all is a failure, not a crawl of zero
      // pages — the previous crawl's documents are still in place.
      if (result.failed) {
        const cfg = { urls, status: 'error', errorMessage: result.errors[0] || 'The site did not answer', maxPages };
        await saveConfig(id, cfg);
        return res.status(502).json({ error: cfg.errorMessage, ...result });
      }

      const cfg = {
        urls,
        status: 'done',
        startedAt: null,
        lastCrawledAt: new Date().toISOString(),
        pagesCrawled: result.pagesCrawled,
        pagesFound: result.pagesFound,
        totalChars: result.totalChars,
        stoppedEarly: result.stoppedEarly || false,
        thinPages: result.thinPages || 0,
        maxPages,
      };
      await saveConfig(id, cfg);
      return res.json({ success: true, crawlConfig: cfg, ...result });
    } catch (err) {
      await saveConfig(id, { urls, status: 'error', startedAt: null, errorMessage: err.message, maxPages });
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
    await saveConfig(id, { ...agentData.crawlConfig, urls });

    return res.json({ success: true });
  }

  res.status(405).end();
}
