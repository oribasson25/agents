const STUB = new URL('./neon-stub.mjs', import.meta.url).href;
export function resolve(specifier, context, next) {
  if (specifier === '@neondatabase/serverless') return { url: STUB, shortCircuit: true };
  return next(specifier, context);
}
