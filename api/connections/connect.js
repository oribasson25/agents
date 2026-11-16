import { verifyJWT } from '../_auth.js';
import { member, isOrgAdmin } from '../_access.js';
import { appBaseUrl } from '../_gmail.js';
import { authorizeUrl, signState } from '../_connections.js';

/**
 * Starts connecting a mailbox: sends the browser to Google or Microsoft.
 *
 * A browser redirect cannot carry a header, so the session token arrives in
 * the address, the same way the per-chatbot Gmail flow does it.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const user = verifyJWT(String(req.query.token || ''));
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const me = await member(user);
  if (!me || !me.orgId) return res.status(401).json({ error: 'Unauthorized' });
  if (!me.isPlatformAdmin && !isOrgAdmin(me)) return res.status(403).json({ error: 'Only the organization\'s admin adds connections.' });

  const provider = req.query.provider === 'microsoft' ? 'microsoft' : 'gmail';
  const appUrl = appBaseUrl(req);
  try {
    const state = signState({ orgId: me.orgId, userId: me.userId, provider, name: String(req.query.name || '').slice(0, 60) });
    return res.redirect(302, authorizeUrl({ provider, appUrl, state }));
  } catch (err) {
    return res.redirect(302, `${appUrl}/?connection_error=${encodeURIComponent(err.message.slice(0, 300))}`);
  }
}
