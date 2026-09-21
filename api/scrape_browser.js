/**
 * Browser-based scraper using Playwright + @sparticuz/chromium.
 * Renders JavaScript before extracting content — handles SPAs and dynamic sites.
 *
 * POST { "url": "https://..." }  →  { url, title, text, error? }
 * GET  ?url=https://...          →  same
 */

const chromium = require('@sparticuz/chromium');
const { chromium: playwright } = require('playwright-core');

/**
 * Blocks a URL that points at the machine itself or a private network.
 *
 * A literal check, not a DNS resolution: it stops the direct case the audit
 * flagged (a caller aiming the server at 169.254.x metadata or an internal
 * host) without the risk of breaking a legitimate public crawl on a resolver
 * edge case. A hostname that *resolves* to a private address is not caught
 * here — that residual is noted in the security report.
 */
function pointsInward(rawUrl) {
  let h;
  try { h = new URL(rawUrl).hostname.toLowerCase(); } catch { return true; }
  if (h === 'localhost' || h.endsWith('.localhost') || h === 'metadata.google.internal') return true;
  if (h === '::1' || h.startsWith('fd') || h.startsWith('fe80')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const p = h.split('.').map(Number);
    if (p[0] === 127 || p[0] === 10 || p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;      // link-local / cloud metadata
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  }
  return false;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();

  /* Was open to the whole internet with CORS `*`, which let anyone use the
     server as a fetch proxy. The browser calls this same-origin with its
     session token; the agent runner calls it with the internal secret. */
  const { checkInternalOrAuth } = await import('./_auth.js');
  if (!checkInternalOrAuth(req, res)) return;

  let url = (req.method === 'POST' ? req.body?.url : req.query?.url) || '';
  url = url.trim();
  if (!url) return res.json({ error: 'url is required' });
  if (!url.startsWith('http')) url = 'https://' + url;
  if (pointsInward(url)) return res.status(400).json({ error: 'That address is not allowed.' });

  let browser;
  try {
    browser = await playwright.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'he,en-US,en;q=0.9' });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });

    // Give JS time to render
    await page.waitForTimeout(2500);

    const title = await page.title();

    const text = await page.evaluate(() => {
      // Remove noise elements
      ['script', 'style', 'noscript', 'nav', 'footer', 'header', 'aside', 'iframe']
        .forEach(tag => document.querySelectorAll(tag).forEach(el => el.remove()));
      return (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    });

    res.json({ url, title, text: text.slice(0, 8000) });
  } catch (err) {
    res.json({ error: err.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
};
