import crypto from 'crypto';

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

export function signJWT(payload) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const sig = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function verifyJWT(token) {
  try {
    const [header, body, sig] = token.split('.');
    if (!header || !body || !sig) return null;
    const expected = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(`${header}.${body}`)
      .digest('base64url');
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
  return candidate === hash;
}

/* ─────────────────── personal access tokens ─────────────────── */

const TOKEN_PREFIX = '8legs_pat_';

/** A new token. The caller shows `token` once and stores the rest. */
export function createToken() {
  const token = TOKEN_PREFIX + crypto.randomBytes(24).toString('base64url');
  return { token, hash: hashToken(token), prefix: token.slice(0, TOKEN_PREFIX.length + 4) };
}

/** Plain sha256, not scrypt: the token is 24 random bytes, not a password. */
export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function looksLikeToken(value) {
  return typeof value === 'string' && value.startsWith(TOKEN_PREFIX);
}

/**
 * Like checkAuth, but also accepts a personal access token.
 *
 * It is a separate, async function rather than a change to checkAuth on
 * purpose: checkAuth is synchronous and is called that way in nineteen files,
 * so making it async to reach the database would mean touching all of them to
 * add an `await` — for the sake of the two endpoints the CLI talks to.
 */
export async function checkAuthOrToken(req, res) {
  const header = req.headers['authorization'] || '';
  if (!header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  const credential = header.slice(7);
  if (!looksLikeToken(credential)) return checkAuth(req, res);

  /* Imported here, not at the top: _auth.js is pulled in by nineteen files and
     _db.js needs DATABASE_URL the moment it loads. Only this path needs it. */
  const { sql } = await import('./_db.js');
  const [row] = await sql`
    select t.id, t.user_id, u.username, u.is_admin
    from api_tokens t join users u on u.id = t.user_id
    where t.token_hash = ${hashToken(credential)} and t.revoked_at is null
  `;
  if (!row) {
    res.status(401).json({ error: 'invalid token' });
    return false;
  }
  /* Best-effort: a failed bookkeeping write must not fail the request. */
  sql`update api_tokens set last_used_at = now() where id = ${row.id}`.catch(() => {});
  return { userId: row.user_id, username: row.username, isAdmin: !!row.is_admin, viaToken: true };
}

// Returns the decoded JWT payload or responds 401
export function checkAuth(req, res) {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const payload = verifyJWT(token);
    if (payload) return payload; // { userId, username, isAdmin }
    res.status(401).json({ error: 'invalid token' });
    return false;
  }
  res.status(401).json({ error: 'unauthorized' });
  return false;
}

// Same as checkAuth but also requires is_admin === true
export function checkAdmin(req, res) {
  const user = checkAuth(req, res);
  if (!user) return false;
  if (!user.isAdmin) {
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  return user;
}
