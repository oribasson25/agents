import crypto from 'crypto';
import { sql } from './_db.js';

/**
 * Invitation codes.
 *
 * Sign-up is invitation only: the login screen has no way to create an
 * account, and this is the only thing that opens one. An admin mints a code,
 * hands it over, and the person holding it can register once.
 *
 * The code is stored the way a password is — only its hash. The plain text
 * exists for the length of one response and is never recoverable, so an admin
 * who loses one mints another and revokes the first. What is kept in clear is
 * the first four characters, which is enough to recognise a row in the list as
 * the code somebody is holding and not enough to guess the rest.
 */

/* No 0/O and no 1/I/L: the code gets read out over the phone, and a pair that
   looks alike on a screen sounds alike down a line. 31 characters over 12
   places is about 59 bits, which is far past guessable at one HTTP request a
   go. */
export const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const LENGTH = 12;
export const DEFAULT_DAYS = 14;

/** `9KMX-3BTR-6WQH`. Grouped for reading aloud; the groups are cosmetic. */
export function generateCode() {
  let out = '';
  /* randomInt rather than a byte modulo: 256 does not divide 31, and the
     remainder would make the first few letters of the alphabet likelier. */
  for (let i = 0; i < LENGTH; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return formatCode(out);
}

export function formatCode(raw) {
  return String(raw || '').replace(/(.{4})(?=.)/g, '$1-');
}

/**
 * What the person typed, reduced to what was minted.
 *
 * Case, spaces and dashes are all noise — people retype a code with the
 * dashes in the wrong places, or in lower case, or pasted with a trailing
 * space, and every one of those is the right code.
 */
export function normalizeCode(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Well-formed on its face — worth a database round trip. */
export function looksLikeCode(input) {
  const code = normalizeCode(input);
  return code.length === LENGTH && [...code].every(c => ALPHABET.includes(c));
}

/** Plain sha256, as with the access tokens: this is 59 random bits, not a password. */
export function hashCode(input) {
  return crypto.createHash('sha256').update(normalizeCode(input)).digest('hex');
}

/** 'open' | 'used' | 'revoked' | 'expired' — one word for what became of it. */
export function inviteState(row, at = new Date()) {
  if (!row) return 'unknown';
  if (row.used_at) return 'used';
  if (row.revoked_at) return 'revoked';
  if (new Date(row.expires_at) <= at) return 'expired';
  return 'open';
}

/** What to tell somebody standing at the door with a code that will not work. */
export function refusal(state) {
  switch (state) {
    case 'used':    return 'This code has already been used. Ask for a new one.';
    case 'revoked': return 'This code was cancelled. Ask for a new one.';
    case 'expired': return 'This code has expired. Ask for a new one.';
    default:        return 'That code is not valid. Check it and try again.';
  }
}

export async function createInvite(adminUserId, days = DEFAULT_DAYS) {
  const code = generateCode();
  const id = crypto.randomUUID();
  const ttl = Number.isFinite(+days) && +days > 0 ? Math.min(Math.round(+days), 365) : DEFAULT_DAYS;
  const [row] = await sql`
    insert into invite_codes (id, code_hash, prefix, created_by, expires_at)
    values (${id}, ${hashCode(code)}, ${normalizeCode(code).slice(0, 4)}, ${adminUserId},
            now() + make_interval(days => ${ttl}))
    returning id, prefix, created_at, expires_at, revoked_at, used_at, used_by
  `;
  /* The only moment the plain code exists. */
  return { code, invite: row };
}

export async function listInvites() {
  return sql`
    select i.id, i.prefix, i.created_at, i.expires_at, i.revoked_at, i.used_at,
           u.username as used_by_username,
           a.username as created_by_username
    from invite_codes i
    left join users u on u.id = i.used_by
    left join users a on a.id = i.created_by
    order by i.created_at desc
    limit 200
  `;
}

export async function revokeInvite(id) {
  const [row] = await sql`
    update invite_codes set revoked_at = now()
    where id = ${id} and used_at is null and revoked_at is null
    returning id
  `;
  return !!row;
}

/** Is this code still good? Says nothing and changes nothing if it is not. */
export async function checkInvite(input) {
  if (!looksLikeCode(input)) return { ok: false, reason: refusal('unknown') };
  const [row] = await sql`
    select id, expires_at, revoked_at, used_at from invite_codes where code_hash = ${hashCode(input)}
  `;
  const state = row ? inviteState(row) : 'unknown';
  return state === 'open' ? { ok: true, id: row.id } : { ok: false, reason: refusal(state) };
}

/**
 * Take the code out of circulation, or say why it cannot be taken.
 *
 * The `used_at is null` in the WHERE is the whole point: two people racing the
 * same code both reach this statement, and Postgres lets exactly one of them
 * change the row. Checking first and updating second would let both through.
 *
 * `used_by` is filled in afterwards, once the account it belongs to exists —
 * the column is a foreign key, and there is no user to point at yet.
 */
export async function claimInvite(input) {
  if (!looksLikeCode(input)) return { ok: false, reason: refusal('unknown') };
  const hash = hashCode(input);
  const [claimed] = await sql`
    update invite_codes set used_at = now()
    where code_hash = ${hash}
      and used_at is null
      and revoked_at is null
      and expires_at > now()
    returning id
  `;
  if (claimed) return { ok: true, id: claimed.id };

  /* It did not change — find out whether that is because the code does not
     exist or because it was already spent, so the answer names the reason. */
  const [row] = await sql`select id, expires_at, revoked_at, used_at from invite_codes where code_hash = ${hash}`;
  return { ok: false, reason: refusal(row ? inviteState(row) : 'unknown') };
}

/** Hand the code back, after the registration it was claimed for fell over. */
export async function releaseInvite(id) {
  await sql`update invite_codes set used_at = null, used_by = null where id = ${id}`;
}

export async function attachInviteUser(id, userId) {
  await sql`update invite_codes set used_by = ${userId} where id = ${id}`;
}
