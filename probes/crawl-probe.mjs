/**
 * The crawler, and what "crawl this domain" has to mean.
 *
 * The three failures this holds the line on are the ones that used to end a
 * crawl on its first page: a redirect to www, a thin landing page, and every
 * link carrying a query string. Plus the ones that quietly spoiled the
 * knowledge base: error pages stored as documents, a dead site wiping what the
 * last crawl found, and a Hebrew page decoded as the wrong character set.
 */
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

let failed = 0;
const ok = (cond, label, detail = '') => {
  if (cond) console.log(`✓ ${label}`);
  else { console.log(`✗ ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
};

/* ── the database this crawl writes into ── */
const docs = [];
globalThis.__db = (text, params) => {
  const q = text.replace(/\s+/g, ' ').trim().toLowerCase();
  if (q.startsWith('delete from documents where agent_id')) {
    const [agentId, sourceUrl] = params;
    for (let i = docs.length - 1; i >= 0; i--) {
      if (docs[i].agent_id === agentId && docs[i].source_url === sourceUrl) docs.splice(i, 1);
    }
    return [];
  }
  if (q.startsWith('delete from documents where parent_id')) return [];
  // The chunk rows carry 'chunk' in the SQL text, the page rows carry 'crawl'.
  if (q.startsWith('insert into documents') && q.includes("'crawl'")) {
    const [id, agent_id, title, content, source_url] = params;
    docs.push({ id, agent_id, title, content, source_type: 'crawl', source_url });
  }
  if (q.startsWith('insert into documents')) return [];
  return [];
};

/* ── the site this crawl reads ── */
let site = {};
const hits = [];
globalThis.fetch = async (url) => {
  hits.push(url);
  const page = site[url];
  if (!page) return reply(url, 404, 'text/html', '<html><body><h1>Not found</h1><p>No such page here at all.</p></body></html>');
  if (page.redirect) return reply(page.redirect, 200, 'text/html', site[page.redirect]?.html ?? '', url);
  return reply(url, page.status ?? 200, page.type ?? 'text/html; charset=utf-8', page.html ?? '', null, page.bytes);
};
function reply(finalUrl, status, type, html, _from, bytes) {
  const body = bytes || Buffer.from(html, 'utf8');
  return {
    ok: status >= 200 && status < 300,
    status, url: finalUrl,
    headers: { get: k => (k.toLowerCase() === 'content-type' ? type : null) },
    arrayBuffer: async () => body,
  };
}

const C = await import(`${ROOT}/api/_crawlSite.js`);
const crawl = (startUrl, opts = {}) =>
  C.crawlSite({ startUrl, agentId: 'a-1', maxPages: 50, budgetMs: 20000, ...opts });

/* ─────────── the URL rules ─────────── */
ok(C.normalizeUrl('https://EX.com/a/b/?utm_source=x&page=2#top') === 'https://ex.com/a/b?page=2',
   'a URL has one spelling: no fragment, no tracking, no trailing slash',
   C.normalizeUrl('https://EX.com/a/b/?utm_source=x&page=2#top'));
ok(C.siteKey('www.example.com') === C.siteKey('example.com'), 'www and the bare domain are one site');
ok(C.crawlable('https://ex.com/a.pdf', 'ex.com') === false, 'a PDF is not a page to crawl');
ok(C.crawlable('https://other.com/a', 'ex.com') === false, 'another domain is not this domain');

const hrefs = C.extractInternalLinks(
  `<a href="/a">a</a><a href='/b?page=2'>b</a><a href="/c#sec">c</a>
   <a href=/d>d</a><a href="mailto:x@y.z">m</a><a href="https://off.site/x">o</a>
   <a href="/e.jpg">img</a>`,
  'https://ex.com/', 'ex.com');
ok(hrefs.includes('https://ex.com/b?page=2'), 'a link with a query string is followed', hrefs.join(' '));
ok(hrefs.includes('https://ex.com/c'), 'a link with a fragment is followed, once');
ok(hrefs.includes('https://ex.com/d'), 'an unquoted href is followed');
ok(!hrefs.some(h => /mailto|off\.site|\.jpg/.test(h)), 'mail, other sites and images are not', hrefs.join(' '));

/* ─────────── the bug that started this: a redirect to www ─────────── */
const page = (title, body) => ({ html: `<html><head><title>${title}</title></head><body>${body}</body></html>` });
const filler = 'This paragraph exists so the page has enough text to be worth storing in the knowledge base. '.repeat(3);

site = {
  'https://ex.com': { redirect: 'https://www.ex.com' },
  'https://www.ex.com': page('Home', `<p>${filler}</p>
      <a href="https://www.ex.com/about">About</a>
      <a href="https://www.ex.com/pricing">Pricing</a>
      <a href="/contact">Contact</a>`),
  'https://www.ex.com/about': page('About', `<p>${filler}</p>`),
  'https://www.ex.com/pricing': page('Pricing', `<p>${filler}</p>`),
  'https://www.ex.com/contact': page('Contact', `<p>${filler}</p>`),
  'https://www.ex.com/robots.txt': { status: 404, type: 'text/plain' },
  'https://www.ex.com/sitemap.xml': { status: 404, type: 'application/xml' },
};
docs.length = 0;
let r = await crawl('https://ex.com');
ok(r.pagesCrawled === 4, 'a redirect to www does not end the crawl on page one', `crawled ${r.pagesCrawled}`);
ok(docs.every(d => d.source_url === 'https://ex.com'),
   'the documents stay filed under the URL the user typed', docs[0]?.source_url);

/* ─────────── a thin landing page still yields its links ─────────── */
site = {
  'https://thin.com': page('Splash', '<a href="/real">Enter</a>'),   // almost no text
  'https://thin.com/real': page('Real', `<p>${filler}</p>`),
  'https://thin.com/robots.txt': { status: 404, type: 'text/plain' },
  'https://thin.com/sitemap.xml': { status: 404, type: 'application/xml' },
};
docs.length = 0;
r = await crawl('https://thin.com');
ok(r.pagesCrawled === 1 && docs[0].title === 'Real',
   'a splash page with no text is still read for its links', `crawled ${r.pagesCrawled}`);

/* ─────────── the sitemap reaches what nothing links to ─────────── */
site = {
  'https://sm.com': page('Home', `<p>${filler}</p>`),          // links to nothing
  'https://sm.com/robots.txt': { type: 'text/plain', html: 'User-agent: *\nDisallow: /private\nSitemap: https://sm.com/sitemap.xml' },
  'https://sm.com/sitemap.xml': { type: 'application/xml', html:
    `<urlset><url><loc>https://sm.com/orphan-1</loc></url><url><loc>https://sm.com/orphan-2</loc></url>
     <url><loc>https://sm.com/private/secret</loc></url></urlset>` },
  'https://sm.com/orphan-1': page('Orphan one', `<p>${filler}</p>`),
  'https://sm.com/orphan-2': page('Orphan two', `<p>${filler}</p>`),
  'https://sm.com/private/secret': page('Secret', `<p>${filler}</p>`),
};
docs.length = 0;
r = await crawl('https://sm.com');
const titles = docs.map(d => d.title).sort();
ok(titles.includes('Orphan one') && titles.includes('Orphan two'),
   'the sitemap reaches pages nothing on the site links to', titles.join(', '));
ok(!titles.includes('Secret'), 'and robots.txt is obeyed on the way', titles.join(', '));
ok(!hits.includes('https://sm.com/private/secret'), 'a disallowed page is never even fetched');

/* ─────────── an error page is not knowledge ─────────── */
site = {
  'https://err.com': page('Home', `<p>${filler}</p><a href="/gone">Gone</a>`),
  'https://err.com/gone': { status: 500, html: `<html><title>Server error</title><body><p>${filler}</p></body></html>` },
  'https://err.com/robots.txt': { status: 404, type: 'text/plain' },
  'https://err.com/sitemap.xml': { status: 404, type: 'application/xml' },
};
docs.length = 0;
r = await crawl('https://err.com');
ok(docs.length === 1 && docs[0].title === 'Home', 'a 500 page is not stored as knowledge', docs.map(d => d.title).join(', '));
ok(r.errors.some(e => e.includes('500')), 'and it is reported', r.errors.join('; '));

/* ─────────── a dead site does not empty the knowledge base ─────────── */
docs.push({ id: 'old', agent_id: 'a-1', title: 'From the last crawl', content: 'x', source_type: 'crawl', source_url: 'https://dead.com' });
site = { 'https://dead.com': { status: 503 } };
r = await crawl('https://dead.com');
ok(docs.some(d => d.id === 'old'),
   'a site that is down leaves the last crawl in place rather than wiping it', `${docs.length} docs left`);
ok(r.failed === true && r.pagesCrawled === 0, 'and the crawl says it failed');

/* ─────────── two URLs, one page ─────────── */
site = {
  'https://dup.com': page('Home', `<p>${filler}</p><a href="/a">a</a><a href="/b">b</a>`),
  'https://dup.com/a': { redirect: 'https://dup.com/same' },
  'https://dup.com/b': { redirect: 'https://dup.com/same' },
  'https://dup.com/same': page('Same page', `<p>${filler}</p>`),
  'https://dup.com/robots.txt': { status: 404, type: 'text/plain' },
  'https://dup.com/sitemap.xml': { status: 404, type: 'application/xml' },
};
docs.length = 0;
await crawl('https://dup.com');
ok(docs.filter(d => d.title === 'Same page').length === 1,
   'two links that redirect to the same page store it once', `${docs.filter(d => d.title === 'Same page').length} copies`);

/* ─────────── Hebrew in the encoding the page is actually in ─────────── */
const hebrew = 'שלום, זהו דף בעברית עם מספיק טקסט כדי שיישמר במאגר הידע של הצאטבוט הזה בהחלט.';
const win1255 = Buffer.from([...hebrew].map(ch => {
  const c = ch.codePointAt(0);
  return c >= 0x05d0 && c <= 0x05ea ? c - 0x05d0 + 0xe0 : (c < 128 ? c : 32);
}));
site = {
  'https://heb.com': {
    type: 'text/html; charset=windows-1255',
    bytes: Buffer.concat([Buffer.from('<html><head><title>x</title></head><body><p>', 'latin1'), win1255, Buffer.from('</p></body></html>', 'latin1')]),
  },
  'https://heb.com/robots.txt': { status: 404, type: 'text/plain' },
  'https://heb.com/sitemap.xml': { status: 404, type: 'application/xml' },
};
docs.length = 0;
await crawl('https://heb.com');
ok(docs[0] && docs[0].content.includes('עברית'),
   'a Hebrew page served as windows-1255 is stored as Hebrew, not mojibake', docs[0]?.content.slice(0, 40));

/* ─────────── robots groups ─────────── */
const robots = C.parseRobots(`
User-agent: *
Disallow: /
Crawl-delay: 9

User-agent: 8LegsBot
Disallow: /private
Allow: /private/public
Crawl-delay: 1

Sitemap: https://x.com/sitemap.xml
`);
ok(robots.rules.length === 2, 'a group naming us replaces the wildcard group, it does not add to it', JSON.stringify(robots.rules));
ok(C.robotsAllows(robots.rules, '/anything') === true, 'so the wildcard "Disallow: /" no longer applies to us');
ok(C.robotsAllows(robots.rules, '/private/x') === false, 'our own Disallow does');
ok(C.robotsAllows(robots.rules, '/private/public/x') === true, 'and the longer Allow wins over the shorter Disallow');
ok(robots.crawlDelay === 1000 && robots.sitemaps.length === 1, 'the delay and the sitemap come from the right group', JSON.stringify(robots));

const wild = C.parseRobots('User-agent: *\nUser-agent: Googlebot\nDisallow: /x');
ok(C.robotsAllows(wild.rules, '/x') === false, 'consecutive User-agent lines share one group');

/* ─────────── the last crawl is cleared once, not per page ─────────── */
let deletes = 0;
const realDb = globalThis.__db;
globalThis.__db = (text, params) => {
  if (text.replace(/\s+/g, ' ').trim().toLowerCase().startsWith('delete from documents where agent_id')) deletes++;
  return realDb(text, params);
};
site = {
  'https://once.com': page('Home', `<p>${filler}</p>` + Array.from({ length: 8 }, (_, i) => `<a href="/p${i}">p</a>`).join('')),
  'https://once.com/robots.txt': { status: 404, type: 'text/plain' },
  'https://once.com/sitemap.xml': { status: 404, type: 'application/xml' },
};
for (let i = 0; i < 8; i++) site[`https://once.com/p${i}`] = page(`Page ${i}`, `<p>${filler}</p>`);
docs.length = 0;
await crawl('https://once.com');
globalThis.__db = realDb;
ok(deletes === 1, 'nine pages, one delete of what the last crawl left', `${deletes} deletes`);
ok(docs.length === 9, 'and all nine survive it', `${docs.length} stored`);

/* ─────────── the limits hold ─────────── */
const many = { 'https://big.com/robots.txt': { status: 404, type: 'text/plain' },
               'https://big.com/sitemap.xml': { status: 404, type: 'application/xml' } };
many['https://big.com'] = page('Home', `<p>${filler}</p>` + Array.from({ length: 60 }, (_, i) => `<a href="/p${i}">p${i}</a>`).join(''));
for (let i = 0; i < 60; i++) many[`https://big.com/p${i}`] = page(`Page ${i}`, `<p>${filler}</p>`);
site = many;
docs.length = 0;
r = await crawl('https://big.com', { maxPages: 10 });
ok(docs.length <= 10, 'the page limit is a limit', `${docs.length} stored`);
ok(r.stoppedEarly === true, 'and the crawl says it stopped short');

r = await crawl('https://big.com', { maxPages: 99999 });
ok(r.pagesCrawled <= 500, 'a page limit from the client cannot ask for the world', `${r.pagesCrawled}`);

console.log(`\n${failed ? `${failed} FAILURE(S)` : 'all green'}`);
process.exit(failed ? 1 : 0);
