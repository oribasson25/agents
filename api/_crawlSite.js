import { sql } from './_db.js';
import { rechunk } from './_knowledge.js';

/**
 * Crawls a site into an AI Chatbot's knowledge base.
 *
 * "Crawl this domain" has to mean the domain, not the one page the user typed.
 * Three things used to stop it at the front door, and each is handled below:
 * a redirect to www, a thin landing page, and every link with a `?` in it.
 */

const CONCURRENCY = 4;          // polite, and ~4× the pages per minute
const MIN_GAP_MS = 150;         // between request starts, unless robots asks for more
const DEFAULT_MAX_PAGES = 100;
const MAX_PAGES_CEILING = 500;
// One page of a registry or a price table can be hundreds of thousands of
// characters, which would become hundreds of chunk rows on its own and drown
// everything else in the knowledge base. Keep the top of it.
const MAX_PAGE_CHARS = 60000;
// A shop with filters offers the same page under endless combinations of
// query string. Crawl a few of them, not the Cartesian product.
const MAX_QUERY_VARIANTS_PER_PATH = 8;

const UA = 'Mozilla/5.0 (compatible; 8LegsBot/1.0; +https://8legs.ai)';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/* ─────────────────── the URL rules ─────────────────── */

const SKIP_EXT = /\.(pdf|docx?|xlsx?|pptx?|csv|rtf|jpe?g|png|gif|svg|webp|avif|ico|bmp|tiff?|css|js|mjs|json|xml|rss|atom|zip|gz|tar|rar|7z|dmg|exe|mp[34]|m4[av]|wav|ogg|webm|mov|avi|woff2?|ttf|eot|otf)$/i;

// Links that exist on every page of a CMS and never carry knowledge.
const SKIP_PATH = /\/(wp-admin|wp-login|wp-json|xmlrpc\.php|cdn-cgi|feed|comments\/feed|cart|checkout|my-account|wishlist|add-to-cart)(\/|$)/i;

const TRACKING_PARAM = /^(utm_|_ga|_gl)|^(fbclid|gclid|gbraid|wbraid|msclkid|yclid|igshid|mc_cid|mc_eid|ref|ref_src|source|si|spm)$/i;

/**
 * One spelling per page, so the same page is not crawled twice and stored twice.
 *
 * The query string is kept — `?page=2` and `?id=7` are how a great many sites
 * expose the rest of themselves — minus the tracking parameters that make the
 * same page look like a hundred different ones.
 */
export function normalizeUrl(input, base) {
  let u;
  try { u = new URL(input, base); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  u.hash = '';
  u.username = '';
  u.password = '';
  u.hostname = u.hostname.toLowerCase();

  const kept = [...u.searchParams.entries()]
    .filter(([k]) => k && !TRACKING_PARAM.test(k))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  u.search = '';
  for (const [k, v] of kept) u.searchParams.append(k, v);

  u.pathname = u.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return u.href;
}

/** `example.com` and `www.example.com` are the same site, whatever the user typed. */
export function siteKey(host) {
  return String(host || '').toLowerCase().replace(/^www\./, '');
}

export function sameSite(url, homeKey) {
  try { return siteKey(new URL(url).hostname) === homeKey; } catch { return false; }
}

export function crawlable(url, homeKey) {
  if (!url || !sameSite(url, homeKey)) return false;
  let path;
  try { path = new URL(url).pathname; } catch { return false; }
  if (SKIP_EXT.test(path)) return false;
  if (SKIP_PATH.test(path)) return false;
  return true;
}

/**
 * Every href on the page, not only the ones without a `?`.
 *
 * The old pattern was `href=["']([^"'#?]+)["']`, which threw away any link
 * carrying a query string or a fragment. On one shop's home page that was
 * thirteen real pages the crawl could never reach.
 */
export function extractInternalLinks(html, baseUrl, homeKey) {
  const links = new Set();
  for (const m of html.matchAll(/<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!raw || raw.startsWith('#') || /^(mailto:|tel:|javascript:|data:)/i.test(raw)) continue;
    const abs = normalizeUrl(decodeEntities(raw), baseUrl);
    if (abs && crawlable(abs, homeKey)) links.add(abs);
  }
  return [...links];
}

/* ─────────────────── robots and sitemaps ─────────────────── */

/**
 * Enough of robots.txt to be a good guest: the rules for `*` (or for us by
 * name), longest match wins, plus any Sitemap it advertises. Sites disallow
 * their search and cart pages, which is exactly what we did not want anyway.
 */
export function parseRobots(text) {
  const sitemaps = [];
  const wildcard = { rules: [], crawlDelay: 0 };
  const ours = { rules: [], crawlDelay: 0, found: false };
  let group = null;          // the group the lines being read belong to
  let startingGroup = false; // consecutive User-agent lines share one group

  for (const line of String(text || '').split('\n')) {
    const clean = line.replace(/#.*$/, '').trim();
    if (!clean) continue;
    const i = clean.indexOf(':');
    if (i < 0) continue;
    const field = clean.slice(0, i).trim().toLowerCase();
    const value = clean.slice(i + 1).trim();

    if (field === 'sitemap') { sitemaps.push(value); continue; }

    if (field === 'user-agent') {
      const ua = value.toLowerCase();
      if (!startingGroup) { group = null; startingGroup = true; }
      if (ua.includes('8legsbot')) { ours.found = true; group = ours; }
      else if (ua === '*' && group !== ours) group = wildcard;
      continue;
    }
    startingGroup = false;
    if (!group) continue;
    if (field === 'disallow' || field === 'allow') group.rules.push({ allow: field === 'allow', path: value });
    if (field === 'crawl-delay') group.crawlDelay = Math.min(Number(value) * 1000 || 0, 5000);
  }
  // A group that names us replaces the wildcard group rather than adding to it.
  const chosen = ours.found ? ours : wildcard;
  return { rules: chosen.rules, sitemaps, crawlDelay: chosen.crawlDelay };
}

export function robotsAllows(rules, pathname) {
  let best = null;
  for (const r of rules) {
    if (r.path === '') continue;                    // `Disallow:` empty means allow all
    const pattern = r.path.replace(/\*+/g, '*');
    if (!matchRobotsPath(pattern, pathname)) continue;
    if (!best || pattern.length > best.pattern.length) best = { ...r, pattern };
  }
  return best ? best.allow : true;
}

function matchRobotsPath(pattern, pathname) {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const rx = new RegExp(
    '^' + body.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (anchored ? '$' : ''),
  );
  return rx.test(pathname);
}

/** `<loc>` entries, following one level of sitemap index. */
export function parseSitemap(xml) {
  const locs = [...String(xml || '').matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)]
    .map(m => decodeEntities(m[1].trim()))
    .filter(Boolean);
  return { isIndex: /<sitemapindex/i.test(xml || ''), locs };
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&');   // last, so &amp;lt; does not become <
}

/* ─────────────────── fetching ─────────────────── */

/**
 * Text, in the encoding the page is actually in.
 *
 * `resp.text()` always decodes as UTF-8. A Hebrew site served as
 * windows-1255 — and plenty still are — came back as mojibake, which is
 * unreadable to the model and unsearchable in the knowledge base.
 */
export function decodeBody(buffer, contentType) {
  const head = Buffer.from(buffer.slice(0, 2048)).toString('latin1');
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType || '');
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)
                || /charset=["']?([\w-]+)/i.exec(/<meta[^>]+content=["'][^"']*charset[^"']*["']/i.exec(head)?.[0] || '');
  let charset = (fromHeader?.[1] || fromMeta?.[1] || 'utf-8').toLowerCase();
  if (charset === 'iso-8859-8-i') charset = 'iso-8859-8';
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buffer);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  }
}

async function get(url, { timeoutMs = 15000, accept = 'text/html,application/xhtml+xml' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'he,en;q=0.9' },
    });
    const buffer = await resp.arrayBuffer();
    return {
      ok: resp.ok,
      status: resp.status,
      finalUrl: resp.url || url,
      contentType: resp.headers.get('content-type') || '',
      body: decodeBody(buffer, resp.headers.get('content-type')),
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ─────────────────── HTML to text ─────────────────── */

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
export function extractTextFromHtml(html) {
  let text = html
    // Chrome, furniture and anything with no readable text in it.
    .replace(/<(script|style|noscript|svg|iframe|select|button|template)[\s\S]*?<\/\1>/gi, ' ')
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
  text = decodeEntities(text);

  return text
    .split('\n')
    .map(line => line.replace(/[ \t ]{2,}/g, ' ').trim())
    // A stripped-out link leaves its bullet behind; a page of nav links would
    // otherwise arrive as a column of bare dashes.
    .filter(line => line !== '-' && line !== '#' && !/^#{2,6}\s*$/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')     // at most one blank line between blocks
    .trim();
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (m) return decodeEntities(m[1].replace(/<[^>]+>/g, '')).trim();
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return decodeEntities(h1[1].replace(/<[^>]+>/g, '')).trim();
  return '';
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ─────────────────── the crawl ─────────────────── */

/**
 * budgetMs exists because the old loop could only stop on page count. A slow
 * site with a few 15-second timeouts ran past the function's own limit, the
 * process was killed, the catch in the caller never ran — and since the crawl
 * deletes the previous documents before it starts, the agent was left with
 * fewer documents than before and a spinner that never stopped.
 */
export async function crawlSite({ startUrl, agentId, maxPages = DEFAULT_MAX_PAGES, budgetMs = 240000, onProgress }) {
  const limit = Math.min(Math.max(parseInt(maxPages, 10) || DEFAULT_MAX_PAGES, 1), MAX_PAGES_CEILING);
  const deadline = Date.now() + budgetMs;
  // The key the documents are filed under stays the URL the user typed, so
  // re-crawling and removing a URL still find what the last crawl wrote.
  const startNormalized = startUrl.split('?')[0].split('#')[0].replace(/\/$/, '') || startUrl;

  const errors = [];
  let stoppedEarly = false, truncated = 0, thin = 0, blocked = 0;
  let stored = 0, totalChars = 0;

  /* Where the site actually lives. A redirect from example.com to
     www.example.com used to end the crawl on page one: every link on the page
     pointed at the host we had not asked for, and the origin test threw them
     all away. */
  let home;
  try {
    home = await get(startUrl);
  } catch (err) {
    return { pagesCrawled: 0, totalChars: 0, errors: [`${startUrl}: ${err.message}`], stoppedEarly: false, thinPages: 0, truncatedPages: 0, pagesFound: 0, failed: true };
  }
  if (!home.ok) {
    return { pagesCrawled: 0, totalChars: 0, errors: [`${startUrl}: HTTP ${home.status}`], stoppedEarly: false, thinPages: 0, truncatedPages: 0, pagesFound: 0, failed: true };
  }
  const homeUrl = normalizeUrl(home.finalUrl) || startNormalized;
  const homeKey = siteKey(new URL(homeUrl).hostname);
  const origin = new URL(homeUrl).origin;

  /* robots.txt: the rules, and the sitemaps it points at. */
  let rules = [], gap = MIN_GAP_MS;
  const sitemapUrls = [];
  try {
    const robots = await get(`${origin}/robots.txt`, { timeoutMs: 8000, accept: 'text/plain' });
    if (robots.ok) {
      const parsed = parseRobots(robots.body);
      rules = parsed.rules;
      gap = Math.max(MIN_GAP_MS, parsed.crawlDelay);
      sitemapUrls.push(...parsed.sitemaps);
    }
  } catch {}
  if (!sitemapUrls.length) sitemapUrls.push(`${origin}/sitemap.xml`);

  const seen = new Set();
  // What the site links to comes first; the sitemap is the reserve behind it.
  // A sitemap can hold thousands of entries, and if they all queued ahead of
  // the home page's own links a short crawl would come back with the blog
  // archive and none of the pages the navigation actually points at.
  const queue = [];
  const reserve = [];
  const variantsPerPath = new Map();

  function enqueue(url, { reserved = false } = {}) {
    if (!url || seen.has(url) || seen.size > limit * 20) return false;
    if (!crawlable(url, homeKey)) return false;
    let u;
    try { u = new URL(url); } catch { return false; }
    if (!robotsAllows(rules, u.pathname + u.search)) { blocked++; return false; }
    if (u.search) {
      const n = variantsPerPath.get(u.pathname) || 0;
      if (n >= MAX_QUERY_VARIANTS_PER_PATH) return false;
      variantsPerPath.set(u.pathname, n + 1);
    }
    seen.add(url);
    (reserved ? reserve : queue).push(url);
    return true;
  }

  const nextUrl = () => (queue.length ? queue.shift() : reserve.shift());
  const waiting = () => queue.length + reserve.length;

  enqueue(homeUrl);

  /* The sitemap is the only way to reach a page nothing links to, which is
     most of what "the whole domain" means on a large site. */
  let fromSitemap = 0;
  for (const sm of sitemapUrls.slice(0, 5)) {
    if (Date.now() > deadline || seen.size >= limit * 5) break;
    try {
      const doc = await get(sm, { timeoutMs: 10000, accept: 'application/xml,text/xml' });
      if (!doc.ok) continue;
      const { isIndex, locs } = parseSitemap(doc.body);
      if (isIndex) {
        for (const child of locs.slice(0, 20)) {
          if (Date.now() > deadline || seen.size >= limit * 5) break;
          try {
            const sub = await get(child, { timeoutMs: 10000, accept: 'application/xml,text/xml' });
            if (!sub.ok) continue;
            for (const loc of parseSitemap(sub.body).locs) {
              if (enqueue(normalizeUrl(loc), { reserved: true })) fromSitemap++;
            }
          } catch {}
        }
      } else {
        for (const loc of locs) if (enqueue(normalizeUrl(loc), { reserved: true })) fromSitemap++;
      }
    } catch {}
  }

  /* The previous crawl's documents are deleted only once this one has a page
     to put in their place. A site that is down for the afternoon must not
     empty the knowledge base. */
  let clearing = null;
  function clearOld() {
    // One promise, awaited by every worker. Setting a flag and moving on would
    // let a second worker's INSERT land before the DELETE ran, and the delete
    // would take the row it had just written.
    if (!clearing) {
      clearing = sql`DELETE FROM documents WHERE agent_id = ${agentId} AND source_url = ${startNormalized}`;
    }
    return clearing;
  }

  const fetchedFinal = new Set();   // two URLs can redirect to the same page
  let fetched = 0, active = 0, lastStart = 0;

  async function visit(url, prefetched) {
    const page = prefetched || await get(url);
    const finalNorm = normalizeUrl(page.finalUrl) || url;

    // A redirect can land somewhere already crawled, or off the site entirely.
    if (fetchedFinal.has(finalNorm)) return;
    fetchedFinal.add(finalNorm);
    if (!sameSite(finalNorm, homeKey)) return;

    if (!page.ok) { errors.push(`${url}: HTTP ${page.status}`); return; }
    const isHtml = page.contentType
      ? /text\/html|application\/xhtml/i.test(page.contentType)
      : /<html|<!doctype html/i.test(page.body.slice(0, 500));
    if (!isHtml) return;

    /* Links first, always.
       This used to sit below the `content.length < 50` guard, so a splash
       page or a JavaScript shell — which is what a great many home pages are —
       was skipped before anything was read off it, and the crawl ended on the
       page it started on. */
    for (const link of extractInternalLinks(page.body, finalNorm, homeKey)) enqueue(link);

    const title = extractTitle(page.body) || finalNorm.replace(origin, '') || finalNorm;
    let content = extractTextFromHtml(page.body);
    if (content.length < 200) thin++;
    if (content.length < 50) return;                 // nothing worth storing
    if (content.length > MAX_PAGE_CHARS) {
      content = content.slice(0, MAX_PAGE_CHARS) + '\n\n[…truncated]';
      truncated++;
    }

    await clearOld();

    // A crawled page is chunked like any other document — a whole page is far
    // too much to hand an agent as one hit. It is not put through the model
    // rewrite: a crawl can be a hundred pages, and that would be a hundred
    // model calls on the user's key.
    const docId = uid();
    const pageTitle = title.slice(0, 200);
    await sql`
      INSERT INTO documents (id, agent_id, skill_id, title, content, source_type, source_url)
      VALUES (${docId}, ${agentId}, NULL, ${pageTitle}, ${content}, 'crawl', ${startNormalized})
    `;
    await rechunk(docId, agentId, null, pageTitle, content);
    stored++;
    totalChars += content.length;
    if (onProgress && stored % 10 === 0) {
      try { await onProgress({ pagesCrawled: stored, pagesFound: seen.size }); } catch {}
    }
  }

  async function worker() {
    while (true) {
      if (Date.now() > deadline) { stoppedEarly = true; return; }
      if (fetched >= limit) { if (waiting()) stoppedEarly = true; return; }
      const url = nextUrl();
      if (url === undefined) {
        if (active === 0) return;         // nothing queued and no peer can add more
        await sleep(60);
        continue;
      }
      // Claimed before the wait below: four workers that all counted after
      // sleeping would each slip one more page past the limit.
      fetched++;
      active++;
      const wait = lastStart + gap - Date.now();
      lastStart = Date.now() + Math.max(wait, 0);
      if (wait > 0) await sleep(wait);
      try {
        await visit(url, url === homeUrl ? home : null);
      } catch (err) {
        errors.push(`${url}: ${err.message}`);
      } finally {
        active--;
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // A page that renders its content with JavaScript comes back nearly empty
  // here: this crawler reads the HTML the server sends, it does not run scripts.
  // Saying so is better than the user wondering why the agent knows nothing.
  return {
    pagesCrawled: stored,
    pagesFound: seen.size,
    fromSitemap,
    totalChars,
    errors: errors.slice(0, 20),
    stoppedEarly,
    thinPages: thin,
    truncatedPages: truncated,
    blockedByRobots: blocked,
    homeUrl,
  };
}
