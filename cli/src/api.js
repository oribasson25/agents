/** The platform, over HTTP. No dependencies: Node 18 has fetch. */
import { readConfig, DEFAULT_HOST } from './config.js';

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `HTTP ${status}`);
    this.status = status;
    this.body = body || {};
  }
}

export function session() {
  const { token, host } = readConfig();
  return { token, host: host || DEFAULT_HOST };
}

export async function api(path, { method = 'GET', body, token, host } = {}) {
  const s = session();
  const useToken = token || s.token;
  if (!useToken) {
    const e = new Error('Not logged in. Run `8legs login` first.');
    e.friendly = true;
    throw e;
  }
  let res;
  try {
    res = await fetch(new URL(path, host || s.host), {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${useToken}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    const e = new Error(`Could not reach ${host || s.host}: ${cause.message}`);
    e.friendly = true;
    throw e;
  }
  if (res.status === 204) return null;
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { error: text.slice(0, 200) }; }
  if (!res.ok) throw new ApiError(res.status, parsed);
  return parsed;
}
