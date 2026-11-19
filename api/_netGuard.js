/**
 * The one way the platform fetches an address someone else chose.
 *
 * An HTTP step, the crawler and the scrapers all fetch URLs that a customer
 * typed (or a webhook supplied), from the platform's own servers. Each used to
 * guard that differently, and each guard had its own hole: a crawler with no
 * check at all, a check that ran before redirects instead of after each one,
 * `[::ffff:127.0.0.1]` slipping through as `::ffff:7f00:1`, and DNS rebinding
 * between the check and the connection.
 *
 * Here, for every hop:
 *   1. the name is resolved, and every address it has must be public
 *      (IPv4-mapped and IPv4-compatible IPv6 are judged by the IPv4 inside;
 *      NAT64, 6to4 and Teredo, which can wrap any IPv4, are refused outright);
 *   2. the connection is pinned to the address that was checked, so a second
 *      DNS answer cannot point it somewhere else;
 *   3. redirects are followed by hand, each one checked again, and headers
 *      that carry credentials are dropped when a redirect leaves the origin;
 *   4. the whole exchange, body included, has one deadline and one size cap
 *      (counted after decompression).
 *
 * Probes have no network: they pass `fetch` (a transport that answers like
 * fetch with redirect:'manual') and `allowPrivate`, or set `netGuardTesting`.
 */
import dns from 'dns/promises';
import net from 'net';
import http from 'http';
import https from 'https';
import zlib from 'zlib';

/** For probes only. Never set in the platform's own code. */
export const netGuardTesting = { allowPrivate: false, transport: null };

const INSIDE = 'That address is inside the platform\'s network and cannot be called';

const BLOCKED = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) BLOCKED.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['64:ff9b::', 96], ['64:ff9b:1::', 48],   /* NAT64: any IPv4 behind it */
  ['100::', 64],                            /* discard */
  ['2001::', 32],                           /* Teredo */
  ['2001:db8::', 32],                       /* documentation */
  ['2002::', 16],                           /* 6to4: any IPv4 behind it */
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) BLOCKED.addSubnet(address, prefix, 'ipv6');

/** 16 bytes of an IPv6 address, or null if it is not one. */
function v6bytes(ip) {
  let s = String(ip).toLowerCase().replace(/^\[|\]$/g, '');
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (!net.isIPv4(tail)) return null;
    const p = tail.split('.').map(Number);
    s = `${s.slice(0, lastColon + 1)}${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  let groups;
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const rest = halves[1] ? halves[1].split(':') : [];
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...Array(fill).fill('0'), ...rest];
  }
  const bytes = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push(n >> 8, n & 255);
  }
  return bytes;
}

/** True only for an address anyone on the internet could reach. */
export function isPublicAddress(ip) {
  const family = net.isIP(String(ip));
  if (family === 4) return !BLOCKED.check(String(ip), 'ipv4');
  const b = v6bytes(ip);
  if (!b) return false;
  if (b.slice(0, 10).every(x => x === 0) && ((b[10] === 0xff && b[11] === 0xff) || (b[10] === 0 && b[11] === 0))) {
    /* ::ffff:a.b.c.d and ::a.b.c.d (which also covers :: and ::1) */
    return isPublicAddress(b.slice(12).join('.'));
  }
  const canonical = Array.from({ length: 8 }, (_, i) => ((b[2 * i] << 8) | b[2 * i + 1]).toString(16)).join(':');
  return !BLOCKED.check(canonical, 'ipv6');
}

/**
 * Resolves a URL's host and refuses it unless every address is public.
 * Returns the parsed URL and the address to connect to.
 */
export async function checkPublicUrl(rawUrl, { allowPrivate = false } = {}) {
  let url;
  try { url = new URL(String(rawUrl)); } catch { throw new Error(`"${rawUrl}" is not a URL`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https addresses can be called');
  if (url.username || url.password) throw new Error('An address with a user name or password in it cannot be called');
  const lenient = allowPrivate || netGuardTesting.allowPrivate;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!lenient && (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local'))) {
    throw new Error(INSIDE);
  }
  let addresses;
  if (net.isIP(host)) addresses = [{ address: host, family: net.isIP(host) }];
  else {
    try { addresses = await dns.lookup(host, { all: true, verbatim: true }); }
    catch {
      if (lenient) return { url, address: null, family: 0 };   /* a probe's made-up host, answered by its transport */
      throw new Error(`Could not find the server "${host}"`);
    }
  }
  if (!addresses.length) throw new Error(`Could not find the server "${host}"`);
  if (!lenient && addresses.some(a => !isPublicAddress(a.address))) throw new Error(INSIDE);
  return { url, address: addresses[0].address, family: addresses[0].family };
}

/** Kept for callers that only need the yes/no (and the parsed URL). */
export async function assertPublicUrl(rawUrl, opts) {
  return (await checkPublicUrl(rawUrl, opts)).url;
}

/* Headers that carry who the caller is; they never follow a redirect to another origin. */
const CREDENTIAL_HEADERS = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|x-auth-token|x-access-token|x-internal-secret)$/i;

function headerObject(headers) {
  const out = {};
  if (!headers) return out;
  const entries = typeof headers.entries === 'function' ? headers.entries() : Object.entries(headers);
  for (const [k, v] of entries) if (v !== undefined && v !== null) out[String(k).toLowerCase()] = String(v);
  return out;
}

function tooLarge(maxBytes) {
  const mb = maxBytes >= 1048576 ? `${Math.round(maxBytes / 1048576)} MB` : `${Math.round(maxBytes / 1024)} KB`;
  return Object.assign(new Error(`The answer is larger than ${mb}`), { code: 'TOO_LARGE' });
}

/* One request over a connection pinned to `address`. Resolves with the raw parts. */
function pinnedRequest(url, { method, headers, body, address, family, signal, maxBytes, truncate }) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    /* What fetch() would send if the caller says nothing: some servers refuse
       a request with no User-Agent (api.github.com answers 403), and one with
       a chunked body and no length (411). */
    const payload = body === undefined || body === null ? null
      : (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array ? body : String(body));
    const hdrs = { 'user-agent': 'node', accept: '*/*', 'accept-encoding': 'gzip, deflate, br', ...headers };
    if (payload !== null) hdrs['content-length'] = String(typeof payload === 'string' ? Buffer.byteLength(payload) : payload.length);
    else if (!['GET', 'HEAD', 'OPTIONS', 'DELETE'].includes(method)) hdrs['content-length'] = '0';
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };
    const req = mod.request(url, {
      method,
      headers: hdrs,
      signal,
      lookup: (_host, opts, cb) => {
        if (opts && opts.all) cb(null, [{ address, family }]);
        else cb(null, address, family);
      },
    }, (res) => {
      const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      if (encoding === 'gzip' || encoding === 'x-gzip') stream = res.pipe(zlib.createGunzip());
      else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
      const chunks = [];
      let size = 0;
      let cut = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        const headersOut = { ...res.headers };
        if (stream !== res) { delete headersOut['content-encoding']; delete headersOut['content-length']; }
        resolve({ status: res.statusCode, statusText: res.statusMessage || '', headers: headersOut, body: Buffer.concat(chunks), truncated: cut });
      };
      stream.on('data', (chunk) => {
        if (cut || settled) return;
        size += chunk.length;
        if (maxBytes && size > maxBytes) {
          if (!truncate) { res.destroy(); fail(tooLarge(maxBytes)); return; }
          chunks.push(chunk.subarray(0, chunk.length - (size - maxBytes)));
          cut = true;
          finish();
          res.destroy();
          return;
        }
        chunks.push(chunk);
      });
      stream.on('end', finish);
      stream.on('error', (err) => { if (!cut) fail(err); });
      res.on('error', (err) => { if (!cut) fail(err); });
    });
    req.on('error', fail);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/* The same, through an injected fetch-like transport (probes). */
async function viaTransport(transport, url, { method, headers, body, signal, maxBytes, truncate }) {
  const r = await transport(url.toString(), { method, headers, body, redirect: 'manual', signal });
  const status = r.status;
  const hdrs = {};
  if (r.headers) {
    if (typeof r.headers.entries === 'function') for (const [k, v] of r.headers.entries()) hdrs[k.toLowerCase()] = v;
    else if (typeof r.headers.get === 'function') {
      for (const k of ['location', 'content-type', 'content-length']) { const v = r.headers.get(k); if (v != null) hdrs[k] = v; }
    }
  }
  let buf = Buffer.alloc(0);
  if (status < 300 || status >= 400 || !hdrs.location) {
    const ab = typeof r.arrayBuffer === 'function' ? await r.arrayBuffer() : Buffer.from(typeof r.text === 'function' ? await r.text() : '');
    buf = Buffer.from(ab);
  }
  let cut = false;
  if (maxBytes && buf.length > maxBytes) {
    if (!truncate) throw tooLarge(maxBytes);
    buf = buf.subarray(0, maxBytes);
    cut = true;
  }
  return { status, statusText: r.statusText || '', headers: hdrs, body: buf, truncated: cut };
}

function toResponse(raw, finalUrl) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(raw.headers)) {
    if (Array.isArray(v)) v.forEach(x => headers.append(k, x));
    else if (v !== undefined) headers.set(k, String(v));
  }
  const status = raw.status;
  if (status < 200 || status > 599) throw new Error(`The server answered with status ${status}`);
  const nullBody = status === 204 || status === 205 || status === 304;
  const response = new Response(nullBody ? null : raw.body, { status, statusText: raw.statusText, headers });
  Object.defineProperty(response, 'url', { value: finalUrl });
  Object.defineProperty(response, 'truncated', { value: !!raw.truncated });
  return response;
}

/**
 * fetch(), for an address someone else chose. Returns a standard Response
 * (with `url` set to where the redirects ended, and `truncated` when
 * `truncate` cut the body at `maxBytes`).
 *
 *   timeoutMs     one deadline for every hop and the body (default 30 s)
 *   maxBytes      the most it reads, after decompression (default 5 MB);
 *                 over it throws, or with `truncate` keeps the first maxBytes
 *   maxRedirects  default 5
 *   redirect      'follow' (default) or 'manual': hand a 3xx back as it is
 *   fetch         a transport for probes (answers like fetch, redirect:'manual')
 *   allowPrivate  probes only
 */
export async function safeFetch(rawUrl, {
  method = 'GET', headers, body, timeoutMs = 30000, maxBytes = 5 * 1048576, truncate = false,
  maxRedirects = 5, redirect = 'follow', signal, fetch: transport, allowPrivate = false,
} = {}) {
  const deadline = AbortSignal.timeout(Math.max(1, timeoutMs));
  const sig = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let current = String(rawUrl);
  let verb = String(method || 'GET').toUpperCase();
  let payload = body instanceof URLSearchParams ? body.toString() : body;
  let hdrs = headerObject(headers);
  const via = transport || netGuardTesting.transport;
  try {
    for (let hop = 0; ; hop++) {
      const target = await checkPublicUrl(current, { allowPrivate });
      const opts = { method: verb, headers: hdrs, body: payload, signal: sig, maxBytes, truncate };
      const raw = via
        ? await viaTransport(via, target.url, opts)
        : await pinnedRequest(target.url, { ...opts, address: target.address, family: target.family });
      const location = raw.status >= 300 && raw.status < 400 && raw.headers.location;
      if (!location || redirect === 'manual') return toResponse(raw, target.url.toString());
      if (hop >= maxRedirects) throw new Error('Too many redirects');
      const next = new URL(Array.isArray(location) ? location[0] : location, target.url);
      if (next.origin !== target.url.origin) {
        hdrs = Object.fromEntries(Object.entries(hdrs).filter(([k]) => !CREDENTIAL_HEADERS.test(k)));
      }
      if (raw.status === 303 || ((raw.status === 301 || raw.status === 302) && verb === 'POST')) {
        verb = 'GET';
        payload = undefined;
        delete hdrs['content-type'];
        delete hdrs['content-length'];
      }
      current = next.toString();
    }
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError' || err.code === 'ABORT_ERR')) {
      if (deadline.aborted) {
        let host = '';
        try { host = new URL(current).host; } catch { /* keep it empty */ }
        throw Object.assign(new Error(`No answer from ${host || 'the server'} within ${Math.round(timeoutMs / 1000)} seconds`), { code: 'TIMEOUT' });
      }
    }
    throw err;
  }
}
