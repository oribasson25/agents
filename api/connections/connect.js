import { requireSession } from '../_auth.js';
import { member, isOrgAdmin } from '../_access.js';
import { appBaseUrl } from '../_gmail.js';
import { authorizeUrl, signState, startNonce } from '../_connections.js';

/**
 * Starts connecting a mailbox.
 *
 *   GET /api/connections/connect?provider=gmail|microsoft&name=…
 *   Authorization: Bearer <session>
 *   → 200 { url }   the provider's sign-in page; the browser goes there next
 *
 * The session travels in the header, never in the address: an address ends
 * up in history, logs and Referer headers. The answer also sets an HttpOnly
 * cookie with a nonce the callback must see again, so the sign-in can only
 * be finished in the browser that started it.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const user = await requireSession(req, res);
  if (!user) return;
  const me = await member(user);
  if (!me || !me.orgId) return res.status(401).json({ error: 'Unauthorized' });
  if (!me.isPlatformAdmin && !isOrgAdmin(me)) return res.status(403).json({ error: 'Only the organization\'s admin adds connections.' });

  const provider = req.query.provider === 'microsoft' ? 'microsoft' : 'gmail';
  const appUrl = appBaseUrl(req);
  try {
    const nonce = startNonce();
    const state = signState({ orgId: me.orgId, userId: me.userId, provider, name: String(req.query.name || '').slice(0, 60), ...nonce.state });
    const url = authorizeUrl({ provider, appUrl, state });
    res.setHeader('Set-Cookie', nonce.cookie);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ url });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.code });
  }
}
