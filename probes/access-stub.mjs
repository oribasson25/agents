/**
 * Answers the queries api/_access.js makes, for probes that stub the database.
 *
 *   const access = accessStub({
 *     users:  { u1: { org: 'o1', role: 'admin' }, u2: { org: 'o1', role: 'member', access: 'view' } },
 *     item:   (kind, id) => ({ org: 'o1', user: 'u1' }) or null,
 *     grants: [{ user: 'u2', kind: 'agent', item: 'a1', level: 'edit' }],
 *   });
 *   globalThis.__db = (text, p) => access(text, p) ?? yourRoutes(text, p);
 *
 * Returns undefined for any other query, so a probe's own routes still run.
 * A user the world does not name is an admin of org 'o1', which is what every
 * probe written before organizations assumed.
 */
export function accessStub(world = {}) {
  /* Read on every query, so a world whose people or grants change mid-probe
     (getters, or plain objects mutated) is seen as it is now. */
  const userOf = (id) => (world.users || {})[id] || (world.strict ? null : { org: 'o1', role: 'admin', access: 'edit' });
  const item = (kind, id, slug) => {
    const found = world.item ? world.item(kind, id, slug) : { org: 'o1', user: 'u1' };
    return found ? [{ id: found.id || id, org_id: found.org, user_id: found.user }] : [];
  };
  return (text, p) => {
    const t = String(text).replace(/\s+/g, ' ').trim();
    if (t.startsWith('select u.id, u.username, u.is_admin, u.org_id, u.org_role')) {
      const u = userOf(p[0]);
      return u ? [{ id: p[0], username: u.username || p[0], is_admin: !!u.isAdmin, org_id: u.org,
                    org_role: u.role || 'admin', org_access: u.access || 'edit',
                    must_change_password: !!u.mustChange, org_name: u.orgName || u.org }] : [];
    }
    if (t.startsWith('select id, org_id, user_id from agents where id')) return item('agent', p[0]);
    if (t.startsWith('select id, org_id, user_id from data_tables where id')) return item('table', p[0]);
    if (t.startsWith('select id, org_id, user_id from apps where id')) return item('app', p[0], p[1]);
    if (t.startsWith('select id, org_id, user_id from automations where id')) return item('automation', p[0]);
    if (t.startsWith('select level from access_grants')) {
      return (world.grants || []).filter(g => g.user === p[0] && g.kind === p[1] && g.item === p[2]).map(g => ({ level: g.level }));
    }
    if (t.startsWith('select item_id, level from access_grants')) {
      return (world.grants || []).filter(g => g.user === p[0] && g.kind === p[1]).map(g => ({ item_id: g.item, level: g.level }));
    }
    return undefined;
  };
}
