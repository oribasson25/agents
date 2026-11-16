/**
 * Module hooks for wa-reconnect-probe: Baileys and Vercel's waitUntil go to
 * wa-stubs.mjs everywhere; the WhatsApp connection and the message router go
 * there only when the worker session asks for them, so the probe can still
 * load the real connection on its own.
 */
const STUBS = new URL('./wa-stubs.mjs', import.meta.url).href;
const SESSION_ONLY = new Set(['./_waConnection.mjs', './_waRouter.mjs']);

export function resolve(specifier, context, next) {
  if (specifier === 'baileys' || specifier === '@vercel/functions') return { url: STUBS, shortCircuit: true };
  if (SESSION_ONLY.has(specifier) && context.parentURL?.endsWith('/api/_waSession.mjs')) return { url: STUBS, shortCircuit: true };
  return next(specifier, context);
}
