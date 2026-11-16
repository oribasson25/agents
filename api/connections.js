import { checkAuthOrToken } from './_auth.js';
import { sql } from './_db.js';
import { member, isOrgAdmin } from './_access.js';
import { listConnections, createWhatsAppConnection, KINDS } from './_connections.js';

/**
 * The organization's connections.
 *
 *   GET   everyone in the organization: the names, kinds and accounts (never a
 *         token) — an automation's editor needs them to offer a choice. The
 *         admin also gets what can still be connected.
 *   POST  the admin: { kind: 'whatsapp', numberId, name } lets automations
 *         send from a linked number. Mailboxes are connected by a sign-in,
 *         which starts at /api/connections/connect.
 */
export default async function handler(req, res) {
  const user = await checkAuthOrToken(req, res);
  if (!user) return;
  const me = await member(user);
  if (!me || !me.orgId) return res.status(401).json({ error: 'unauthorized' });
  const admin = me.isPlatformAdmin || isOrgAdmin(me);

  try {
    if (req.method === 'GET') {
      const connections = await listConnections(me.orgId);
      if (!admin) return res.json({ connections, canManage: false });
      const numbers = await sql`
        select n.id, n.label, n.phone from wa_numbers n join users u on u.id = n.owner_user_id
        where u.org_id = ${me.orgId} order by n.created_at
      `;
      return res.json({
        connections, canManage: true,
        numbers: numbers.map(n => ({ id: n.id, label: n.label, phone: n.phone, linked: !!n.phone,
                                     connected: connections.some(c => c.numberId === n.id) })),
        providers: { gmail: !!process.env.GOOGLE_CLIENT_ID, microsoft: !!process.env.MICROSOFT_CLIENT_ID },
        kinds: KINDS,
      });
    }
    if (req.method === 'POST') {
      if (!admin) return res.status(403).json({ error: 'Only the organization\'s admin adds connections.' });
      const { kind, numberId, name } = req.body || {};
      if (kind !== 'whatsapp') return res.status(400).json({ error: 'A mailbox is connected by signing in to it; only a WhatsApp number is added here.' });
      const id = await createWhatsAppConnection({ orgId: me.orgId, userId: me.userId, name, numberId });
      return res.status(201).json({ id });
    }
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.code });
  }
  return res.status(405).end();
}
