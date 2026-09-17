/** Stands in for @neondatabase/serverless: every query goes to globalThis.__db. */
export function neon() {
  return function sql(strings, ...params) {
    const text = Array.isArray(strings) ? strings.join('?') : String(strings);
    const p = Promise.resolve(globalThis.__db(text, params));
    p.catch = Promise.prototype.catch.bind(p);
    return p;
  };
}
export default { neon };
