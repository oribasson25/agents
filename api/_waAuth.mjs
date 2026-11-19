import { BufferJSON, initAuthCreds, proto } from 'baileys';
import { sql } from './_db.js';
import { seal, unseal } from './_connections.js';

/*
 * A linked device's credentials and Signal keys, kept in Postgres so any worker
 * session can pick the connection up where the last one left it. Same contract
 * as Baileys' useMultiFileAuthState, plus flush() to await outstanding writes —
 * the session must not hand over before its last key write has landed — and
 * close(), after which nothing more is written (the keys are about to go).
 *
 * Whoever holds these keys holds the WhatsApp account, so they are stored
 * sealed with the same AES-256-GCM key as the organization's connection
 * tokens (_connections.js). Rows written before that are plain JSON and are
 * still read; each is sealed the next time Baileys writes it.
 *
 * Writes go out one after another, in the order Baileys made them: two saves
 * of the creds racing each other could leave the older one in the database.
 */

const CREDS = 'creds';
const keyName = (type, id) => `${type}:${id}`;
const encode = (value) => seal(JSON.stringify(value, BufferJSON.replacer));
const SEALED = /^v1\./;
/* A value sealed under another key (JWT_SECRET or CONNECTIONS_KEY changed) reads as
   missing: the number then shows as unlinked and is linked again with a QR code. */
const decode = (raw) => {
  if (raw == null) return null;
  try {
    const text = SEALED.test(raw) ? unseal(raw) : raw;
    return JSON.parse(text, BufferJSON.reviver);
  } catch (err) {
    console.warn('[wa] a stored WhatsApp key could not be read:', err.message);
    return null;
  }
};

/** True when a phone has linked this number (not just a QR waiting to be scanned). */
export async function isLinked(numberId) {
  const [row] = await sql`select v from wa_auth where number_id = ${numberId} and k = ${CREDS}`;
  return !!decode(row?.v)?.me;
}

export async function usePostgresAuthState(numberId) {
  let chain = Promise.resolve();
  let closed = false;
  /* One write at a time; a failed one is logged and does not stop the next. */
  const enqueue = (work) => {
    if (closed) return Promise.resolve();
    const next = chain.then(() => (closed ? undefined : work()));
    chain = next.catch((err) => console.warn(`[wa ${numberId}] key write failed:`, err.message));
    return next;
  };

  const [credsRow] = await sql`select v from wa_auth where number_id = ${numberId} and k = ${CREDS}`;
  const creds = decode(credsRow?.v) || initAuthCreds();

  const put = (k, v) => sql`
    insert into wa_auth (number_id, k, v) values (${numberId}, ${k}, ${v})
    on conflict (number_id, k) do update set v = excluded.v
  `;

  return {
    state: {
      creds,
      keys: {
        async get(type, ids) {
          if (!ids.length) return {};
          const names = ids.map((id) => keyName(type, id));
          const rows = await sql`select k, v from wa_auth where number_id = ${numberId} and k = any(${names})`;
          const byKey = new Map(rows.map((r) => [r.k, r.v]));
          const data = {};
          for (const id of ids) {
            let value = decode(byKey.get(keyName(type, id)));
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            data[id] = value;
          }
          return data;
        },
        async set(data) {
          const upKeys = [];
          const upVals = [];
          const delKeys = [];
          for (const type in data) {
            for (const id in data[type]) {
              const value = data[type][id];
              if (value) {
                upKeys.push(keyName(type, id));
                upVals.push(encode(value));
              } else {
                delKeys.push(keyName(type, id));
              }
            }
          }
          if (!upKeys.length && !delKeys.length) return;
          await enqueue(async () => {
            if (upKeys.length) {
              await sql`
                insert into wa_auth (number_id, k, v)
                select ${numberId}, k, v from unnest(${upKeys}::text[], ${upVals}::text[]) as t(k, v)
                on conflict (number_id, k) do update set v = excluded.v
              `;
            }
            if (delKeys.length) await sql`delete from wa_auth where number_id = ${numberId} and k = any(${delKeys})`;
          });
        },
      },
    },
    /* The creds are encoded when the write runs, so the newest state is what lands. */
    saveCreds: () => enqueue(() => put(CREDS, encode(creds))),
    flush: () => chain,
    close: () => { closed = true; },
  };
}

export async function clearAuth(numberId) {
  await sql`delete from wa_auth where number_id = ${numberId}`;
}
