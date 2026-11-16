/**
 * Connections: the accounts an organization links for its automations.
 *
 * Tokens are encrypted before they are stored (AES-256-GCM). The key comes
 * from CONNECTIONS_KEY when it is set, and otherwise is derived from
 * JWT_SECRET — so there is nothing extra to configure, and a database dump on
 * its own does not hand anyone a mailbox.
 *
 * Nothing here ever returns a token to a screen: `listConnections` gives the
 * name, the kind and the account, and `useConnection` — for the server's own
 * use when a step runs — is the only way to the rest.
 */
import crypto from 'crypto';
import { sql } from './_db.js';
import { jwtSecret } from './_auth.js';

export const KINDS = {
  gmail:     { label: 'Gmail' },
  microsoft: { label: 'Microsoft 365' },
  whatsapp:  { label: 'WhatsApp number' },
};

const fail = (message, code, status = 400) => Object.assign(new Error(message), { code, status });

/* ─────────────────── keeping tokens ─────────────────── */

const key = () => crypto.createHash('sha256')
  .update(process.env.CONNECTIONS_KEY || `${jwtSecret()}:connections`).digest();

export function seal(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${body.toString('base64url')}`;
}

export function unseal(sealed) {
  const [v, iv, tag, body] = String(sealed || '').split('.');
  if (v !== 'v1' || !iv || !tag || !body) throw fail('This connection\'s stored permission cannot be read. Connect it again.', 'UNREADABLE');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8'));
  } catch {
    throw fail('This connection\'s stored permission cannot be read. Connect it again.', 'UNREADABLE');
  }
}

/* A state value for an OAuth round trip: signed, and good for ten minutes. */
const stateKey = () => crypto.createHash('sha256').update(`${jwtSecret()}:connection-state`).digest();
export function signState(data) {
  const payload = Buffer.from(JSON.stringify({ ...data, connection: true, exp: Date.now() + 10 * 60 * 1000 })).toString('base64url');
  return `${payload}.${crypto.createHmac('sha256', stateKey()).update(payload).digest('base64url')}`;
}
export function readState(state) {
  try {
    const [payload, sig] = String(state || '').split('.');
    const want = crypto.createHmac('sha256', stateKey()).update(payload).digest('base64url');
    if (!sig || sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.connection && data.exp > Date.now() ? data : null;
  } catch { return null; }
}

/* ─────────────────── the list ─────────────────── */

const cleanName = (name) => String(name || '').trim().replace(/\s+/g, ' ').slice(0, 60);

const shape = (r) => ({ id: r.id, kind: r.kind, name: r.name, account: r.account, problem: r.problem || null,
                        createdAt: r.created_at, ...(r.kind === 'whatsapp' ? { numberId: (r.data || {}).numberId } : {}) });

export async function listConnections(orgId) {
  if (!orgId) return [];
  const rows = await sql`select * from connections where org_id = ${orgId} order by kind, lower(name)`;
  return rows.map(shape);
}

async function nameFree(orgId, name, exceptId = null) {
  const [taken] = await sql`select id from connections where org_id = ${orgId} and lower(name) = lower(${name}) and id <> ${exceptId || ''}`;
  if (taken) throw fail(`There is already a connection called "${name}". Give this one another name.`, 'NAME_TAKEN', 409);
}

/** Stores an account connected through OAuth; connecting the same name again replaces it. */
export async function saveOAuthConnection({ orgId, userId, kind, name, account, tokens }) {
  const clean = cleanName(name) || account;
  const data = { sealed: seal(tokens) };
  const [existing] = await sql`select id, kind from connections where org_id = ${orgId} and lower(name) = lower(${clean})`;
  if (existing && existing.kind !== kind) throw fail(`"${clean}" is already the name of another kind of connection.`, 'NAME_TAKEN', 409);
  if (existing) {
    await sql`update connections set account = ${account}, data = ${JSON.stringify(data)}::jsonb, problem = null, updated_at = now() where id = ${existing.id}`;
    return existing.id;
  }
  const id = crypto.randomUUID();
  await sql`
    insert into connections (id, org_id, kind, name, account, data, created_by)
    values (${id}, ${orgId}, ${kind}, ${clean}, ${account}, ${JSON.stringify(data)}::jsonb, ${userId || null})
  `;
  return id;
}

/** Lets automations send from a linked number. The number must be the organization's. */
export async function createWhatsAppConnection({ orgId, userId, name, numberId }) {
  const [number] = await sql`
    select n.id, n.label, n.phone from wa_numbers n join users u on u.id = n.owner_user_id
    where n.id = ${String(numberId || '')} and u.org_id = ${orgId}
  `;
  if (!number) throw fail('That WhatsApp number is not one of this organization\'s.', 'NO_NUMBER', 404);
  const clean = cleanName(name) || number.label || number.phone || 'WhatsApp';
  await nameFree(orgId, clean);
  const [dup] = await sql`select id from connections where org_id = ${orgId} and kind = 'whatsapp' and data->>'numberId' = ${number.id}`;
  if (dup) throw fail('That number is already connected for automations.', 'ALREADY', 409);
  const id = crypto.randomUUID();
  await sql`
    insert into connections (id, org_id, kind, name, account, data, created_by)
    values (${id}, ${orgId}, 'whatsapp', ${clean}, ${number.phone ? `+${number.phone}` : (number.label || '')},
            ${JSON.stringify({ numberId: number.id })}::jsonb, ${userId || null})
  `;
  return id;
}

export async function renameConnection({ orgId, id, name }) {
  const clean = cleanName(name);
  if (!clean) throw fail('A connection needs a name.', 'BAD_NAME');
  await nameFree(orgId, clean, id);
  const [row] = await sql`update connections set name = ${clean}, updated_at = now() where id = ${id} and org_id = ${orgId} returning id`;
  if (!row) throw fail('No such connection.', 'NOT_FOUND', 404);
  return { id, name: clean };
}

export async function deleteConnection({ orgId, id }) {
  const [row] = await sql`delete from connections where id = ${id} and org_id = ${orgId} returning id`;
  if (!row) throw fail('No such connection.', 'NOT_FOUND', 404);
  return { ok: true };
}

/* ─────────────────── using one ─────────────────── */

/**
 * The connection an automation's step named, for the server to act with.
 *
 * `kinds` is what the step can work with; a name that is some other kind of
 * connection is refused with words that say so.
 */
export async function useConnection({ orgId, name, kinds }) {
  const wanted = String(name || '').trim();
  if (!wanted) throw fail('pick a connection', 'NO_CONNECTION');
  const [row] = await sql`select * from connections where org_id = ${orgId} and (lower(name) = lower(${wanted}) or id = ${wanted})`;
  if (!row) throw fail(`there is no connection called "${wanted}" — add it under Connections`, 'NO_CONNECTION');
  if (kinds && !kinds.includes(row.kind)) {
    throw fail(`"${row.name}" is a ${KINDS[row.kind] ? KINDS[row.kind].label : row.kind} connection, which this step cannot use`, 'WRONG_KIND');
  }
  return row;
}

async function markProblem(id, problem) {
  await sql`update connections set problem = ${problem}, updated_at = now() where id = ${id}`.catch(() => {});
}

const PROVIDERS = {
  gmail: {
    tokenUrl: 'https://oauth2.googleapis.com/token',
    client: () => ({ id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET }),
  },
  microsoft: {
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    client: () => ({ id: process.env.MICROSOFT_CLIENT_ID, secret: process.env.MICROSOFT_CLIENT_SECRET }),
  },
};

/**
 * A token that works right now for a Gmail or Microsoft connection, renewed
 * if the stored one has run out. A permission the provider has withdrawn is
 * written on the connection, so the Connections screen says which one to
 * connect again instead of every step failing without a reason.
 */
export async function accessToken(row, { fetchImpl = fetch } = {}) {
  const provider = PROVIDERS[row.kind];
  if (!provider) throw fail('this connection has no mailbox behind it', 'WRONG_KIND');
  const tokens = unseal((row.data || {}).sealed);
  if (tokens.access_token && tokens.expires_at > Date.now() + 60 * 1000) return tokens.access_token;
  if (!tokens.refresh_token) {
    await markProblem(row.id, 'Its permission has run out. Connect it again.');
    throw fail(`the connection "${row.name}" has run out of permission — connect it again under Connections`, 'TOKEN_EXPIRED');
  }
  const client = provider.client();
  const res = await fetchImpl(provider.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: client.id || '', client_secret: client.secret || '',
                                refresh_token: tokens.refresh_token, grant_type: 'refresh_token' }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const gone = data.error === 'invalid_grant';
    const why = gone
      ? (row.kind === 'gmail'
          ? 'Google has withdrawn its permission. Connect it again. If this happens every week, the Google Cloud project\'s consent screen is still in "Testing", where permission lasts 7 days.'
          : 'Microsoft has withdrawn its permission. Connect it again.')
      : (data.error_description || data.error || 'The permission could not be renewed.');
    if (gone) await markProblem(row.id, why);
    throw fail(`the connection "${row.name}" could not be used — ${why}`, gone ? 'TOKEN_EXPIRED' : 'REFRESH_FAILED');
  }
  const next = { ...tokens, access_token: data.access_token,
                 refresh_token: data.refresh_token || tokens.refresh_token,
                 expires_at: Date.now() + (data.expires_in || 3600) * 1000 };
  await sql`update connections set data = ${JSON.stringify({ sealed: seal(next) })}::jsonb, problem = null, updated_at = now() where id = ${row.id}`;
  return next.access_token;
}

/* ─────────────────── connecting: the OAuth round trip ─────────────────── */

export const GOOGLE_SCOPES = 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly email';
export const MICROSOFT_SCOPES = 'offline_access User.Read Mail.Send Mail.Read';

/** Where to send the browser to connect an account; throws if the provider is not set up. */
export function authorizeUrl({ provider, appUrl, state }) {
  if (provider === 'gmail') {
    if (!process.env.GOOGLE_CLIENT_ID) throw fail('Google sign-in is not configured on this installation (GOOGLE_CLIENT_ID).', 'NOT_CONFIGURED', 500);
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID);
    /* The address Google already knows for this project: the Gmail callback
       sees the state is a connection's and hands it over. */
    url.searchParams.set('redirect_uri', `${appUrl}/api/gmail/callback`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', GOOGLE_SCOPES);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('state', state);
    return url.toString();
  }
  if (provider === 'microsoft') {
    if (!process.env.MICROSOFT_CLIENT_ID) {
      throw fail('Microsoft 365 is not configured on this installation yet. It needs MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET from an app registered in Microsoft Entra.', 'NOT_CONFIGURED', 500);
    }
    const url = new URL('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    url.searchParams.set('client_id', process.env.MICROSOFT_CLIENT_ID);
    url.searchParams.set('redirect_uri', `${appUrl}/api/connections/callback`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('response_mode', 'query');
    url.searchParams.set('scope', MICROSOFT_SCOPES);
    url.searchParams.set('prompt', 'select_account');
    url.searchParams.set('state', state);
    return url.toString();
  }
  throw fail('Unknown kind of account.', 'BAD_KIND');
}

/** Trades the code a provider sent back for tokens, and stores the connection. */
export async function finishOAuth({ provider, code, appUrl, state, fetchImpl = fetch }) {
  const isGoogle = provider === 'gmail';
  const client = PROVIDERS[provider].client();
  const res = await fetchImpl(PROVIDERS[provider].tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: client.id || '', client_secret: client.secret || '', grant_type: 'authorization_code',
      redirect_uri: isGoogle ? `${appUrl}/api/gmail/callback` : `${appUrl}/api/connections/callback`,
      ...(isGoogle ? {} : { scope: MICROSOFT_SCOPES }),
    }),
  });
  const tokens = await res.json().catch(() => ({}));
  if (!res.ok) throw fail(tokens.error_description || tokens.error || 'The provider did not accept the sign-in.', 'EXCHANGE_FAILED');

  const who = await fetchImpl(isGoogle ? 'https://www.googleapis.com/oauth2/v2/userinfo' : 'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName',
                              { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  const profile = await who.json().catch(() => ({}));
  const account = (isGoogle ? profile.email : (profile.mail || profile.userPrincipalName)) || '';

  return saveOAuthConnection({
    orgId: state.orgId, userId: state.userId, kind: provider, name: state.name, account,
    tokens: { access_token: tokens.access_token, refresh_token: tokens.refresh_token || '',
              expires_at: Date.now() + (tokens.expires_in || 3600) * 1000 },
  });
}
