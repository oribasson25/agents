import { loadAppBySlug, mayOpen } from './_apps.js';
import { linkId } from './_appFiles.js';

const TYPES = {
  html: 'text/html', htm: 'text/html', js: 'text/javascript', mjs: 'text/javascript',
  jsx: 'text/javascript', css: 'text/css', json: 'application/json', svg: 'image/svg+xml',
  txt: 'text/plain', md: 'text/plain', xml: 'application/xml', csv: 'text/csv',
  webmanifest: 'application/manifest+json', map: 'application/json',
};

/**
 * Every app page is sandboxed without `allow-same-origin`.
 *
 * Apps are served from the platform's own host, and what they run is code the
 * platform did not write. Without this, a public app opened by somebody who is
 * signed in to 8legs could read that person's session out of localStorage. The
 * sandbox gives the page an origin of its own that shares nothing with the
 * platform, whether it is framed in the Apps screen or opened in a tab.
 */
const SANDBOX = 'sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads';

function page(res, status, title, text) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', SANDBOX);
  res.setHeader('Cache-Control', 'no-store');
  res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="margin:0;display:grid;place-items:center;height:100vh;background:#0f1117;color:#f0f0f5;font:16px system-ui,sans-serif">
<div style="text-align:center;max-width:420px;padding:24px"><h1 style="font-size:20px">${title}</h1><p style="color:#9ca3af">${text}</p></div>`);
}

/** `/a/<slug>/[~<token>/]<path>` → its parts. */
export function parseAppPath(pathname) {
  const m = String(pathname || '').match(/^\/a\/([^/]+)(\/.*)?$/);
  if (!m) return null;
  let rest = m[2] === undefined ? null : m[2].slice(1);
  let token = null;
  if (rest !== null && rest.startsWith('~')) {
    const cut = rest.indexOf('/');
    token = cut === -1 ? rest.slice(1) : rest.slice(1, cut);
    rest = cut === -1 ? null : rest.slice(cut + 1);
  }
  let path = rest;
  try { if (path) path = decodeURIComponent(path); } catch { /* served as asked */ }
  return { slug: decodeURIComponent(m[1]), token, path };
}

/** The handle every app page gets. Kept small: it is inlined into each page. */
function sdk(boot) {
  return `<script>(function(){
var B=${JSON.stringify(boot).replace(/</g, '\\u003c')};
function call(op,body){
  return fetch(B.api,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(Object.assign({app:B.id,token:B.token,op:op},body||{}))})
  .then(function(r){return r.json().catch(function(){return {error:'HTTP '+r.status}})
    .then(function(d){if(!r.ok)throw new Error(d&&d.error||('HTTP '+r.status));return d})});
}
function sid(){return 'app-'+B.id.slice(0,8)+'-'+Date.now().toString(36)+Math.random().toString(36).slice(2,10)}
window.legs={
  app:{id:B.id,slug:B.slug,name:B.name},
  agents:B.agents,tables:B.tables,automations:B.automations||[],
  automation:function(name){return{
    run:function(input){return call('automation.run',{name:name,input:input||{}}).then(function(d){return d.output})}
  }},
  agent:function(name){return{
    info:function(){return call('agent.info',{name:name})},
    send:function(messages,opts){
      if(typeof messages==='string')messages=[{role:'user',content:messages}];
      return call('agent.send',{name:name,messages:messages,sessionId:opts&&opts.sessionId}).then(function(d){return d.content});
    },
    chat:function(){var c={messages:[],sessionId:sid(),send:function(text){
      c.messages.push({role:'user',content:String(text)});
      return call('agent.send',{name:name,messages:c.messages,sessionId:c.sessionId}).then(function(d){
        c.messages.push({role:'assistant',content:d.content});return d.content;
      },function(e){c.messages.pop();throw e});
    }};return c}
  }},
  table:function(name){return{
    info:function(){return call('table.info',{name:name})},
    rows:function(o){o=o||{};return call('table.rows',{name:name,q:o.q,limit:o.limit,offset:o.offset})},
    add:function(row){return call('table.add',{name:name,row:row})},
    update:function(rowId,row){return call('table.update',{name:name,rowId:rowId,row:row})},
    remove:function(rowId){return call('table.remove',{name:name,rowId:rowId})}
  }}
};
})();</script>`;
}

/** Puts the handle ahead of the page's own scripts. */
export function injectSdk(html, boot) {
  const tag = sdk(boot);
  const head = html.match(/<head[^>]*>/i);
  if (head) return html.replace(head[0], head[0] + tag);
  const doctype = html.match(/^\s*<!doctype[^>]*>/i);
  if (doctype) return html.replace(doctype[0], doctype[0] + tag);
  return tag + html;
}

/**
 * Serves an app's files at /a/<slug>/.
 *
 * A private app is reached through /a/<slug>/~<token>/ — the token sits in
 * the path, not in a cookie, because a sandboxed page has no cookies to send
 * and every relative file the page asks for then carries it by itself.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; return res.end(); }

  /* The rewrite hands over everything after /a/ as `p`; a direct mount passes
     the URL itself. One capture rather than slug + path, because a pattern
     with a separate path segment does not match the folder form (/a/slug/),
     which is the address every app is opened at. */
  const url = new URL(req.url || '/', 'http://x');
  const q = req.query || {};
  const rest = Array.isArray(q.p) ? q.p.join('/') : q.p;
  const parsed = parseAppPath(url.pathname) || (rest !== undefined ? parseAppPath(`/a/${rest}`) : null);
  /* What the browser asked for, to redirect relative to: not this function's own URL. */
  const asked = parseAppPath(url.pathname) ? url.pathname : `/a/${rest}`;
  if (!parsed) return page(res, 404, 'No such app', 'Check the address.');

  let found;
  try { found = await loadAppBySlug(parsed.slug); }
  catch (err) { return page(res, 500, 'Something went wrong', 'Try again in a moment.'); }
  if (!found) return page(res, 404, 'No such app', 'Check the address.');
  const { app } = found;

  if (!mayOpen(app, parsed.token)) {
    return page(res, 403, 'This app is private',
      'Open it from the Apps screen on 8legs, or ask its owner to share it by link.');
  }

  /* /a/slug and /a/slug/~tok have no trailing slash, so relative paths in the
     page would resolve one level up. Send the browser to the folder form. */
  if (parsed.path === null) {
    res.statusCode = 302;
    res.setHeader('Location', `${asked}/`);
    return res.end();
  }

  const entry = app.entry || 'index.html';
  let path = parsed.path || entry;
  let content = (app.files || {})[path];
  if (content === undefined && (app.files || {})[`${path.replace(/\/$/, '')}/index.html`] !== undefined) {
    path = `${path.replace(/\/$/, '')}/index.html`;
    content = app.files[path];
  }
  if (content === undefined) return page(res, 404, 'Not found', `This app has no file at ${path.replace(/[<>&]/g, '')}.`);

  const ext = (path.split('.').pop() || '').toLowerCase();
  const type = TYPES[ext] || 'text/plain';
  if (type === 'text/html') {
    content = injectSdk(content, {
      id: app.id, slug: app.slug, name: app.name || '',
      api: '/api/app-run', token: parsed.token || null,
      agents: Object.keys(app.agents || {}).filter(k => linkId(app.agents[k])),
      tables: Object.keys(app.tables || {}).filter(k => linkId(app.tables[k])),
      automations: Object.keys(app.automations || {}).filter(k => linkId(app.automations[k])),
    });
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', `${type}; charset=utf-8`);
  res.setHeader('Content-Security-Policy', SANDBOX);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  /* A sandboxed page is a foreign origin to its own files; module scripts and
     fetch() need this to load them. */
  res.setHeader('Access-Control-Allow-Origin', '*');
  /* Keep a private link's token out of the Referer of anything the page loads. */
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  return res.end(req.method === 'HEAD' ? undefined : content);
}
