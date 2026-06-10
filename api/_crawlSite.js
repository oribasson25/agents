import { sql } from './_db.js';

const CRAWL_DELAY_MS = 500;
const DEFAULT_MAX_PAGES = 100;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function extractTextFromHtml(html) {
  // Remove script, style, nav, footer, header content
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim();
  return text;
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

export async function crawlSite({ startUrl, agentId, maxPages = DEFAULT_MAX_PAGES }) {
  const origin = new URL(startUrl).origin;
  const startNormalized = startUrl.split('?')[0].split('#')[0].replace(/\/$/, '') || startUrl;

  const visited = new Set();
  const queue = [startNormalized];
  const pages = [];
  const errors = [];

  // Delete old crawl docs for this URL
  await sql`
    DELETE FROM documents
    WHERE agent_id = ${agentId}
      AND source_url = ${startNormalized}
  `;

  while (queue.length > 0 && pages.length < maxPages) {
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
      const content = extractTextFromHtml(html);

      if (content.length < 50) continue; // skip near-empty pages

      pages.push({ url, title, content });

      // Insert document into DB
      const docId = uid();
      await sql`
        INSERT INTO documents (id, agent_id, skill_id, title, content, source_type, source_url)
        VALUES (${docId}, ${agentId}, NULL, ${title.slice(0, 200)}, ${content}, 'crawl', ${startNormalized})
      `;

      // Enqueue internal links
      const links = extractInternalLinks(html, url);
      for (const link of links) {
        if (!visited.has(link) && !queue.includes(link)) {
          queue.push(link);
        }
      }

      await sleep(CRAWL_DELAY_MS);
    } catch (err) {
      errors.push(`${url}: ${err.message}`);
    }
  }

  const totalChars = pages.reduce((s, p) => s + p.content.length, 0);
  return { pagesCrawled: pages.length, totalChars, errors };
}
