import { checkAdmin } from '../_auth.js';
import { createInvite, listInvites, inviteState, DEFAULT_DAYS } from '../_invites.js';

/**
 * The admin's invitation codes: list them, mint one.
 *
 * A minted code comes back in the response and nowhere else, ever — the row
 * holds a hash. The list is therefore about what became of each code, not
 * about reading it back.
 */
export default async function handler(req, res) {
  const admin = checkAdmin(req, res);
  if (!admin) return;

  if (req.method === 'GET') {
    const rows = await listInvites();
    return res.json(rows.map(row => ({
      id: row.id,
      prefix: row.prefix,
      state: inviteState(row),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      usedAt: row.used_at,
      usedBy: row.used_by_username || null,
      createdBy: row.created_by_username || null,
    })));
  }

  if (req.method === 'POST') {
    const { code, invite } = await createInvite(admin.userId, req.body?.days || DEFAULT_DAYS);
    return res.status(201).json({
      code,                                   // shown once, then gone
      id: invite.id,
      prefix: invite.prefix,
      state: inviteState(invite),
      createdAt: invite.created_at,
      expiresAt: invite.expires_at,
      usedAt: null,
      usedBy: null,
      createdBy: admin.username,
    });
  }

  res.status(405).end();
}
