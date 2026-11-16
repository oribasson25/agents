/**
 * Organizations and the people in them.
 *
 * The platform admin makes an organization together with its first admin. An
 * organization's admin adds members, sets how far each one reaches
 * (org_access) and, item by item, overrides it (access_grants).
 *
 * Accounts are made here with a temporary password that is shown once to
 * whoever made them and has to be replaced at first sign-in. Nothing here ever
 * returns a password except at that moment.
 */
import crypto from 'crypto';
import { sql } from './_db.js';
import { hashPassword } from './_auth.js';
import { LEVELS, KINDS } from './_access.js';
import { seedDefaultAgents } from './_defaultAgent.js';
import { seedDefaultApp } from './_defaultApp.js';

const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** A temporary password: twelve characters nobody will misread. */
export function temporaryPassword() {
  const bytes = crypto.randomBytes(12);
  return Array.from(bytes, b => PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]).join('');
}

const fail = (message, code, status = 400) => Object.assign(new Error(message), { code, status });

function cleanUsername(value) {
  const name = String(value || '').trim();
  if (name.length < 2 || name.length > 60) throw fail('A username needs 2 to 60 characters.', 'BAD_NAME');
  if (/\s/.test(name)) throw fail('A username cannot contain spaces.', 'BAD_NAME');
  return name;
}

export async function getOrg(orgId) {
  const [row] = await sql`select id, name, created_at from organizations where id = ${orgId}`;
  return row || null;
}

/** Every organization, for the platform admin. */
export async function listOrgs() {
  return sql`
    select o.id, o.name, o.created_at,
           (select count(*)::int from users u where u.org_id = o.id)                          as members,
           (select count(*)::int from users u where u.org_id = o.id and u.org_role = 'admin') as admins,
           (select count(*)::int from agents a where a.org_id = o.id)                         as agents,
           (select count(*)::int from data_tables t where t.org_id = o.id)                    as tables,
           (select count(*)::int from apps p where p.org_id = o.id)                           as apps,
           (select max(u.last_login_at) from users u where u.org_id = o.id)                   as last_active
    from organizations o
    order by o.created_at desc
  `;
}

/**
 * A person in an organization. Returns the account and, once, its temporary
 * password. The username is unique across the whole platform.
 */
export async function createMember({ orgId, username, orgRole = 'member', orgAccess = 'none', createdBy }) {
  const name = cleanUsername(username);
  const role = orgRole === 'admin' ? 'admin' : 'member';
  const access = role === 'admin' ? 'edit' : (LEVELS.includes(orgAccess) ? orgAccess : 'none');
  if (!(await getOrg(orgId))) throw fail('No such organization.', 'NO_ORG', 404);

  const [taken] = await sql`select 1 as x from users where username = ${name}`;
  if (taken) throw fail(`The username "${name}" is taken.`, 'TAKEN', 409);

  const id = crypto.randomUUID();
  const password = temporaryPassword();
  await sql`
    insert into users (id, username, password_hash, is_admin, org_id, org_role, org_access, must_change_password)
    values (${id}, ${name}, ${hashPassword(password)}, false, ${orgId}, ${role}, ${access}, true)
  `;
  console.log(`[orgs] ${createdBy || 'someone'} added ${name} to ${orgId} as ${role}`);
  return { id, username: name, orgRole: role, orgAccess: access, temporaryPassword: password };
}

/**
 * A new organization with its first admin. It starts the way a sign-up does:
 * the starter AI Chatbots and the Chat app, in the admin's name.
 */
export async function createOrg({ name, adminUsername, createdBy }) {
  const orgName = String(name || '').trim().slice(0, 80);
  if (!orgName) throw fail('An organization needs a name.', 'BAD_NAME');
  cleanUsername(adminUsername);
  const [taken] = await sql`select 1 as x from users where username = ${String(adminUsername).trim()}`;
  if (taken) throw fail(`The username "${String(adminUsername).trim()}" is taken.`, 'TAKEN', 409);

  const orgId = `org-${crypto.randomUUID()}`;
  await sql`insert into organizations (id, name, created_by) values (${orgId}, ${orgName}, ${createdBy || null})`;
  let admin;
  try {
    admin = await createMember({ orgId, username: adminUsername, orgRole: 'admin', createdBy });
  } catch (err) {
    await sql`delete from organizations where id = ${orgId}`.catch(() => {});
    throw err;
  }
  await seedDefaultAgents(admin.id);
  await seedDefaultApp(admin.id);
  return { id: orgId, name: orgName, admin };
}

export async function listMembers(orgId) {
  return sql`
    select u.id, u.username, u.org_role, u.org_access, u.must_change_password,
           u.created_at, u.last_login_at, u.is_admin,
           (select count(*)::int from access_grants g where g.user_id = u.id) as grants
    from users u
    where u.org_id = ${orgId}
    order by (u.org_role = 'admin') desc, u.created_at
  `;
}

async function memberOf(orgId, userId) {
  const [row] = await sql`
    select id, username, org_role, org_access, is_admin from users
    where id = ${userId} and org_id = ${orgId}
  `;
  return row || null;
}

async function adminCount(orgId) {
  const [{ n }] = await sql`select count(*)::int as n from users where org_id = ${orgId} and org_role = 'admin'`;
  return n;
}

/** Role and org-wide reach. An organization never loses its last admin. */
export async function updateMember({ orgId, userId, orgRole, orgAccess }) {
  const target = await memberOf(orgId, userId);
  if (!target) throw fail('No such member.', 'NO_MEMBER', 404);
  const role = orgRole === undefined ? target.org_role : (orgRole === 'admin' ? 'admin' : 'member');
  if (target.org_role === 'admin' && role !== 'admin' && (await adminCount(orgId)) <= 1) {
    throw fail('An organization needs at least one admin.', 'LAST_ADMIN', 409);
  }
  const access = role === 'admin' ? 'edit'
    : (orgAccess === undefined ? target.org_access : (LEVELS.includes(orgAccess) ? orgAccess : 'none'));
  await sql`update users set org_role = ${role}, org_access = ${access} where id = ${userId}`;
  return { id: userId, username: target.username, orgRole: role, orgAccess: access };
}

/** A new temporary password, to be replaced at the next sign-in. */
export async function resetPassword({ orgId, userId }) {
  const target = await memberOf(orgId, userId);
  if (!target) throw fail('No such member.', 'NO_MEMBER', 404);
  const password = temporaryPassword();
  await sql`update users set password_hash = ${hashPassword(password)}, must_change_password = true where id = ${userId}`;
  return { id: userId, username: target.username, temporaryPassword: password };
}

/**
 * Removes a person and keeps their work: what they were responsible for — and
 * the spend recorded against them — passes to `heirId`, an admin of the same
 * organization. Deleting a person never deletes an AI Chatbot.
 */
export async function removeMember({ orgId, userId, heirId }) {
  const target = await memberOf(orgId, userId);
  if (!target) throw fail('No such member.', 'NO_MEMBER', 404);
  if (target.is_admin) throw fail('The platform admin cannot be removed here.', 'PLATFORM_ADMIN', 409);
  if (target.org_role === 'admin' && (await adminCount(orgId)) <= 1) {
    throw fail('An organization needs at least one admin. Make someone else admin first.', 'LAST_ADMIN', 409);
  }
  let heir = heirId && heirId !== userId ? await memberOf(orgId, heirId) : null;
  if (!heir || heir.org_role !== 'admin') {
    [heir] = await sql`
      select id from users where org_id = ${orgId} and org_role = 'admin' and id <> ${userId}
      order by created_at limit 1
    `;
  }
  if (!heir) throw fail('No admin left to take over this member\'s work.', 'LAST_ADMIN', 409);

  await sql`update agents      set user_id = ${heir.id} where user_id = ${userId}`;
  await sql`update data_tables set user_id = ${heir.id} where user_id = ${userId}`;
  await sql`update apps        set user_id = ${heir.id} where user_id = ${userId}`;
  await sql`update automations set user_id = ${heir.id} where user_id = ${userId}`;
  await sql`update claude_usage set user_id = ${heir.id} where user_id = ${userId}`;
  await sql`delete from users where id = ${userId}`;
  return { id: userId, username: target.username, heir: heir.id };
}

/**
 * Removes an organization and everything in it: its AI Chatbots, their
 * conversations and documents, its tables, apps and people.
 */
export async function deleteOrg(orgId) {
  await sql`delete from whatsapp_messages where agent_id in (select id from agents where org_id = ${orgId})`;
  await sql`delete from agents where org_id = ${orgId}`;
  await sql`delete from organizations where id = ${orgId}`;
}

/* ─────────────────── what each member reaches ─────────────────── */

/** Every item in the organization, by kind, with what one member reaches. */
export async function accessMap(orgId, userId) {
  const target = await memberOf(orgId, userId);
  if (!target) throw fail('No such member.', 'NO_MEMBER', 404);
  const [agents, tables, apps, automations, grants] = await Promise.all([
    sql`select id, data->>'name' as name from agents where org_id = ${orgId} order by created_at`,
    sql`select id, name from data_tables where org_id = ${orgId} order by created_at`,
    sql`select id, data->>'name' as name, slug from apps where org_id = ${orgId} order by created_at`,
    sql`select id, data->>'name' as name from automations where org_id = ${orgId} order by created_at`,
    sql`select kind, item_id, level from access_grants where user_id = ${userId}`,
  ]);
  const grant = new Map(grants.map(g => [`${g.kind}:${g.item_id}`, g.level]));
  const isAdmin = target.org_role === 'admin';
  const shape = (kind) => (r) => {
    const own = grant.get(`${kind}:${r.id}`) || null;
    return { kind, id: r.id, name: r.name || r.slug || '', grant: own,
             level: isAdmin ? 'edit' : (own || target.org_access) };
  };
  return {
    member: { id: target.id, username: target.username, orgRole: target.org_role, orgAccess: target.org_access },
    items: [...agents.map(shape('agent')), ...tables.map(shape('table')), ...apps.map(shape('app')),
            ...automations.map(shape('automation'))],
  };
}

/** One override; `level: null` removes it and the org-wide level applies again. */
export async function setGrant({ orgId, userId, kind, itemId, level, grantedBy }) {
  if (!KINDS.includes(kind)) throw fail('Unknown kind of item.', 'BAD_KIND');
  if (level !== null && !LEVELS.includes(level)) throw fail('The level is none, view or edit.', 'BAD_LEVEL');
  if (!(await memberOf(orgId, userId))) throw fail('No such member.', 'NO_MEMBER', 404);
  const [item] = kind === 'agent'
    ? await sql`select id from agents where id = ${itemId} and org_id = ${orgId}`
    : kind === 'table'
      ? await sql`select id from data_tables where id = ${itemId} and org_id = ${orgId}`
      : kind === 'automation'
        ? await sql`select id from automations where id = ${itemId} and org_id = ${orgId}`
        : await sql`select id from apps where id = ${itemId} and org_id = ${orgId}`;
  if (!item) throw fail('No such item in this organization.', 'NO_ITEM', 404);

  if (level === null) {
    await sql`delete from access_grants where user_id = ${userId} and kind = ${kind} and item_id = ${itemId}`;
  } else {
    await sql`
      insert into access_grants (user_id, kind, item_id, level, granted_by)
      values (${userId}, ${kind}, ${itemId}, ${level}, ${grantedBy || null})
      on conflict (user_id, kind, item_id) do update set level = excluded.level, granted_by = excluded.granted_by
    `;
  }
  return { userId, kind, itemId, level };
}

/** The status and message for an error thrown here. */
export function errorReply(res, err) {
  if (err && err.status) return res.status(err.status).json({ error: err.message, code: err.code });
  return res.status(500).json({ error: err.message });
}

/**
 * The organization a request may manage: the caller's own, when they are its
 * admin; any, when they are the platform admin and name one with ?org=.
 * Answers 401/403 itself and returns null when there is none.
 */
export async function manageableOrg(req, res) {
  const { checkAuth } = await import('./_auth.js');
  const { member, isOrgAdmin } = await import('./_access.js');
  const user = checkAuth(req, res);
  if (!user) return null;
  const me = await member(user);
  if (!me) { res.status(401).json({ error: 'unauthorized' }); return null; }
  const asked = (req.query && req.query.org) || null;
  if (asked && asked !== me.orgId) {
    if (!me.isPlatformAdmin) { res.status(403).json({ error: 'Not your organization.' }); return null; }
    if (!(await getOrg(asked))) { res.status(404).json({ error: 'No such organization.' }); return null; }
    return { me, orgId: asked };
  }
  if (!isOrgAdmin(me) && !me.isPlatformAdmin) {
    res.status(403).json({ error: 'Only the organization\'s admin can manage its people.' });
    return null;
  }
  return { me, orgId: me.orgId };
}
