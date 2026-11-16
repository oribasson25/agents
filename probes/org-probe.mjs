/**
 * Organizations: who may see and change what.
 *
 * One organization (o1) with an admin, a viewer, an editor and a member who
 * sees nothing but what was granted one item at a time; a second organization
 * (o2) whose admin must reach none of it; and the platform admin. Every check
 * goes through the real endpoints, over an in-memory database that answers the
 * statements they send.
 */
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
process.env.JWT_SECRET = 'org-probe-secret';

const { signJWT, hashPassword, verifyPassword } = await import(`${ROOT}/api/_auth.js`);
const { levelFor, allows } = await import(`${ROOT}/api/_access.js`);
const { accessStub } = await import('./access-stub.mjs');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && detail ? `\n    ${detail}` : ''}`);
  if (!ok) failed++;
};

/* ── the rule itself ────────────────────────────────────────────────────── */
const A = { userId: 'a', orgId: 'o1', orgRole: 'admin', orgAccess: 'edit' };
const V = { userId: 'v', orgId: 'o1', orgRole: 'member', orgAccess: 'view' };
const N = { userId: 'n', orgId: 'o1', orgRole: 'member', orgAccess: 'none' };
const P = { userId: 'p', orgId: 'o0', orgRole: 'admin', orgAccess: 'edit', isPlatformAdmin: true };
check('an organization\'s admin edits everything in it', levelFor(A, 'o1', 'none') === 'edit');
check('and nothing outside it', levelFor(A, 'o2', undefined) === 'none');
check('a member gets their org-wide level', levelFor(V, 'o1', undefined) === 'view');
check('a grant replaces it, upward', levelFor(N, 'o1', 'edit') === 'edit');
check('and downward', levelFor(V, 'o1', 'none') === 'none');
check('a grant cannot reach into another organization', levelFor(N, 'o2', 'edit') === 'none');
check('the platform admin reaches everything', levelFor(P, 'o2', undefined) === 'edit');
check('edit allows view, view does not allow edit', allows('edit', 'view') && !allows('view', 'edit'));

/* ── an in-memory platform ──────────────────────────────────────────────── */
const db = {
  orgs: [{ id: 'o0', name: 'Platform' }, { id: 'o1', name: 'Acme' }, { id: 'o2', name: 'Other' }],
  users: [
    { id: 'p', username: 'admin', is_admin: true, org_id: 'o0', org_role: 'admin', org_access: 'edit' },
    { id: 'a', username: 'acme-admin', org_id: 'o1', org_role: 'admin', org_access: 'edit' },
    { id: 'v', username: 'viewer', org_id: 'o1', org_role: 'member', org_access: 'view' },
    { id: 'e', username: 'editor', org_id: 'o1', org_role: 'member', org_access: 'edit' },
    { id: 'n', username: 'narrow', org_id: 'o1', org_role: 'member', org_access: 'none' },
    { id: 'x', username: 'other-admin', org_id: 'o2', org_role: 'admin', org_access: 'edit' },
  ].map(u => ({ is_admin: false, must_change_password: false, password_hash: hashPassword('password-1'), ...u })),
  agents: [
    { id: 'a1', org_id: 'o1', user_id: 'e', data: { id: 'a1', name: 'Sales' } },
    { id: 'a2', org_id: 'o1', user_id: 'a', data: { id: 'a2', name: 'Support' } },
    { id: 'b1', org_id: 'o2', user_id: 'x', data: { id: 'b1', name: 'Theirs' } },
  ],
  tables: [{ id: 't1', org_id: 'o1', user_id: 'a', name: 'Leads', description: '', columns: [{ key: 'name', name: 'Name', type: 'text' }] }],
  rows: [],
  grants: [
    { user_id: 'n', kind: 'agent', item_id: 'a1', level: 'edit' },
    { user_id: 'n', kind: 'table', item_id: 't1', level: 'view' },
  ],
  orgSettings: { o1: { provider: 'claude', api_key: 'ORG-KEY', model: 'claude-sonnet-5-5', ollama_host: '' } },
  userSettings: {},
  usage: [{ user_id: 'e', cost_usd: 1 }],
  numbers: [
    { id: 'wan-acme', label: 'Acme line', owner_user_id: 'a' },
    { id: 'wan-other', label: 'Other line', owner_user_id: 'x' },
    { id: 'wan-platform', label: 'Platform line', owner_user_id: 'p' },
  ],
};
const userById = (id) => db.users.find(u => u.id === id);
const orgOfUser = (id) => (userById(id) || {}).org_id;
const access = accessStub({
  strict: true,
  get users() {
    return Object.fromEntries(db.users.map(u => [u.id, { username: u.username, org: u.org_id, role: u.org_role,
      orgName: (db.orgs.find(o => o.id === u.org_id) || {}).name,
      access: u.org_access, isAdmin: u.is_admin, mustChange: u.must_change_password }]));
  },
  item: (kind, id) => {
    const row = kind === 'agent' ? db.agents.find(a => a.id === id) : kind === 'table' ? db.tables.find(t => t.id === id) : null;
    return row ? { org: row.org_id, user: row.user_id } : null;
  },
  get grants() { return db.grants.map(g => ({ user: g.user_id, kind: g.kind, item: g.item_id, level: g.level })); },
});

globalThis.__db = (text, p) => {
  const answered = access(text, p);
  if (answered !== undefined) return answered;
  const t = text.replace(/\s+/g, ' ').trim();

  /* agents */
  if (t.startsWith('select a.id, a.org_id, a.data,')) return db.agents.filter(a => a.org_id === p[0]).map(a => ({ ...a, draft: null }));
  if (t.startsWith('select a.data, (select b.id from agent_branches')) {
    const a = db.agents.find(x => x.id === p[0]); return a ? [{ data: a.data, draft_id: null, draft: null }] : [];
  }
  if (t.startsWith('select data, user_id from agents where id')) return db.agents.filter(a => a.id === p[0]);
  if (t.startsWith('update agents set data')) { db.agents.find(a => a.id === p[1]).data = JSON.parse(p[0]); return []; }
  if (t.startsWith('insert into agents')) {
    db.agents.push({ id: p[0], data: JSON.parse(p[1]), user_id: p[2], org_id: orgOfUser(p[2]) }); return [];
  }
  if (t.startsWith('delete from agents where id')) { db.agents = db.agents.filter(a => a.id !== p[0]); return []; }
  if (t.startsWith('select id, org_id from agents where org_id')) return db.agents.filter(a => a.org_id === p[0]);
  if (t.includes('from agent_branches')) return [];

  /* tables */
  if (t.startsWith('select t.id, t.org_id, t.name')) return db.tables.filter(x => x.org_id === orgOfUser(p[0])).map(x => ({ ...x, row_count: 0 }));
  if (t.startsWith('select id, org_id, name, description, columns')) return db.tables.filter(x => x.id === p[0] && x.org_id === orgOfUser(p[1]));
  if (t.startsWith('insert into data_table_rows')) { db.rows.push({ id: p[0], table_id: p[1] }); return []; }
  if (t.startsWith('update data_tables set updated_at')) return [];
  if (t.startsWith('update data_tables set name')) return [];
  if (t.startsWith('insert into data_tables')) { db.tables.push({ id: p[0], user_id: p[1], org_id: orgOfUser(p[1]), name: p[2] }); return []; }

  /* organizations and people */
  if (t.startsWith('select id, name, created_at from organizations where id')) return db.orgs.filter(o => o.id === p[0]);
  if (t.startsWith('select 1 as x from users where username')) return db.users.some(u => u.username === p[0]) ? [{ x: 1 }] : [];
  if (t.startsWith('insert into users')) {
    db.users.push({ id: p[0], username: p[1], password_hash: p[2], is_admin: false, org_id: p[3], org_role: p[4],
                    org_access: p[5], must_change_password: true });
    return [];
  }
  if (t.startsWith('insert into organizations')) { db.orgs.push({ id: p[0], name: p[1] }); return []; }
  if (t.startsWith('select u.id, u.username, u.org_role, u.org_access, u.must_change_password')) {
    return db.users.filter(u => u.org_id === p[0]).map(u => ({ ...u, grants: db.grants.filter(g => g.user_id === u.id).length }));
  }
  if (t.startsWith('select id, username, org_role, org_access, is_admin from users where id')) {
    return db.users.filter(u => u.id === p[0] && u.org_id === p[1]);
  }
  if (t.startsWith("select count(*)::int as n from users where org_id = ? and org_role = 'admin'")) {
    return [{ n: db.users.filter(u => u.org_id === p[0] && u.org_role === 'admin').length }];
  }
  if (t.startsWith("select id from users where org_id = ? and org_role = 'admin' and id <> ?")) {
    return db.users.filter(u => u.org_id === p[0] && u.org_role === 'admin' && u.id !== p[1]).slice(0, 1);
  }
  if (t.startsWith('update users set org_role')) { Object.assign(userById(p[2]), { org_role: p[0], org_access: p[1] }); return []; }
  if (t.startsWith('update users set password_hash')) {
    Object.assign(userById(p[1]), { password_hash: p[0], must_change_password: t.includes('must_change_password = true') }); return [];
  }
  for (const [table, list] of [['agents', 'agents'], ['data_tables', 'tables'], ['apps', null], ['claude_usage', 'usage']]) {
    if (t.startsWith(`update ${table} set user_id`) || t.startsWith(`update ${table}      set user_id`) || t.startsWith(`update ${table} set user_id`)) {
      if (list) db[list].filter(r => r.user_id === p[1]).forEach(r => { r.user_id = p[0]; });
      return [];
    }
  }
  if (/^update (agents|data_tables|apps|automations|claude_usage) +set user_id/.test(t)) {
    const list = { agents: 'agents', data_tables: 'tables', claude_usage: 'usage' }[t.split(' ')[1]];
    if (list) db[list].filter(r => r.user_id === p[1]).forEach(r => { r.user_id = p[0]; });
    return [];
  }
  if (t.startsWith('delete from users where id')) { db.users = db.users.filter(u => u.id !== p[0]); db.grants = db.grants.filter(g => g.user_id !== p[0]); return []; }
  if (t.startsWith("select id, data->>'name' as name from agents where org_id")) return db.agents.filter(a => a.org_id === p[0]).map(a => ({ id: a.id, name: a.data.name }));
  if (t.startsWith('select id, name from data_tables where org_id')) return db.tables.filter(x => x.org_id === p[0]);
  if (t.startsWith("select id, data->>'name' as name, slug from apps where org_id")) return [];
  if (t.startsWith("select id, data->>'name' as name from automations where org_id")) return [];
  if (t.startsWith('select kind, item_id, level from access_grants')) return db.grants.filter(g => g.user_id === p[0]);
  if (t.startsWith('select id from agents where id = ? and org_id = ?')) return db.agents.filter(a => a.id === p[0] && a.org_id === p[1]);
  if (t.startsWith('select id from data_tables where id = ? and org_id = ?')) return db.tables.filter(x => x.id === p[0] && x.org_id === p[1]);
  if (t.startsWith('delete from access_grants')) { db.grants = db.grants.filter(g => !(g.user_id === p[0] && g.kind === p[1] && g.item_id === p[2])); return []; }
  if (t.startsWith('insert into access_grants')) {
    db.grants = db.grants.filter(g => !(g.user_id === p[0] && g.kind === p[1] && g.item_id === p[2]));
    db.grants.push({ user_id: p[0], kind: p[1], item_id: p[2], level: p[3] }); return [];
  }

  /* settings */
  if (t.startsWith('select coalesce(o.provider, s.provider)')) {
    const u = userById(p[0]); if (!u) return [];
    const o = db.orgSettings[u.org_id]; const s = db.userSettings[u.id];
    return [{ provider: o?.provider, api_key: o?.api_key, model: o?.model, ollama_host: o?.ollama_host,
              assistant_language: s?.assistant_language || 'en', language_chosen: !!s?.language_chosen, found: !!(o || s) }];
  }
  if (t.startsWith('insert into user_settings')) { db.userSettings[p[0]] = { assistant_language: p[1], language_chosen: p[2] }; return []; }
  if (t.startsWith('insert into org_settings')) {
    db.orgSettings[orgOfUser(p[4])] = { provider: p[0], api_key: p[1], model: p[2], ollama_host: p[3] }; return [];
  }

  /* Jarvis */
  if (t.startsWith('select * from wa_numbers where id')) return db.numbers.filter(n => n.id === p[0]);
  if (t.startsWith('select id from users where id')) return db.users.filter(u => u.id === p[0]).map(u => ({ id: u.id }));
  if (t.startsWith('select org_id from users where id')) return db.users.filter(u => u.id === p[0]).map(u => ({ org_id: u.org_id }));
  if (t.startsWith('select n.id, n.label, n.owner_user_id')) {
    return db.numbers.filter(n => p[0] === true || orgOfUser(n.owner_user_id) === p[1]).map(n => ({ id: n.id, label: n.label }));
  }

  /* me */
  if (t.startsWith('select username, is_admin from users where id')) return db.users.filter(u => u.id === p[0]);
  if (t.startsWith('select password_hash from users where id')) return db.users.filter(u => u.id === p[0]);

  throw new Error('unrouted: ' + t.slice(0, 100));
};

const jwt = (id) => `Bearer ${signJWT({ userId: id, username: (userById(id) || {}).username, isAdmin: !!(userById(id) || {}).is_admin })}`;
async function call(path, method, { as, query = {}, body } = {}) {
  const { default: handler } = await import(`${ROOT}/api/${path}`);
  const res = { statusCode: 200, payload: undefined,
    status(c) { this.statusCode = c; return this; }, json(v) { this.payload = v; return this; },
    setHeader() {}, end() { return this; } };
  await handler({ method, query, body, headers: { authorization: as ? jwt(as) : '' } }, res);
  return res;
}

/* ── what each person sees ──────────────────────────────────────────────── */
/* The chatbots one person sees, as id:level — the ones this probe set up, so a
   chatbot added further down does not change an earlier answer. */
const list = async (as) => (await call('agents.js', 'GET', { as })).payload
  .filter(a => ['a1', 'a2', 'b1'].includes(a.id)).map(a => `${a.id}:${a._access}`).sort().join(',');
check('the organization\'s admin sees all of its chatbots, to edit', (await list('a')) === 'a1:edit,a2:edit', await list('a'));
check('a viewer sees them all, to view', (await list('v')) === 'a1:view,a2:view', await list('v'));
check('a narrow member sees only what was granted', (await list('n')) === 'a1:edit', await list('n'));
check('another organization\'s admin sees none of them', (await list('x')) === 'b1:edit', await list('x'));

const get = (as, id) => call('agents/[id]/index.js', 'GET', { as, query: { id } });
check('a chatbot outside your reach is a 404, not a 403', (await get('n', 'a2')).statusCode === 404);
check('and so is another organization\'s', (await get('a', 'b1')).statusCode === 404);
check('the platform admin can open any', (await get('p', 'b1')).statusCode === 200);
check('the open chatbot says how far you reach', (await get('v', 'a1')).payload._access === 'view');

const put = (as, id) => call('agents/[id]/index.js', 'PUT', { as, query: { id, branch: 'main' }, body: { id, name: `edited by ${as}` } });
const viewerPut = await put('v', 'a1');
check('a viewer cannot change a chatbot', viewerPut.statusCode === 403 && viewerPut.payload.code === 'READ_ONLY', JSON.stringify(viewerPut.payload));
check('and nothing was written', db.agents.find(a => a.id === 'a1').data.name === 'Sales');
check('an editor can', (await put('e', 'a2')).statusCode === 200 && db.agents.find(a => a.id === 'a2').data.name === 'edited by e');
check('a member granted edit on one chatbot can change it', (await put('n', 'a1')).statusCode === 200);
check('a viewer cannot delete one', (await call('agents/[id]/index.js', 'DELETE', { as: 'v', query: { id: 'a2' } })).statusCode === 403);

const create = (as) => call('agents.js', 'POST', { as, body: { id: `new-${as}`, name: 'New' } });
check('a viewer cannot add a chatbot', (await create('v')).statusCode === 403);
check('a narrow member cannot either, whatever they were granted', (await create('n')).statusCode === 403);
check('an org-wide editor can, and it lands in the organization',
      (await create('e')).statusCode === 201 && db.agents.find(a => a.id === 'new-e').org_id === 'o1');

/* tables */
const tables = async (as) => (await call('tables.js', 'GET', { as })).payload.tables.map(x => `${x.id}:${x._access}`).join(',');
check('a narrow member sees the table granted to them, to view', (await tables('n')) === 't1:view', await tables('n'));
check('another organization sees no table of this one', (await tables('x')) === '');
const addRow = (as) => call('tables/[id]/rows.js', 'POST', { as, query: { id: 't1' }, body: { row: { name: 'Dana' } } });
check('a table viewer cannot add a row', (await addRow('n')).statusCode === 403);
check('an editor can', (await addRow('e')).statusCode === 200 && db.rows.length === 1);
check('another organization cannot even find the table', (await addRow('x')).statusCode === 404);

/* ── running the organization ───────────────────────────────────────────── */
check('a member cannot see the people', (await call('org/members.js', 'GET', { as: 'e' })).statusCode === 403);
const people = await call('org/members.js', 'GET', { as: 'a' });
check('the admin sees everyone in the organization, and only them',
      people.statusCode === 200 && people.payload.members.map(m => m.username).sort().join(',') === 'acme-admin,editor,narrow,viewer');
check('another organization\'s admin cannot ask for it',
      (await call('org/members.js', 'GET', { as: 'x', query: { org: 'o1' } })).statusCode === 403);
check('the platform admin can', (await call('org/members.js', 'GET', { as: 'p', query: { org: 'o1' } })).statusCode === 200);

const added = await call('org/members.js', 'POST', { as: 'a', body: { username: 'dana', orgAccess: 'view' } });
const dana = userById(added.payload?.id);
check('the admin adds a member, with a temporary password shown once',
      added.statusCode === 201 && /^[A-Za-z0-9]{12}$/.test(added.payload.temporaryPassword) && dana?.org_id === 'o1',
      JSON.stringify(added.payload));
check('which has to be replaced at first sign-in', dana?.must_change_password === true &&
      verifyPassword(added.payload.temporaryPassword, dana.password_hash));
check('a taken username is refused', (await call('org/members.js', 'POST', { as: 'a', body: { username: 'viewer' } })).statusCode === 409);

const grant = (as, userId, kind, itemId, level) => call('org/members/[userId].js', 'PATCH', { as, query: { userId }, body: { kind, itemId, level } });
check('the admin grants one item', (await grant('a', dana.id, 'agent', 'a2', 'edit')).statusCode === 200 &&
      (await list(dana.id)) === 'a1:view,a2:edit', await list(dana.id));
check('and takes it back to the org-wide level', (await grant('a', dana.id, 'agent', 'a2', null)).statusCode === 200 &&
      (await list(dana.id)) === 'a1:view,a2:view');
check('an item of another organization cannot be granted', (await grant('a', dana.id, 'agent', 'b1', 'edit')).statusCode === 404);
const map = await call('org/members/[userId].js', 'GET', { as: 'a', query: { userId: 'n' } });
check('the access map lists every item with its level and its override',
      map.payload.items.find(i => i.id === 'a1').grant === 'edit' && map.payload.items.find(i => i.id === 'a2').level === 'none',
      JSON.stringify(map.payload.items));

const promote = await call('org/members/[userId].js', 'PUT', { as: 'a', query: { userId: 'v' }, body: { orgAccess: 'edit' } });
check('the admin raises a member\'s org-wide level', promote.statusCode === 200 && (await list('v')) === 'a1:edit,a2:edit');
check('the admin cannot demote themselves',
      (await call('org/members/[userId].js', 'PUT', { as: 'a', query: { userId: 'a' }, body: { orgRole: 'member' } })).statusCode === 409);

const removed = await call('org/members/[userId].js', 'DELETE', { as: 'a', query: { userId: 'e' } });
check('removing a member keeps their work in the organization',
      removed.statusCode === 200 && db.agents.find(a => a.id === 'a1')?.user_id === 'a' && db.usage[0].user_id === 'a',
      JSON.stringify(removed.payload));
check('and they are gone', !userById('e'));
check('the last admin cannot be removed by the platform admin either',
      (await call('org/members/[userId].js', 'DELETE', { as: 'p', query: { userId: 'a', org: 'o1' } })).statusCode === 409);

/* ── settings: one key per organization ─────────────────────────────────── */
const memberSave = await call('settings.js', 'PUT', { as: 'v', body: { provider: 'claude', apiKey: 'MEMBER-KEY', assistantLanguage: 'he' } });
check('a member saving settings changes only their own language',
      memberSave.statusCode === 200 && db.orgSettings.o1.api_key === 'ORG-KEY' && db.userSettings.v.assistant_language === 'he' &&
      memberSave.payload.canEditModel === false);
const adminSave = await call('settings.js', 'PUT', { as: 'a', body: { provider: 'claude', apiKey: 'NEW-ORG-KEY', assistantLanguage: 'en' } });
check('the admin changes the organization\'s key', adminSave.payload.canEditModel === true && db.orgSettings.o1.api_key === 'NEW-ORG-KEY');
check('and every member runs on it', (await call('settings.js', 'GET', { as: 'v' })).payload.apiKey === 'NEW-ORG-KEY');

/* ── Jarvis: each organization's admin runs its own ─────────────────────── */
const numbers = async (as) => {
  const r = await call('admin/jarvis/numbers.js', 'GET', { as });
  return r.statusCode === 200 ? r.payload.map(n => n.id).sort().join(',') : r.statusCode;
};
check('an organization\'s admin sees its own numbers only', (await numbers('a')) === 'wan-acme', await numbers('a'));
check('the other organization\'s admin sees theirs', (await numbers('x')) === 'wan-other', await numbers('x'));
check('the platform admin sees every number', (await numbers('p')) === 'wan-acme,wan-other,wan-platform', await numbers('p'));
check('a member does not reach Jarvis', (await numbers('v')) === 403);
const openNumber = (as, id) => call('admin/jarvis/numbers/[id].js', 'GET', { as, query: { id } });
check('another organization\'s number does not open, even by id', (await openNumber('a', 'wan-other')).statusCode === 404);
check('a person cannot be added to another organization\'s number',
      (await call('admin/jarvis/people.js', 'POST', { as: 'a', body: { numberId: 'wan-other', name: 'Eve', phone: '0501234567' } })).statusCode === 404);
check('a number cannot be made for someone in another organization',
      (await call('admin/jarvis/numbers.js', 'POST', { as: 'a', body: { label: 'Theirs', ownerUserId: 'x' } })).statusCode === 400);

/* ── passwords ──────────────────────────────────────────────────────────── */
const me = await call('me.js', 'GET', { as: dana.id });
check('the session says a temporary password must be replaced', me.payload.mustChangePassword === true && me.payload.orgName === 'Acme');
check('a wrong current password is refused',
      (await call('me.js', 'POST', { as: dana.id, body: { currentPassword: 'nope', newPassword: 'a-new-password' } })).statusCode === 403);
const changed = await call('me.js', 'POST', { as: dana.id, body: { currentPassword: added.payload.temporaryPassword, newPassword: 'a-new-password' } });
check('the right one replaces it and clears the flag',
      changed.statusCode === 200 && !userById(dana.id).must_change_password && verifyPassword('a-new-password', userById(dana.id).password_hash));

console.log(`\n${failed ? `${failed} FAILURE(S)` : 'all green'}`);
process.exit(failed ? 1 : 0);
