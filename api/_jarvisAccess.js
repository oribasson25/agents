/**
 * Who may run Jarvis — the WhatsApp numbers, the people on them and the
 * groups they sit in.
 *
 * The platform admin may see every number. An organization's admin may see
 * the numbers whose owner is in their organization, and only those: each
 * organization has a Jarvis of its own. Members of an organization do not
 * reach Jarvis at all.
 *
 * Every number belongs to an owner (wa_numbers.owner_user_id), and everything
 * else in Jarvis hangs off a number, so checking the number is the whole gate.
 */
import { sql } from './_db.js';
import { checkAuth } from './_auth.js';
import { member, isOrgAdmin } from './_access.js';

/** The caller, if they may use Jarvis at all; otherwise answers 401/403 and returns null. */
export async function jarvisGate(req, res) {
  const user = checkAuth(req, res);
  if (!user) return null;
  const me = await member(user);
  if (!me) { res.status(401).json({ error: 'unauthorized' }); return null; }
  if (!me.isPlatformAdmin && !isOrgAdmin(me)) {
    res.status(403).json({ error: 'Jarvis is for the organization\'s admin.' });
    return null;
  }
  return me;
}

/** The organization a number belongs to: its owner's. */
async function orgOfUser(userId) {
  const [row] = await sql`select org_id from users where id = ${userId}`;
  return row ? row.org_id : null;
}

/** May this person see and change this number? */
export async function numberInScope(me, number) {
  if (!me || !number) return false;
  if (me.isPlatformAdmin) return true;
  return (await orgOfUser(number.owner_user_id)) === me.orgId;
}

/** May this person make a number owned by `userId`? Only someone in their organization. */
export async function ownerInScope(me, userId) {
  if (me.isPlatformAdmin) return true;
  return (await orgOfUser(userId)) === me.orgId;
}
