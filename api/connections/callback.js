import { appBaseUrl } from '../_gmail.js';
import { logError } from '../_errorLog.js';
import { readState, finishOAuth } from '../_connections.js';

/**
 * Where Microsoft (and, by way of the Gmail callback, Google) sends the
 * browser back after a sign-in. Whatever happens, the person lands back in
 * the app with either the connection made or the reason it was not.
 */
export default async function handler(req, res) {
  return finishConnection(req, res);
}

export async function finishConnection(req, res) {
  const appUrl = appBaseUrl(req);
  const back = (params) => res.redirect(302, `${appUrl}/?${new URLSearchParams(params).toString()}`);
  try {
    const { code, state, error, error_description: detail } = req.query;
    if (error) return back({ connection_error: String(detail || error).slice(0, 300) });
    const data = readState(state);
    if (!data) return back({ connection_error: 'The sign-in took too long or did not start here. Try again.' });
    await finishOAuth({ provider: data.provider, code, appUrl, state: data });
    return back({ connection: 'ok' });
  } catch (err) {
    await logError({ source: 'connections', message: err.message, context: { step: 'oauth_callback' } }).catch(() => {});
    return back({ connection_error: err.message.slice(0, 300) });
  }
}
