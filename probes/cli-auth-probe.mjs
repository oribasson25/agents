/**
 * Every endpoint the CLI calls has to accept a personal access token.
 *
 * This exists because it did not. `/api/agents` used checkAuth, which only
 * knows JWTs, so `8legs login` — which calls it to check the token it was just
 * handed — rejected every token there has ever been. Nothing else caught it:
 * the endpoint was fine, the token was fine, and the two were never tried
 * together.
 */
import fs from 'fs';
import path from 'path';
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

/* The paths the CLI actually asks for, read out of its own source. */
const source = ['bin/8legs.js', 'src/api.js', 'src/config.js', 'src/workdir.js']
  .map(f => fs.readFileSync(path.join(ROOT, 'cli', f), 'utf8')).join('\n');

const called = new Set();

/*
 * Template holes can nest and can contain backticks of their own
 * (`/files${branch ? `?branch=...` : ''}`), so they are collapsed innermost
 * first with a marker before anything is matched as a path.
 */
const HOLE = '\u0000';
let flat = source;
for (let before = ''; before !== flat; ) { before = flat; flat = flat.replace(/\$\{[^{}]*\}/g, HOLE); }

for (const m of flat.matchAll(/api\(\s*[`'"]([^`'"]*)/g)) {
  const route = m[1]
    .split('?')[0]
    /* A marker glued to a path segment is a query or a suffix, not a segment. */
    .replace(new RegExp(`([^/])${HOLE}`, 'g'), '$1')
    .replace(new RegExp(`/${HOLE}`, 'g'), '/:id')
    .replace(/\/+$/, '');
  if (route.startsWith('/api/')) called.add(route);
}

/* Where each of those lives on disk. */
function fileFor(route) {
  const parts = route.replace(/^\/api\//, '').split('/');
  const candidates = [];
  const build = (i, acc) => {
    if (i === parts.length) {
      candidates.push(path.join(ROOT, 'api', ...acc) + '.js');
      candidates.push(path.join(ROOT, 'api', ...acc, 'index.js'));
      return;
    }
    build(i + 1, [...acc, parts[i]]);
    if (parts[i] === ':id') build(i + 1, [...acc, '[id]']);
    if (parts[i] === ':id') build(i + 1, [...acc, '[agentId]']);
  };
  build(0, []);
  return candidates.find(fs.existsSync) || null;
}

let failed = 0;
console.log(`the CLI calls ${called.size} endpoint(s)\n`);
for (const route of [...called].sort()) {
  const file = fileFor(route);
  if (!file) { console.log(`✗ ${route}\n    no handler found on disk`); failed++; continue; }
  const body = fs.readFileSync(file, 'utf8');
  const ok = /checkAuthOrToken\s*\(/.test(body);
  const rel = path.relative(ROOT, file);
  console.log(`${ok ? '✓' : '✗'} ${route}  ${rel}${ok ? '' : '\n    uses checkAuth — a personal access token cannot reach it'}`);
  if (!ok) failed++;
}

console.log(`\n${failed ? `${failed} FAILURE(S)` : 'all green'}`);
process.exit(failed ? 1 : 0);
