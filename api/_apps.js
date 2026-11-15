/**
 * Apps in the database: the live app, its versions, and who may open it.
 *
 * `apps.data` is what is served. Every change to it also lands in
 * `app_versions`, so "live" is always a copy of one version and going back is
 * copying an older one over it — never a rebuild, never a half state.
 */
import crypto from 'crypto';
import { sql } from './_db.js';
import { jwtSecret } from './_auth.js';
import { appVersion, starterFiles, linkId } from './_appFiles.js';
import { accessTo, allows, member, visible, ReadOnlyError } from './_access.js';

const VIEW_TTL = 12 * 60 * 60;   /* a private link stays good for half a day */

/** A URL-safe address from a name; Hebrew and other scripts fall back to `app`. */
export function slugFrom(name) {
  const base = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return base || 'app';
}

/** The organization's apps this person may see, each with `_access`. */
export async function listApps(user) {
  const me = await member(user);
  if (!me) return [];
  const rows = await sql`
    select id, org_id, data, updated_at,
           (select count(*)::int from app_versions v where v.app_id = apps.id) as versions
    from apps where org_id = ${me.orgId}
    order by updated_at desc
  `;
  /* The list never carries the files: an organization's apps can be megabytes. */
  return (await visible(me, 'app', rows)).map(({ row: r, level }) => {
    const { files, ...rest } = r.data;
    return { ...rest, fileCount: Object.keys(files || {}).length, versions: r.versions,
             updatedAt: r.updated_at, _access: level };
  });
}

/**
 * The app, by id or by slug, if the caller may see it; null when not.
 * `need: 'edit'` from someone who may only look throws ReadOnlyError.
 */
export async function loadApp({ appId, user, need = 'view' }) {
  const { level, item } = await accessTo(user, 'app', appId);
  if (!item || !allows(level, 'view')) return null;
  if (need === 'edit' && !allows(level, 'edit')) throw new ReadOnlyError('this app');
  const [row] = await sql`select data, user_id, org_id, active_version_id from apps where id = ${item.id}`;
  if (!row) return null;
  return { app: row.data, ownerId: row.user_id, orgId: row.org_id, activeVersionId: row.active_version_id,
           version: appVersion(row.data), access: level };
}

/** The app as anyone may ask for it: by its address, with its owner. */
export async function loadAppBySlug(slug) {
  const [row] = await sql`select data, user_id, org_id from apps where slug = ${slug}`;
  return row ? { app: row.data, ownerId: row.user_id, orgId: row.org_id } : null;
}

export async function loadAppById(id) {
  const [row] = await sql`select data, user_id, org_id from apps where id = ${id}`;
  return row ? { app: row.data, ownerId: row.user_id, orgId: row.org_id } : null;
}

/**
 * A new app. With no `files` it gets the starter page; the default app every
 * account is handed passes its own, and the AI Chatbots it links.
 *
 * `uniqueSlug` always adds a piece of the id: an app every account receives
 * must not hand its plain name (/a/chat/) to whoever happened to sign up first.
 */
export async function createApp({ user, name, description, files, agents, tables, uniqueSlug = false, message = 'Created' }) {
  const clean = String(name || '').trim().slice(0, 80);
  if (!clean) throw Object.assign(new Error('An app needs a name'), { code: 'BAD_NAME' });
  const id = crypto.randomUUID();

  /* The slug is global — it is a URL on the platform — so a taken one gets a
     short piece of the id rather than an error nobody can act on. */
  let slug = slugFrom(clean);
  const [taken] = uniqueSlug ? [true] : await sql`select 1 as x from apps where slug = ${slug}`;
  if (taken || slug === 'app') slug = `${slug}-${id.slice(0, 6)}`;

  const app = {
    id, slug, name: clean,
    description: String(description || '').trim().slice(0, 400),
    entry: 'index.html', agents: agents || {}, tables: tables || {},
    access: 'private',
    files: files || starterFiles(clean),
    createdAt: new Date().toISOString(),
  };
  await sql`
    insert into apps (id, user_id, slug, data)
    values (${id}, ${user.userId}, ${slug}, ${JSON.stringify(app)}::jsonb)
  `;
  await recordVersion({ appId: id, user, data: app, source: 'ui', message });
  return app;
}

async function recordVersion({ appId, user, data, source, commitSha = null, message = '' }) {
  const id = crypto.randomUUID();
  const { access, ...content } = data;
  const [row] = await sql`
    insert into app_versions (id, app_id, number, data, source, commit_sha, message, created_by)
    values (${id}, ${appId},
            (select coalesce(max(number), 0) + 1 from app_versions where app_id = ${appId}),
            ${JSON.stringify(content)}::jsonb, ${source}, ${commitSha},
            ${String(message || '').slice(0, 200)}, ${user.userId})
    returning number
  `;
  await sql`update apps set active_version_id = ${id} where id = ${appId}`;
  return { id, number: row ? row.number : null };
}

/**
 * Makes `data` the live app and keeps it as a version.
 *
 * Content that did not change writes nothing: a pull followed by a push with
 * no edit, or a settings save that only touched `access`, is not a version.
 */
export async function saveApp({ appId, user, data, source = 'ui', commitSha, message }) {
  const current = await loadApp({ appId, user, need: 'edit' });
  if (!current) return null;
  const next = { ...data, id: current.app.id, slug: current.app.slug,
                 createdAt: current.app.createdAt, access: data.access || current.app.access || 'private' };
  const changed = appVersion(next) !== current.version;
  await sql`
    update apps set data = ${JSON.stringify(next)}::jsonb, updated_at = now()
    where id = ${current.app.id}
  `;
  const made = changed
    ? await recordVersion({ appId: current.app.id, user, data: next, source, commitSha, message })
    : null;
  return { app: next, version: appVersion(next), versionNumber: made ? made.number : null, changed };
}

export async function listVersions({ appId, user }) {
  const current = await loadApp({ appId, user });
  if (!current) return null;
  const rows = await sql`
    select id, number, source, commit_sha, message, created_at
    from app_versions where app_id = ${current.app.id}
    order by number desc limit 100
  `;
  return rows.map(r => ({ ...r, active: r.id === current.activeVersionId }));
}

/** Puts an earlier version back in front of people. Nothing is deleted. */
export async function activateVersion({ appId, user, versionId }) {
  const current = await loadApp({ appId, user, need: 'edit' });
  if (!current) return null;
  const [row] = await sql`
    select id, number, data from app_versions
    where app_id = ${current.app.id} and (id = ${versionId} or number::text = ${String(versionId)})
  `;
  if (!row) throw Object.assign(new Error('No such version'), { code: 'NO_VERSION' });
  const next = { ...row.data, id: current.app.id, slug: current.app.slug,
                 createdAt: current.app.createdAt, access: current.app.access || 'private' };
  await sql`
    update apps set data = ${JSON.stringify(next)}::jsonb, active_version_id = ${row.id}, updated_at = now()
    where id = ${current.app.id}
  `;
  return { app: next, version: appVersion(next), versionNumber: row.number };
}

export async function deleteApp({ appId, user }) {
  const current = await loadApp({ appId, user, need: 'edit' });
  if (!current) return null;
  await sql`delete from apps where id = ${current.app.id}`;
  return { ok: true };
}

/**
 * The AI Chatbots and Tables an app names must be in its organization.
 *
 * Checked when the app is saved, and again when it runs: an id in app.json is
 * only a claim, and a claim on somebody else's table must open nothing.
 */
export async function linkProblems(app, ownerId) {
  const problems = [];
  const agentIds = Object.values(app.agents || {}).map(linkId);
  const tableIds = Object.values(app.tables || {}).map(linkId);
  if (agentIds.length) {
    const rows = await sql`select id from agents where org_id = (select org_id from users where id = ${ownerId}) and id = any(${agentIds})`;
    const mine = new Set(rows.map(r => r.id));
    for (const [alias, target] of Object.entries(app.agents)) {
      if (!mine.has(linkId(target))) problems.push(`app.json: agents.${alias} is not one of your AI Chatbots`);
    }
  }
  if (tableIds.length) {
    const rows = await sql`select id from data_tables where org_id = (select org_id from users where id = ${ownerId}) and id = any(${tableIds})`;
    const mine = new Set(rows.map(r => r.id));
    for (const [alias, target] of Object.entries(app.tables)) {
      if (!mine.has(linkId(target))) problems.push(`app.json: tables.${alias} is not one of your Tables`);
    }
  }
  return problems;
}

/* ─────────────────── opening an app ─────────────────── */

/*
 * A view token is signed with its own key, derived from the session key.
 *
 * It travels in a URL and is handed to the app's page, so it must be worth
 * nothing anywhere else — signed with the session key itself, it would pass
 * for a login.
 */
const viewKey = () => crypto.createHash('sha256').update(`${jwtSecret()}:app-view`).digest();
const viewSig = (body) => crypto.createHmac('sha256', viewKey()).update(body).digest('base64url');

/** A link to a private app, good for a while and for that app only. */
export function viewToken(appId, userId) {
  const body = Buffer.from(JSON.stringify({
    appId, userId, exp: Math.floor(Date.now() / 1000) + VIEW_TTL })).toString('base64url');
  return `${body}.${viewSig(body)}`;
}

export function checkViewToken(token, appId) {
  try {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return false;
    const want = viewSig(body);
    if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return false;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    return payload.appId === appId && payload.exp > Math.floor(Date.now() / 1000);
  } catch { return false; }
}

/** May this request open the app? Public ones always; private ones with a link. */
export function mayOpen(app, token) {
  return app.access === 'link' || checkViewToken(token, app.id);
}

/** Where the app is served. Private apps carry their token in the path, so
    every relative file the page asks for arrives with it. */
export function appUrl(app, user) {
  return app.access === 'link' || !user
    ? `/a/${app.slug}/`
    : `/a/${app.slug}/~${viewToken(app.id, user.userId)}/`;
}
