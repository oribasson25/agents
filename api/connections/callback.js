import { appBaseUrl } from '../_gmail.js';
import { logError } from '../_errorLog.js';
import { member, isOrgAdmin } from '../_access.js';
import { readState, finishOAuth, nonceMatches, clearNonce } from '../_connections.js';

/**
 * Where Microsoft (and, by way of the Gmail callback, Google) sends the
 * browser back after a sign-in. Whatever happens, the person lands back in
 * the app with either the connection made or the reason it was not.
 *
 * The state must be one this platform signed in the last ten minutes, the
 * browser must hold the nonce cookie the start left (so a consent link
 * someone else started cannot put your mailbox in their organization), and
 * whoever started it must still be that organization's admin.
 */
export default async function handler(req, res) {
  return finishConnection(req, res);
}

export async function finishConnection(req, res) {
  const appUrl = appBaseUrl(req);
  const back = (params) => res.redirect(302, `${appUrl}/?${new URLSearchParams(params).toString()}`);
  try {
    const { code, state, error, error_description: detail } = req.query;
    const data = readState(state);
    if (data) res.setHeader('Set-Cookie', clearNonce(data));
    if (error) return back({ connection_error: String(detail || error).slice(0, 300) });
    if (!data) return back({ connection_error: 'The sign-in took too long or did not start here. Try again.' });
    if (!nonceMatches(req, data)) return back({ connection_error: 'The sign-in did not start in this browser. Start it again from Connections.' });
    const me = await member({ userId: data.userId });
    if (!me || (!me.isPlatformAdmin && (me.orgId !== data.orgId || !isOrgAdmin(me)))) {
      return back({ connection_error: 'Only the organization\'s admin adds connections.' });
    }
    await finishOAuth({ provider: data.provider, code, appUrl, state: data });
    return back({ connection: 'ok' });
  } catch (err) {
    await logError({ source: 'connections', message: err.message, context: { step: 'oauth_callback' } }).catch(() => {});
    return back({ connection_error: String(err.message || 'The connection could not be made.').slice(0, 300) });
  }
}
