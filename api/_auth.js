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
