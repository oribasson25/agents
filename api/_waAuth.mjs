import { BufferJSON, initAuthCreds, proto } from 'baileys';
import { sql } from './_db.js';

/*
 * A linked device's credentials and Signal keys, kept in Postgres so any worker
 * session can pick the connection up where the last one left it. Same contract
 * as Baileys' useMultiFileAuthState, plus flush() to await outstanding writes —
 * the session must not hand over before its last key write has landed.
 */

const CREDS = 'creds';
const keyName = (type, id) => `${type}:${id}`;
const encode = (value) => JSON.stringify(value, BufferJSON.replacer);
const decode = (raw) => (raw == null ? null : JSON.parse(raw, BufferJSON.reviver));

/** True when a phone has linked this number (not just a QR waiting to be scanned). */
export async function isLinked(numberId) {
  const [row] = await sql`select v from wa_auth where number_id = ${numberId} and k = ${CREDS}`;
  return !!decode(row?.v)?.me;
}

export async function usePostgresAuthState(numberId) {
  const pending = new Set();
  const track = (promise) => {
    pending.add(promise);
    promise.finally(() => pending.delete(promise)).catch(() => {});
    return promise;
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
          const work = [];
          if (upKeys.length) {
            work.push(sql`
              insert into wa_auth (number_id, k, v)
              select ${numberId}, k, v from unnest(${upKeys}::text[], ${upVals}::text[]) as t(k, v)
              on conflict (number_id, k) do update set v = excluded.v
            `);
          }
          if (delKeys.length) {
            work.push(sql`delete from wa_auth where number_id = ${numberId} and k = any(${delKeys})`);
          }
          if (work.length) await track(Promise.all(work));
        },
      },
    },
    saveCreds: () => track(put(CREDS, encode(creds))),
    flush: () => Promise.allSettled([...pending]),
  };
}

export async function clearAuth(numberId) {
  await sql`delete from wa_auth where number_id = ${numberId}`;
}
