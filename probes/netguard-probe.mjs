/**
 * api/_netGuard.js — the one way the platform fetches an address a customer
 * chose. Every address inside the network is refused however it is spelled,
 * redirects are checked and lose credentials when they leave the origin, the
 * body has one deadline and one size cap, and the request carries what fetch
 * would (User-Agent, Content-Length). Runs against local servers only.
 */
import assert from 'assert/strict';
import http from 'http';
import zlib from 'zlib';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const G = await import(`${ROOT}/api/_netGuard.js`);
let n = 0;
const check = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

await check('public addresses pass', () => {
  for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(G.isPublicAddress(a), true, a);
});
await check('every private spelling is refused', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '::1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe',
    '::7f00:1', '64:ff9b::a9fe:a9fe', '2002:7f00:1::', 'fe80::1', 'fd00::1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '[::1]', '::ffff:0:0']) {
    assert.equal(G.isPublicAddress(a), false, a);
  }
});
await check('URLs that point inside are refused before any connection', async () => {
  for (const u of ['http://[::ffff:127.0.0.1]/', 'http://[::ffff:169.254.169.254]/', 'http://2852039166/', 'http://0x7f.1/',
    'http://localhost:1/', 'http://127.1/', 'ftp://x.com/', 'http://u:p@example.com/', 'http://[::7f00:1]/', 'http://metadata.google.internal/']) {
    await assert.rejects(G.checkPublicUrl(u), undefined, u);
  }
});

const seen = [];
const srv = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => {
    seen.push({ url: req.url, h: req.headers, b });
    if (req.url === '/r') { res.writeHead(302, { location: `http://localhost:${srv.address().port}/end` }); return res.end(); }
    if (req.url === '/big') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('x'.repeat(5000)); }
    if (req.url === '/gz') { res.writeHead(200, { 'content-encoding': 'gzip' }); return res.end(zlib.gzipSync('x'.repeat(100000))); }
    if (req.url === '/slow') return setTimeout(() => res.end('late'), 3000);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path: req.url, auth: req.headers.authorization || null }));
  });
}).listen(0);
await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;

await check('a loopback server is refused without allowPrivate', async () => {
  await assert.rejects(G.safeFetch(`${base}/x`), /inside the platform/);
});
await check('credentials do not follow a redirect to another origin', async () => {
  const r = await G.safeFetch(`${base}/r`, { allowPrivate: true, headers: { authorization: 'Bearer s' } });
  assert.deepEqual(await r.json(), { path: '/end', auth: null });
  assert.ok(r.url.endsWith('/end'));
});
await check("redirect:'manual' hands the 3xx back", async () => {
  const r = await G.safeFetch(`${base}/r`, { allowPrivate: true, redirect: 'manual' });
  assert.equal(r.status, 302);
});
await check('the size cap holds, after decompression too', async () => {
  await assert.rejects(G.safeFetch(`${base}/big`, { allowPrivate: true, maxBytes: 1000 }), /larger than/);
  const cut = await G.safeFetch(`${base}/big`, { allowPrivate: true, maxBytes: 1000, truncate: true });
  assert.equal((await cut.text()).length, 1000);
  assert.equal(cut.truncated, true);
  await assert.rejects(G.safeFetch(`${base}/gz`, { allowPrivate: true, maxBytes: 50000 }), /larger than/);
  assert.equal((await (await G.safeFetch(`${base}/gz`, { allowPrivate: true })).text()).length, 100000);
});
await check('one deadline covers the whole exchange', async () => {
  await assert.rejects(G.safeFetch(`${base}/slow`, { allowPrivate: true, timeoutMs: 300 }), /within/);
});
await check('it sends what fetch would: User-Agent, Accept, Content-Length', async () => {
  seen.length = 0;
  await G.safeFetch(`${base}/a`, { allowPrivate: true, method: 'POST', body: 'héllo', headers: { 'Content-Type': 'text/plain' } });
  await G.safeFetch(`${base}/b`, { allowPrivate: true, headers: { 'User-Agent': 'mine' } });
  await G.safeFetch(`${base}/c`, { allowPrivate: true, method: 'POST' });
  assert.equal(seen[0].h['content-length'], '6');
  assert.equal(seen[0].b, 'héllo');
  assert.equal(seen[0].h['user-agent'], 'node');
  assert.equal(seen[0].h['transfer-encoding'], undefined);
  assert.equal(seen[1].h['user-agent'], 'mine');
  assert.equal(seen[1].h.accept, '*/*');
  assert.equal(seen[2].h['content-length'], '0');
});
await check('a probe transport sees each redirect hop', async () => {
  const hops = [];
  const r = await G.safeFetch('https://a.test/1', { allowPrivate: true, fetch: async (u) => {
    hops.push(u);
    return hops.length === 1 ? new Response(null, { status: 302, headers: { location: '/2' } }) : new Response('{"ok":1}');
  } });
  assert.deepEqual(hops, ['https://a.test/1', 'https://a.test/2']);
  assert.deepEqual(await r.json(), { ok: 1 });
});
srv.close();
console.log(`\nnetguard: ${n} checks passed`);
