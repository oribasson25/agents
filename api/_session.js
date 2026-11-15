import { member } from './_access.js';

/**
 * What the interface needs to know about the person signed in, beyond the
 * token: their organization, their role in it, and whether they still have to
 * replace a temporary password. Sent at login and from /api/me, so a role
 * changed by an admin shows up on the next load rather than at next login.
 */
export async function sessionInfo(userId) {
  const me = await member({ userId });
  if (!me) return {};
  return {
    userId: me.userId,
    orgId: me.orgId,
    orgName: me.orgName,
    orgRole: me.orgRole,
    orgAccess: me.orgAccess,
    mustChangePassword: me.mustChangePassword,
    canCreate: me.isPlatformAdmin || me.orgRole === 'admin' || me.orgAccess === 'edit',
  };
}
