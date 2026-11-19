import { sql } from '../_db.js';
import { sessionToken, hashPassword, verifyPassword, verifyAgainstNothing } from '../_auth.js';
import { clientIp, isLocked, hitLocked, refund, recordFailure, clearThrottle, LOCKED_MESSAGE } from '../_throttle.js';
import crypto from 'crypto';
import { sessionInfo } from '../_session.js';

// Auto-initialize admin user on first ever login if no users exist yet.
async function ensureAdminExists() {
  const [{ count }] = await sql`select count(*)::int as count from users`;
  if (count > 0) return;

  const adminUsername = process.env.ADMIN_USERNAME || 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) return; // can't create without a password

  const adminId = crypto.randomUUID();
  const orgId = `org-${adminId}`;
  await sql`insert into organizations (id, name) values (${orgId}, ${adminUsername})`;
  await sql`
    insert into users (id, username, password_hash, is_admin, org_id, org_role, org_access)
    values (${adminId}, ${adminUsername}, ${hashPassword(adminPassword)}, true, ${orgId}, 'admin', 'edit')
  `;

  // Assign all existing agents (no owner yet) to the admin
  await sql`update agents set user_id = ${adminId}, org_id = ${orgId} where user_id is null`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }

  await ensureAdminExists();

  /* Brakes on guessing, two of them, neither of which can shut a person out
     of their own account:
       - per address: every attempt is counted before the password is looked
         at, so parallel guesses all count; past the limit the address is
         refused for a few minutes. A correct password gives its own attempt
         back but does not wipe the record, so signing in to an account of your
         own cannot launder guesses at other people's.
       - per username: failures are recorded, but a hot username is never
         refused — anyone could do that to anyone, admin included. Its answers
         just slow down, which costs a guesser spread over many addresses far
         more than it costs the person, whose right password still gets in. */
  const name = String(username);
  const userBucket = `user:${name}`;
  const ipBucket = `ip:${clientIp(req)}`;
  if (await hitLocked(ipBucket)) {
    return res.status(429).json({ error: LOCKED_MESSAGE });
  }
  if (await isLocked(userBucket)) await new Promise(r => setTimeout(r, 2000));

  const [user] = await sql`select * from users where username = ${name}`;
  /* An unknown name costs the same scrypt as a wrong password, so the time of
     the answer does not say which names exist. */
  const good = user ? verifyPassword(String(password), user.password_hash) : verifyAgainstNothing(String(password));
  if (!good) {
    await recordFailure(userBucket);
    return res.status(401).json({ error: 'invalid credentials' });
  }

  await clearThrottle([userBucket]);
  await refund(ipBucket);
  await sql`update users set last_login_at = now() where id = ${user.id}`;

  const token = sessionToken(user);
  return res.json({ token, username: user.username, isAdmin: user.is_admin, ...(await sessionInfo(user.id)) });
}
