import { sql } from '../_db.js';
import { sessionToken, hashPassword } from '../_auth.js';
import { cleanUsername } from '../_orgs.js';
import { seedDefaultAgents } from '../_defaultAgent.js';
import { seedDefaultApp } from '../_defaultApp.js';
import { claimInvite, releaseInvite, attachInviteUser } from '../_invites.js';
import { clientIp, isLocked, recordFailure, LOCKED_MESSAGE } from '../_throttle.js';
import crypto from 'crypto';
import { sessionInfo } from '../_session.js';

/**
 * Registration, which only an invitation code opens.
 *
 * The check the login screen makes before showing the form is a courtesy; this
 * is the gate. It claims the code in a single UPDATE that only succeeds on a
 * code nobody has spent, so a code handed to two people lets exactly one of
 * them in, however fast they both click.
 *
 * The order matters. The username is checked first, because a name already
 * taken is the common failure and it should not cost somebody their code. The
 * code is claimed next, and only then is the account written — if that last
 * step falls over, the claim is handed back.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { username, password, phone, inviteCode } = req.body || {};
  if (!username || !password || !phone) {
    return res.status(400).json({ error: 'username, password and phone required' });
  }
  if (!inviteCode) {
    return res.status(403).json({ error: 'An invitation code is required to create an account.' });
  }
  /* The same rules as every other way an account is made or a password set. */
  let name;
  try { name = cleanUsername(username); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  if (String(password).length < 8) {
    return res.status(400).json({ error: 'A password needs at least 8 characters.' });
  }

  /* A username-taken answer is a small enumeration oracle. It is useful enough
     to a real user to keep, so instead of hiding it we cap how fast one
     address can probe. Distinct from the login bucket, and fail-open. */
  const regBucket = `reg-ip:${clientIp(req)}`;
  if (await isLocked(regBucket)) {
    return res.status(429).json({ error: LOCKED_MESSAGE });
  }

  const [existing] = await sql`select id from users where username = ${name}`;
  if (existing) {
    await recordFailure(regBucket);
    return res.status(409).json({ error: 'Username already taken' });
  }

  const claim = await claimInvite(inviteCode);
  if (!claim.ok) {
    await recordFailure(regBucket);
    return res.status(403).json({ error: claim.reason });
  }

  /* A code opens a new organization, and the person registering is its admin. */
  const id = crypto.randomUUID();
  const orgId = `org-${id}`;
  try {
    await sql`insert into organizations (id, name, created_by) values (${orgId}, ${name}, null)`;
    await sql`
      insert into users (id, username, password_hash, phone, is_admin, org_id, org_role, org_access)
      values (${id}, ${name}, ${hashPassword(String(password))}, ${phone}, false, ${orgId}, 'admin', 'edit')
    `;
    await sql`update organizations set created_by = ${id} where id = ${orgId}`;
  } catch (err) {
    await sql`delete from organizations where id = ${orgId}`.catch(() => {});
    /* Somebody took the name in the seconds since the check above, or the
       write failed outright. Either way the code was never used. */
    await releaseInvite(claim.id).catch(() => {});
    const taken = /unique|duplicate/i.test(err.message || '');
    return res.status(taken ? 409 : 500).json({
      error: taken ? 'Username already taken' : 'Could not create the account. Try again.',
    });
  }

  /* Bookkeeping only — the code is already spent, and a failure here must not
     fail a registration that has happened. */
  await attachInviteUser(claim.id, id).catch(() => {});

  // A new account starts with a copy of each starter agent. This never throws,
  // so a missing or broken template cannot fail the sign-up.
  await seedDefaultAgents(id);
  // And the default app, a chat page linked to those chatbots. Never throws either.
  await seedDefaultApp(id);

  const token = sessionToken({ id, username: name, is_admin: false, token_version: 0 });

  return res.status(201).json({ token, username: name, isAdmin: false, ...(await sessionInfo(id)) });
}
