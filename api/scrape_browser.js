/**
 * Browser-based scraper using Playwright + @sparticuz/chromium.
 * Renders JavaScript before extracting content — handles SPAs and dynamic sites.
 *
 * POST { "url": "https://..." }  →  { url, title, text, error? }
 * GET  ?url=https://...          →  same
 */

const chromium = require('@sparticuz/chromium');
const { chromium: playwright } = require('playwright-core');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  let url = (req.method === 'POST' ? req.body?.url : req.query?.url) || '';
  url = url.trim();
  if (!url) return res.json({ error: 'url is required' });
  if (!url.startsWith('http')) url = 'https://' + url;

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
