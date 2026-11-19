import { sql } from '../_db.js';
import { crawlSite, crawlKey } from '../_crawlSite.js';
import { workerAuthorized } from '../_waControl.js';

/* How many chatbots one run looks at. The oldest crawls come first, so a
   chatbot left out of one run is at the front of the next. */
const BATCH = 200;
const RUN_BUDGET_MS = 260000;

/**
 * The nightly re-crawl of every chatbot's sites.
 *
 * Each distinct site is crawled once per run, however many chatbots list it
 * (every account handed a starter chatbot lists the starter's sites), and the
 * pages are copied to the others. The chatbots crawled longest ago go first:
 * without an order the same few used every run's time and the rest were
 * never reached.
 *
 * Only Vercel's cron may call it, with CRON_SECRET — and if that is not set,
 * nobody may: it used to skip the check when the secret was missing.
 */
export default async function handler(req, res) {
  if (!process.env.CRON_SECRET) {
    return res.status(500).json({ error: 'CRON_SECRET is not set' });
  }
  if (!workerAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).end();
  }

  const startTime = Date.now();
  let crawled = 0, copied = 0, failed = 0, skipped = 0;

  try {
    const agents = await sql`
      SELECT id, data
      FROM agents
      WHERE jsonb_typeof(data->'crawlConfig'->'urls') = 'array'
        AND jsonb_array_length(data->'crawlConfig'->'urls') > 0
      ORDER BY (data->'crawlConfig'->>'lastCrawledAt') ASC NULLS FIRST
      LIMIT ${BATCH}
    `;

    /* One job per site (and page limit), in the order its first chatbot came. */
    const jobs = new Map();
    const latest = new Map();
    for (const agent of agents) {
      const crawlConfig = (agent.data && agent.data.crawlConfig) || {};
      const urls = [...new Set((crawlConfig.urls || []).filter(u => typeof u === 'string' && /^https?:\/\//i.test(u)))];
      const maxPages = Math.min(Math.max(parseInt(crawlConfig.maxPages, 10) || 100, 1), 500);
      latest.set(agent.id, { ...crawlConfig, urls: crawlConfig.urls || [], maxPages });
      for (const url of urls) {
        const key = `${crawlKey(url)}|${maxPages}`;
        if (!jobs.has(key)) jobs.set(key, { url, maxPages, agentIds: [] });
        jobs.get(key).agentIds.push(agent.id);
      }
    }

    const save = async (agentId, patch) => {
      const next = { ...latest.get(agentId), ...patch };
      latest.set(agentId, next);
      await sql`
        UPDATE agents
        SET data = data || ${JSON.stringify({ crawlConfig: next })}::jsonb
        WHERE id = ${agentId}
      `;
    };

    // One deadline for the whole run, shared out as we go. Each crawl used to
    // get the full default budget, so the second agent's crawl could still be
    // running when this function was killed — leaving that agent's status stuck
    // on "running" with its previous documents already deleted.
    const deadline = Date.now() + RUN_BUDGET_MS;

    for (const job of jobs.values()) {
      const left = deadline - Date.now();
      if (left < 20000) { skipped += job.agentIds.length; continue; }
      const [first, ...others] = job.agentIds;
      try {
        await save(first, { status: 'running', startedAt: new Date().toISOString() });
        const result = await crawlSite({ startUrl: job.url, agentId: first, maxPages: job.maxPages, budgetMs: left - 10000 });

        // A site that would not answer is a failure. Saying "done, 0 pages"
        // would look like the site had nothing on it, and the previous
        // crawl's documents are in fact still there.
        if (result.failed) {
          failed++;
          await save(first, { status: 'error', startedAt: null, errorMessage: result.errors[0] || 'The site did not answer' });
          continue;
        }
        const done = {
          status: 'done',
          startedAt: null,
          lastCrawledAt: new Date().toISOString(),
          pagesCrawled: result.pagesCrawled,
          pagesFound: result.pagesFound,
          totalChars: result.totalChars,
          stoppedEarly: result.stoppedEarly || false,
          thinPages: result.thinPages || 0,
        };
        await save(first, done);
        crawled++;

        for (const other of others) {
          try {
            await copyCrawl({ from: first, to: other, key: crawlKey(job.url) });
            await save(other, done);
            copied++;
          } catch (err) {
            failed++;
            await save(other, { status: 'error', startedAt: null, errorMessage: 'The crawl could not be copied here' }).catch(() => {});
            console.error('[CronCrawl] copy failed:', err.message);
          }
        }
      } catch (err) {
        failed++;
        await save(first, { status: 'error', startedAt: null, errorMessage: err.message }).catch(() => {});
        console.error('[CronCrawl] crawl failed:', err.message);
      }
    }
  } catch (err) {
    console.error('[CronCrawl] Fatal error:', err);
    return res.status(500).json({ error: 'The crawl run failed' });
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[CronCrawl] Done in ${elapsed}s. Crawled ${crawled} site(s), copied ${copied}, failed ${failed}, skipped ${skipped} for time.`);
  /* Counts only: which chatbots and sites were in the run is nobody's business but theirs. */
  return res.json({ success: true, elapsed: `${elapsed}s`, crawled, copied, failed, skipped });
}

/**
 * Puts the pages one chatbot's crawl just stored into another chatbot that
 * lists the same site, replacing what its last crawl left — in one statement,
 * so it never has neither. Ids take the receiving chatbot's id as a prefix.
 */
export async function copyCrawl({ from, to, key }) {
  const prefix = `${to}:`;
  await sql`
    with gone as (
      delete from documents where agent_id = ${to} and source_url = ${key} returning 1
    )
    insert into documents (id, agent_id, skill_id, parent_id, chunk_index, title, content, source_type, source_url)
    select ${prefix}::text || d.id, ${to}, null,
           case when d.parent_id is null then null else ${prefix}::text || d.parent_id end,
           d.chunk_index, d.title, d.content, d.source_type, d.source_url
    from documents d
    where d.agent_id = ${from}
      and (d.source_url = ${key}
           or d.parent_id in (select p.id from documents p where p.agent_id = ${from} and p.source_url = ${key}))
      and (select count(*) from gone) >= 0
    order by d.parent_id nulls first
  `;
}
