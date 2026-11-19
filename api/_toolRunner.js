/**
 * The one way the platform hands Python to the tool runner.
 *
 * Tool code is written by customers, so it must never run next to the
 * platform's own secrets (DATABASE_URL, JWT_SECRET, provider keys). The safe
 * place is a separate deployment whose environment holds nothing but its own
 * shared secret: set TOOL_RUNNER_URL (its base address) and TOOL_RUNNER_SECRET
 * (the same value set there) and every caller goes there — see
 * tool-runner/README.md. Without them it falls back to this deployment's own
 * /api/run-tool, which accepts nothing but the internal secret.
 *
 * Callers: the agent runner (a chatbot calling a tool), the automation "code"
 * step, and POST /api/tool-run (a person testing a tool in the editor).
 */
import { internalSecret } from './_auth.js';

let warnedFallback = false;

/** Where code goes, and the secret that proves the caller is the platform. */
export function toolRunnerTarget(baseUrl) {
  const external = String(process.env.TOOL_RUNNER_URL || '').trim().replace(/\/+$/, '');
  if (external) {
    const secret = String(process.env.TOOL_RUNNER_SECRET || '');
    if (!secret) throw new Error('TOOL_RUNNER_URL is set without TOOL_RUNNER_SECRET');
    return { url: `${external}/api/run-tool`, secret };
  }
  if (!baseUrl) throw new Error('The code runner cannot be reached from here');
  if (process.env.VERCEL_ENV === 'production' && !warnedFallback) {
    warnedFallback = true;
    console.error('[tool runner] TOOL_RUNNER_URL is not set: customers\' tool code runs in this deployment, where a child process can read the platform\'s secrets through /proc. Deploy tool-runner/ and set TOOL_RUNNER_URL and TOOL_RUNNER_SECRET.');
  }
  return { url: `${String(baseUrl).replace(/\/+$/, '')}/api/run-tool`, secret: internalSecret() };
}

/**
 * Runs `code` (which defines run(**inputs)) and returns what the runner said:
 * { result } or { error }. Never throws for a failure inside the code; throws
 * only when the runner itself cannot be reached or answers nonsense.
 */
export async function runToolCode({ code, inputs = {}, packages = [], envVars = {}, baseUrl, fetch: doFetch = fetch, timeoutMs = 60000 }) {
  const target = toolRunnerTarget(baseUrl);
  const resp = await doFetch(target.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': target.secret },
    body: JSON.stringify({ code: String(code || ''), inputs: inputs || {}, packages: packages || [], env_vars: envVars || {} }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let data;
  try { data = await resp.json(); }
  catch { throw new Error(`The code runner answered ${resp.status} instead of a result`); }
  if (!data || typeof data !== 'object') throw new Error(`The code runner answered ${resp.status} instead of a result`);
  return data;
}
