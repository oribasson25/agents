/**
 * Who may do what to an AI Chatbot, a Table, an App or an Automation.
 *
 * Everything belongs to an organization, and the answer for one person and one
 * item is a level: 'none', 'view' or 'edit'.
 *
 *   the platform admin (users.is_admin)   edit, anywhere
 *   another organization's item           none
 *   the organization's admin              edit
 *   a member                              the grant for that item if there is
 *                                         one, else their org-wide org_access
 *
 * A grant replaces org_access rather than adding to it, so "edits everything
 * except the price list" is as easy to say as "sees nothing except the sales
 * chatbot".
 *
 * The person is read from the database on every request, not from the JWT: a
 * role taken away has to stop working now, not when the token expires.
 */
import { sql } from './_db.js';

export const LEVELS = ['none', 'view', 'edit'];
export const KINDS = ['agent', 'table', 'app', 'automation'];
const TABLE_OF = { agent: 'agents', table: 'data_tables', app: 'apps', automation: 'automations' };

const RANK = { none: 0, view: 1, edit: 2 };
export const allows = (level, need) => RANK[level || 'none'] >= RANK[need];

/** A tagged refusal: view access, asked to write. Handlers answer it with 403. */
export class ReadOnlyError extends Error {
  constructor(what = 'this') {
    super(`You can view ${what} but not change it.`);
    this.code = 'READ_ONLY';
  }
}

/**
 * One account as the database holds it now, or null. The same statement serves
 * member() and the session check in _auth.js (requireSession), so a token and
 * the person behind it are judged against one read.
 */
export async function personRow(userId) {
  const [row] = await sql`
    select u.id, u.username, u.is_admin, u.org_id, u.org_role, u.org_access,
           u.must_change_password, o.name as org_name, u.token_version
    from users u left join organizations o on o.id = u.org_id
    where u.id = ${userId}
  `;
  return row || null;
}

/*
 * `user` is a verified session token when checkAuth marked it (viaSession) or it
 * carries `exp`/`tv`, a personal access token when `viaToken`, and otherwise an id the
 * platform looked up itself (sessionInfo, a webhook, a cron).
 */
const fromSessionToken = (user) => !!user.viaSession || user.exp !== undefined || user.tv !== undefined;

/**
 * The person behind a request, as the database knows them now.
 *
 * For a request's own token it also decides whether that token still stands:
 * one signed before the account's token_version was raised (a password reset
 * or change) is no one, and so is anyone still holding a temporary password,
 * who may do nothing but replace it (/api/me, which does not come through
 * here with a token). Handlers answer null with 401/404, which is right for
 * both.
 */
export async function member(user) {
  /* The platform acting on its own behalf — a git push arriving through the
     webhook, which GitHub has already authorised. It may touch any item. */
  if (user && user.system) {
    return { userId: user.userId || null, username: 'system', isPlatformAdmin: true, orgId: null,
             orgName: '', orgRole: 'admin', orgAccess: 'edit', mustChangePassword: false };
  }
  if (!user || !user.userId) return null;
  const row = await personRow(user.userId);
  if (!row) return null;
  if (fromSessionToken(user) && (Number(row.token_version) || 0) !== (Number(user.tv) || 0)) return null;
  if ((fromSessionToken(user) || user.viaToken) && row.must_change_password) return null;
  return {
    userId: row.id,
    username: row.username,
    isPlatformAdmin: !!row.is_admin,
    orgId: row.org_id,
    orgName: row.org_name || '',
    orgRole: row.org_role === 'admin' ? 'admin' : 'member',
    orgAccess: LEVELS.includes(row.org_access) ? row.org_access : 'none',
    mustChangePassword: !!row.must_change_password,
  };
}

export const isOrgAdmin = (me) => !!me && me.orgRole === 'admin';

/** Making new things is for the organization's admin and its org-wide editors. */
export const canCreate = (me) => !!me && (me.isPlatformAdmin || isOrgAdmin(me) || me.orgAccess === 'edit');

/** The level for one item whose organization and grant are already known. */
export function levelFor(me, itemOrgId, grant) {
  if (!me) return 'none';
  if (me.isPlatformAdmin) return 'edit';
  if (!itemOrgId || itemOrgId !== me.orgId) return 'none';
  if (isOrgAdmin(me)) return 'edit';
  return LEVELS.includes(grant) ? grant : me.orgAccess;
}

/**
 * One item: its level for this person, and the row it was decided on.
 * `me` may be passed in when the caller already has it.
 */
export async function accessTo(user, kind, itemId, me) {
  const who = me || await member(user);
  if (!who || !TABLE_OF[kind] || !itemId) return { level: 'none', me: who, item: null };
  const id = String(itemId);
  const grant = (i) => sql`select level from access_grants where user_id = ${who.userId} and kind = ${kind} and item_id = ${i}`;
  const [item] = kind === 'agent'
    ? await sql`select id, org_id, user_id from agents where id = ${id}`
    : kind === 'table'
      ? await sql`select id, org_id, user_id from data_tables where id = ${id}`
      : kind === 'automation'
        ? await sql`select id, org_id, user_id from automations where id = ${id}`
        : await sql`select id, org_id, user_id from apps where id = ${id} or slug = ${id}`;
  if (!item) return { level: 'none', me: who, item: null };
  const needsGrant = !who.isPlatformAdmin && item.org_id === who.orgId && !isOrgAdmin(who);
  item.grant_level = needsGrant ? ((await grant(item.id))[0] || {}).level : undefined;
  return { level: levelFor(who, item.org_id, item.grant_level), me: who, item };
}

/**
 * Every grant one person holds for one kind, as id → level. List endpoints
 * read the organization's items once and filter them with levelFor.
 */
export async function grantsOf(me, kind) {
  if (!me || me.isPlatformAdmin || isOrgAdmin(me)) return new Map();
  const rows = await sql`select item_id, level from access_grants where user_id = ${me.userId} and kind = ${kind}`;
  return new Map(rows.map(r => [r.item_id, r.level]));
}

/** Keeps the rows this person may see, each marked with its level as `_access`. */
export async function visible(me, kind, rows, orgOf = (r) => r.org_id, idOf = (r) => r.id) {
  const grants = await grantsOf(me, kind);
  return rows
    .map(r => ({ row: r, level: levelFor(me, orgOf(r), grants.get(idOf(r))) }))
    .filter(x => x.level !== 'none');
}

/** The answer a handler gives when access falls short. */
export function refuse(res, level, what = 'that') {
  if (level === 'view') return res.status(403).json({ error: `You can view ${what} but not change it.`, code: 'READ_ONLY' });
  return res.status(404).json({ error: 'Not found' });
}
