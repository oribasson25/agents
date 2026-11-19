/**
 * What each kind of step does.
 *
 * A step is handed its settings with every reference already filled in
 * (`config`), plus `ctx` for what it needs from the world. It returns
 * `{ output, port }` — what later steps can read, and which way the run goes
 * on — or throws with a message a person can act on.
 *
 * Loop and Wait are not here: they change how the run itself proceeds, so the
 * engine does them.
 */
import { safeFetch, assertPublicUrl } from './_netGuard.js';
import { runToolCode } from './_toolRunner.js';
import { compare, fieldsToObject, resolveJsonText, resolve, LIMITS } from './_automationSpec.js';

/* An HTTP step reaches only the public internet: every hop is resolved,
   checked and pinned by api/_netGuard.js. Re-exported for the probes. */
export { assertPublicUrl };

/* ─────────────────── HTTP request ─────────────────── */

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/** How long a step may still take: its own limit, cut to what the run has left. */
export function stepTimeoutMs(wantedMs, ctx) {
  const left = ctx && ctx.hardDeadline ? ctx.hardDeadline - Date.now() - 2000 : Infinity;
  return Math.max(1000, Math.min(wantedMs, left));
}

/* What an automation sends with each request, so a chain that calls its own
   webhook (A calls a hook that starts A …) is counted like any other chain. */
export const CHAIN_HEADER = 'X-8legs-Chain';

const rowsOn = (rows) => (Array.isArray(rows) ? rows : []).filter(r => r && r.on !== false && String(r.key || '').trim());

/** The request an HTTP step's settings describe, before anything is sent. */
export function buildRequest(config) {
  const method = METHODS.includes(String(config.method || '').toUpperCase()) ? String(config.method).toUpperCase() : 'GET';
  let url;
  const typed = String(config.url || '').trim();
  try { url = new URL(/^https?:\/\//i.test(typed) ? typed : `https://${typed}`); }
  catch { throw new Error(`"${typed}" is not a URL`); }
  for (const r of rowsOn(config.params)) url.searchParams.append(String(r.key).trim(), String(r.value ?? ''));

  const headers = {};
  for (const r of rowsOn(config.headers)) headers[String(r.key).trim()] = String(r.value ?? '');

  const auth = config.auth || {};
  if (auth.type === 'bearer' && auth.token) headers.Authorization = `Bearer ${auth.token}`;
  if (auth.type === 'basic') {
    headers.Authorization = `Basic ${Buffer.from(`${auth.username || ''}:${auth.password || ''}`).toString('base64')}`;
  }
  if (auth.type === 'apikey' && auth.key) {
    if (auth.in === 'query') url.searchParams.append(String(auth.key), String(auth.value ?? ''));
    else headers[String(auth.key)] = String(auth.value ?? '');
  }

  let body;
  const hasType = Object.keys(headers).some(h => h.toLowerCase() === 'content-type');
  if (method !== 'GET' && method !== 'HEAD') {
    if (config.bodyType === 'json') {
      const value = config.bodyJson;
      if (value !== undefined) {
        body = JSON.stringify(value);
        if (!hasType) headers['Content-Type'] = 'application/json';
      }
    } else if (config.bodyType === 'form') {
      const form = new URLSearchParams();
      for (const r of rowsOn(config.form)) form.append(String(r.key).trim(), String(r.value ?? ''));
      body = form.toString();
      if (!hasType) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (config.bodyType === 'text') {
      body = String(config.body ?? '');
      if (!hasType) headers['Content-Type'] = 'text/plain; charset=utf-8';
    }
  }
  return { method, url: url.toString(), headers, body };
}

const GUARD_WORDS = /inside the platform|is not a URL|Only http|Could not find the server|Too many redirects|user name or password/;

async function http(config, ctx) {
  const request = buildRequest(config);
  const timeout = stepTimeoutMs(Math.max(1, Math.min(120, Number(config.timeout) || 30)) * 1000, ctx);
  const started = Date.now();
  const headers = { ...request.headers };
  if (ctx.depth !== undefined && ctx.depth !== null) headers[CHAIN_HEADER] = String(Number(ctx.depth) + 1);

  let response;
  try {
    response = await safeFetch(request.url, {
      method: request.method, headers, body: request.body,
      timeoutMs: timeout, maxBytes: LIMITS.outputBytes,
      fetch: ctx.fetch, allowPrivate: !!ctx.allowPrivate,
    });
  } catch (err) {
    if (err.code === 'TOO_LARGE') throw new Error('The answer is larger than 1 MB, which is more than a step can hold');
    if (err.code === 'TIMEOUT' || GUARD_WORDS.test(err.message || '')) throw err;
    let host = '';
    try { host = new URL(request.url).host; } catch { /* keep it empty */ }
    throw new Error(`Could not reach ${host}: ${err.cause ? err.cause.message || err.message : err.message}`);
  }

  const raw = request.method === 'HEAD' ? '' : await response.text();
  let parsed = raw;
  const type = response.headers.get('content-type') || '';
  if (raw && (type.includes('json') || /^[\[{]/.test(raw.trim()))) {
    try { parsed = JSON.parse(raw); } catch { /* leave it as text */ }
  }
  const output = {
    status: response.status,
    ok: response.ok,
    headers: Object.fromEntries(response.headers.entries()),
    body: parsed,
    ms: Date.now() - started,
  };
  if (!response.ok && config.failOnStatus !== false) {
    const snippet = typeof parsed === 'string' ? parsed.slice(0, 300) : JSON.stringify(parsed).slice(0, 300);
    throw Object.assign(new Error(`The server answered ${response.status}${snippet ? `: ${snippet}` : ''}`), { output });
  }
  return { output, port: 'out' };
}

/* ─────────────────── code ─────────────────── */

/*
 * The runner calls `run(**inputs)` and turns whatever comes back into text.
 * An automation needs the value itself — a dict the next step can read fields
 * of — so the step's own `run` is wrapped in one that returns JSON, and what
 * it printed along the way comes back with it.
 */
const WRAPPER = `

import json as __json, io as __io, contextlib as __ctx
__user_run = run
def run(**__kw):
    __out = __io.StringIO()
    with __ctx.redirect_stdout(__out):
        __value = __user_run(**__kw)
    return __json.dumps({"__8legs": True, "value": __value, "printed": __out.getvalue()[-4000:]}, default=str, ensure_ascii=False)
`;

async function code(config, ctx) {
  const inputs = fieldsToObject(config.inputs, {});   /* already filled by the engine */
  const packages = String(config.packages || '').split(',').map(s => s.trim()).filter(Boolean);
  const timeoutMs = stepTimeoutMs(120 * 1000, ctx);
  let data;
  try {
    data = await runToolCode({
      code: String(config.code || '') + WRAPPER, inputs, packages, envVars: ctx.secrets || {},
      baseUrl: ctx.baseUrl, fetch: ctx.fetch || fetch, timeoutMs,
    });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(`The code did not finish within ${Math.round(timeoutMs / 1000)} seconds`);
    }
    throw err;
  }
  if (data.error) throw new Error(String(data.error));
  try {
    const parsed = JSON.parse(data.result);
    if (parsed && parsed.__8legs) {
      return { output: parsed.value === undefined ? null : parsed.value, port: 'out', printed: parsed.printed || '' };
    }
  } catch { /* not ours */ }
  return { output: data.result ?? null, port: 'out' };
}

/* ─────────────────── logic ─────────────────── */

function ifStep(config) {
  const conditions = Array.isArray(config.conditions) ? config.conditions : [];
  const results = conditions.map(c => compare(c.left, c.op || 'eq', c.right));
  const passed = config.match === 'any' ? results.some(Boolean) : results.every(Boolean);
  return { output: { result: passed, conditions: results }, port: passed ? 'yes' : 'no' };
}

function switchStep(config) {
  const value = config.value;
  const cases = Array.isArray(config.cases) ? config.cases : [];
  const hit = cases.find(c => compare(value, 'eq', c.value));
  return { output: { value, case: hit ? hit.id : 'default' }, port: hit ? String(hit.id) : 'default' };
}

function set(config) {
  return { output: fieldsToObject(config.fields, {}), port: 'out' };
}

function output(config) {
  return { output: fieldsToObject(config.fields, {}), port: null, isOutput: true };
}

async function call(config, ctx) {
  if (!ctx.callAutomation) throw new Error('Running another automation is not available here');
  const result = await ctx.callAutomation(String(config.automationId), fieldsToObject(config.fields, {}));
  return { output: result === undefined ? null : result, port: 'out' };
}

const RUNNERS = { http, code, if: ifStep, switch: switchStep, set, output, call };

/* Steps that reach into the organization — its connections, tables, chatbots
   and model key — live in their own file, loaded the first time one runs, so
   everything above stays free of the database. */
const CONNECTED = new Set(['whatsapp', 'approval', 'wa_reply', 'email', 'email_search', 'table', 'agent', 'ai']);

/**
 * A step's settings with every reference filled in from `scope`.
 *
 * Code is the one thing left as written: `{{ }}` is ordinary Python (and
 * common in f-strings), and a step's code reads other steps through its
 * inputs, not by having text pasted into it.
 */
export function fillConfig(step, scope) {
  const c = step.config || {};
  if (step.type === 'code') {
    return { ...c, inputs: (Array.isArray(c.inputs) ? c.inputs : []).map(f => ({ key: f.key, value: resolve(f.value, scope) })) };
  }
  if (step.type === 'http') {
    const { body, ...rest } = c;
    const filled = resolve(rest, scope);
    if (c.bodyType === 'json') filled.bodyJson = resolveJsonText(body, scope);
    else filled.body = resolve(body, scope);
    return filled;
  }
  if (['set', 'output', 'call', 'table'].includes(step.type)) {
    const { fields, ...rest } = c;
    return { ...resolve(rest, scope),
             fields: (Array.isArray(fields) ? fields : []).map(f => ({ key: f.key, value: resolve(f.value, scope) })) };
  }
  return resolve(c, scope);
}

/** Runs one step whose settings are already filled. */
export async function runStep(step, config, ctx) {
  if (CONNECTED.has(step.type)) {
    const connected = ctx.connected || (await import('./_automationConnected.js')).CONNECTED_RUNNERS;
    if (!connected[step.type]) throw new Error(`Nothing knows how to run a "${step.type}" step`);
    return connected[step.type](config, ctx);
  }
  const runner = RUNNERS[step.type];
  if (!runner) throw new Error(`Nothing knows how to run a "${step.type}" step`);
  return runner(config, ctx);
}
