import crypto from 'crypto';
import { sql } from './_db.js';
import { requireSession, createToken } from './_auth.js';

/**
 * Personal access tokens for the CLI.
 *
 * Only a JWT reaches this endpoint — a token cannot mint another token, so a
 * leaked one cannot extend its own life or outlive a revocation. A token ends
 * a year after it is made (TOKEN_DAYS), and every one of them is revoked when
 * an admin resets the account's password.
 */
const TOKEN_DAYS = 365;

export default async function handler(req, res) {
  /* requireSession, not checkAuth alone: a session ended by a password reset
     must not be able to mint the CLI a way back in. */
  const user = await requireSession(req, res);
  if (!user) return;

  if (req.method === 'GET') {
    const rows = await sql`
      select id, name, token_prefix, created_at, last_used_at, expires_at
      from api_tokens
      where user_id = ${user.userId} and revoked_at is null
      order by created_at desc
    `;
    return res.json(rows);
  }

  if (req.method === 'POST') {
    const name = String((req.body || {}).name || '').slice(0, 80).trim() || 'CLI';
    const { token, hash, prefix } = createToken();
    await sql`
      insert into api_tokens (id, user_id, name, token_hash, token_prefix, expires_at)
      values (${crypto.randomUUID()}, ${user.userId}, ${name}, ${hash}, ${prefix},
              now() + ${TOKEN_DAYS}::int * interval '1 day')
    `;
    /* The only time the token itself is ever sent anywhere. */
    const expiresAt = new Date(Date.now() + TOKEN_DAYS * 86400000).toISOString();
    return res.status(201).json({ token, name, prefix, expiresAt });
  }

  if (req.method === 'DELETE') {
    const id = (req.query || {}).id || (req.body || {}).id;
    if (!id) return res.status(400).json({ error: 'id required' });
    await sql`
      update api_tokens set revoked_at = now()
      where id = ${id} and user_id = ${user.userId} and revoked_at is null
    `;
    return res.status(204).end();
  }

  res.status(405).end();
}
