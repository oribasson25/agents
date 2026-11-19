/**
 * Browser-based scraper using Playwright + @sparticuz/chromium.
 * Renders JavaScript before extracting content — handles SPAs and dynamic sites.
 *
 * POST { "url": "https://..." }  →  { url, title, text, error? }
 * GET  ?url=https://...          →  same
 */
import chromium from '@sparticuz/chromium';
import { chromium as playwright } from 'playwright-core';
import { checkInternalOrAuth } from './_auth.js';
import { checkPublicUrl, safeFetch } from './_netGuard.js';

const INSIDE = 'That address is inside the platform\'s network and cannot be read.';

/**
 * Whether the browser may load `url`, decided by the same check every other
 * outbound fetch uses (_netGuard.js): the name is resolved and every address
 * must be public. One verdict per host, so a page with a hundred images does
 * not cost a hundred lookups.
 */
function makeGate() {
  const verdicts = new Map();
  const pending = [];
  let firstRefused = null;
  const allowed = (url) => {
    let parsed;
    try { parsed = new URL(url); } catch { return Promise.resolve(false); }
    if (parsed.protocol === 'data:' || parsed.protocol === 'blob:' || parsed.protocol === 'about:') return Promise.resolve(true);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return Promise.resolve(false);
    const key = `${parsed.protocol}//${parsed.host}`;
    if (!verdicts.has(key)) verdicts.set(key, checkPublicUrl(url).then(() => true, () => false));
    return verdicts.get(key);
  };
  return {
    allowed,
    /* Every request the page makes — redirect hops included, which a route
       handler is not shown — is checked; one that went inside spoils the
       answer even if Chromium already followed it. */
    watch(url) {
      const p = allowed(url).then(ok => { if (!ok && !firstRefused) firstRefused = url; });
      pending.push(p);
    },
    refuse(url) { if (!firstRefused) firstRefused = url; },
    async refused() { await Promise.all(pending); return firstRefused; },
  };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  /* Was open to the whole internet with CORS `*`, which let anyone use the
     server as a fetch proxy. The browser calls this same-origin with its
     session token; the agent runner calls it with the internal secret. */
  if (!(await checkInternalOrAuth(req, res))) return;

  let url = String((req.method === 'POST' ? req.body?.url : req.query?.url) || '');
  url = url.trim();
  if (!url) return res.json({ error: 'url is required' });
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try {
    await checkPublicUrl(url);
  } catch (err) {
    return res.status(400).json({ error: err.message || 'That address is not allowed.' });
  }

  const gate = makeGate();
  let browser;
  try {
    browser = await playwright.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'he,en-US,en;q=0.9' });
    /* Chromium never opens a connection of its own: every http(s) request
       the page makes is fetched here through safeFetch (checked, pinned to
       the checked address) and handed back. Otherwise Chromium resolves the
       name again after our check (DNS rebinding), and a redirect hop is not
       shown to a route handler at all. Redirects go back to the page as they
       are, so the next hop comes through here and is checked too. Images,
       media and fonts are not needed to read a page's text. */
    await page.route('**/*', async (route) => {
      const request = route.request();
      const target = request.url();
      let parsed;
      try { parsed = new URL(target); } catch { return route.abort('blockedbyclient'); }
      if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') return route.continue();
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') { gate.refuse(target); return route.abort('blockedbyclient'); }
      if (['image', 'media', 'font'].includes(request.resourceType())) return route.abort('blockedbyclient');
      try {
        const sent = { ...request.headers() };
        for (const k of ['host', 'content-length', 'accept-encoding', 'connection']) delete sent[k];
        const answer = await safeFetch(target, {
          method: request.method(), headers: sent, body: request.postDataBuffer() || undefined,
          redirect: 'manual', timeoutMs: 15000, maxBytes: 5 * 1048576, truncate: true,
        });
        const headers = {};
        answer.headers.forEach((v, k) => { if (k !== 'set-cookie') headers[k] = v; });
        return route.fulfill({ status: answer.status, headers, body: Buffer.from(await answer.arrayBuffer()) });
      } catch (err) {
        if (/inside the platform|user name or password|Only http/.test(String(err && err.message))) gate.refuse(target);
        return route.abort('failed');
      }
    });
    /* Nor through a WebSocket, which a route handler does not see. */
    if (typeof page.routeWebSocket === 'function') await page.routeWebSocket(/.*/, (ws) => ws.close());
    page.on('request', (request) => gate.watch(request.url()));

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });

    // Give JS time to render
    await page.waitForTimeout(2500);

    if (await gate.refused() || !(await gate.allowed(page.url()))) {
      return res.status(400).json({ error: INSIDE });
    }

    const title = await page.title();

    const text = await page.evaluate(() => {
      // Remove noise elements
      ['script', 'style', 'noscript', 'nav', 'footer', 'header', 'aside', 'iframe']
        .forEach(tag => document.querySelectorAll(tag).forEach(el => el.remove()));
      return (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    });

    if (await gate.refused()) return res.status(400).json({ error: INSIDE });
    res.json({ url, title, text: text.slice(0, 8000) });
  } catch (err) {
    if (await gate.refused()) return res.status(400).json({ error: INSIDE });
    res.json({ error: err.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
