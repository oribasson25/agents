import { sql } from './_db.js';
import { rechunk } from './_knowledge.js';

const CRAWL_DELAY_MS = 500;
const DEFAULT_MAX_PAGES = 100;
// One page of a registry or a price table can be hundreds of thousands of
// characters, which would become hundreds of chunk rows on its own and drown
// everything else in the knowledge base. Keep the top of it.
const MAX_PAGE_CHARS = 60000;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const DECODE = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&apos;': "'", '&mdash;': '—', '&ndash;': '–', '&hellip;': '…',
};

/**
 * HTML to text, keeping the shape of the document.
 *
 * This used to end with `.replace(/\s{2,}/g, ' ')`, which flattened every page
 * into one unbroken line: no paragraphs, and headings swallowed into the
 * sentence next to them. Chunking splits on blank lines, so a whole page
 * arrived as a single block and every chunk lost the heading that said what it
 * was about. Headings now become `## ` lines and block elements become line
 * breaks, which is what makes a crawled page retrievable at all.
 */
function extractTextFromHtml(html) {
  let text = html
    // Chrome, furniture and anything with no readable text in it.
    .replace(/<(script|style|noscript|svg|iframe|form|select|button|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|footer|header|aside)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Headings carry the structure chunking relies on.
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, inner) =>
      `\n\n${'#'.repeat(Math.min(Number(level) + 1, 6))} ${inner.replace(/<[^>]+>/g, ' ').trim()}\n\n`)
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|tr|ul|ol|li|table|blockquote|pre|h[1-6])>/gi, '\n\n')
    .replace(/<\/(td|th)>/gi, '\t')
    .replace(/<[^>]+>/g, ' ');

  for (const [entity, ch] of Object.entries(DECODE)) text = text.split(entity).join(ch);
  text = text.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

  return text
    .split('\n')
    .map(line => line.replace(/[ \t\u00a0]{2,}/g, ' ').trim())
    // A stripped-out link leaves its bullet behind; a page of nav links would
    // otherwise arrive as a column of bare dashes.
    .filter(line => line !== '-' && line !== '#' && !/^#{2,6}\s*$/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')     // at most one blank line between blocks
    .trim();
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (m) return m[1].replace(/<[^>]+>/g, '').trim();
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return h1[1].replace(/<[^>]+>/g, '').trim();
  return '';
}

function extractInternalLinks(html, baseUrl) {
  const origin = new URL(baseUrl).origin;
  const links = new Set();
  const hrefRe = /href=["']([^"'#?]+)["']/gi;
  let m;
  while ((m = hrefRe.exec(html)) !== null) {
    try {
      const abs = new URL(m[1], baseUrl).href;
      if (abs.startsWith(origin) && !abs.match(/\.(pdf|jpg|jpeg|png|gif|svg|css|js|ico|zip|mp4|mp3|woff|woff2|ttf)(\?|$)/i)) {
        // Strip query and fragment, normalize trailing slash
        const clean = abs.split('?')[0].split('#')[0].replace(/\/$/, '') || abs.split('?')[0].split('#')[0];
        links.add(clean);
      }
    } catch {}
  }
  return Array.from(links);
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Crawls a site into the agent's knowledge base.
 *
 * budgetMs exists because the old loop could only stop on page count. A slow
 * site with a few 15-second timeouts ran past the function's own limit, the
 * process was killed, the catch in the caller never ran — and since the crawl
 * deletes the previous documents before it starts, the agent was left with
 * fewer documents than before and a spinner that never stopped.
 */
export async function crawlSite({ startUrl, agentId, maxPages = DEFAULT_MAX_PAGES, budgetMs = 240000 }) {
  const origin = new URL(startUrl).origin;
  const startNormalized = startUrl.split('?')[0].split('#')[0].replace(/\/$/, '') || startUrl;
  const deadline = Date.now() + budgetMs;

  const visited = new Set();
  const queued = new Set([startNormalized]);   // membership, so enqueueing stays O(1)
  const queue = [startNormalized];
  const pages = [];
  const errors = [];
  let stoppedEarly = false;
  let truncated = 0;

  // Delete old crawl docs for this URL
  await sql`
    DELETE FROM documents
    WHERE agent_id = ${agentId}
      AND source_url = ${startNormalized}
  `;

  while (queue.length > 0 && pages.length < maxPages) {
    if (Date.now() > deadline) { stoppedEarly = true; break; }
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const resp = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'AgentForge-Crawler/1.0',
          'Accept': 'text/html,application/xhtml+xml',
        },
      });
      clearTimeout(timeout);

      const contentType = resp.headers.get('content-type') || '';
      if (!contentType.includes('text/html')) continue;

      const html = await resp.text();
      const title = extractTitle(html) || url.replace(origin, '') || url;
      let content = extractTextFromHtml(html);

      if (content.length < 50) continue; // skip near-empty pages
      if (content.length > MAX_PAGE_CHARS) {
        content = content.slice(0, MAX_PAGE_CHARS) + '\n\n[…truncated]';
        truncated++;
      }

      pages.push({ url, title, content });

      // Insert document into DB. A crawled page is chunked like any other
      // document — a whole page is far too much to hand an agent as one hit.
      // It is not put through the model rewrite: a crawl can be a hundred
      // pages, and that would be a hundred model calls on the user's key.
      const docId = uid();
      const pageTitle = title.slice(0, 200);
      await sql`
        INSERT INTO documents (id, agent_id, skill_id, title, content, source_type, source_url)
        VALUES (${docId}, ${agentId}, NULL, ${pageTitle}, ${content}, 'crawl', ${startNormalized})
      `;
      await rechunk(docId, agentId, null, pageTitle, content);

      // Enqueue internal links
      const links = extractInternalLinks(html, url);
      for (const link of links) {
        if (!visited.has(link) && !queued.has(link)) {
          queued.add(link);
          queue.push(link);
        }
      }

      await sleep(CRAWL_DELAY_MS);
    } catch (err) {
      errors.push(`${url}: ${err.message}`);
    }
  }

  const totalChars = pages.reduce((s, p) => s + p.content.length, 0);
  // A page that renders its content with JavaScript comes back nearly empty
  // here: this crawler reads the HTML the server sends, it does not run scripts.
  // Saying so is better than the user wondering why the agent knows nothing.
  const thin = pages.filter(p => p.content.length < 200).length;
  return { pagesCrawled: pages.length, totalChars, errors, stoppedEarly, thinPages: thin, truncatedPages: truncated };
}
