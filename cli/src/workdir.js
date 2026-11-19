/**
 * The agent folder on disk, and what changed in it.
 *
 * `.8legs/lock.json` remembers the exact bytes of every file as it was pulled.
 * That is what makes `status` honest without a second round trip, and what
 * lets `push` send the version the edit was based on so the server can refuse
 * a push that would overwrite someone else's change.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const LOCK = path.join('.8legs', 'lock.json');

const hash = (content) => crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);

/**
 * A segment no file from the platform may have: git's own folder and ours.
 *
 * Checked the way filesystems compare names, not the way strings do: any case
 * (`.GIT` is `.git` on macOS and Windows), trailing dots and spaces (Windows
 * drops them), Unicode compatibility forms, NTFS streams (`.git::$INDEX_ALLOCATION`)
 * and 8.3 short names (`GIT~1`). A `.git/config` written by a pull runs its
 * `core.fsmonitor` command the next time anything runs `git status` here.
 */
export function reservedSegment(segment) {
  const name = String(segment).normalize('NFKC').toLowerCase().replace(/[. ]+$/, '');
  if (name.includes(':')) return true;
  if (name === '.git' || name === '.8legs') return true;
  if (/^git~\d+$/.test(name) || /^8legs~\d+$/.test(name)) return true;
  return false;
}

/** Refuses to escape the agent folder, or to touch git's or our own files — a path from the server is not trusted. */
export function safeJoin(root, rel) {
  const base = path.resolve(root);
  const segments = String(rel).split(/[\\/]+/);
  if (!rel || String(rel).includes('\u0000') || segments.some(reservedSegment)) {
    throw Object.assign(new Error(`Refusing to write a reserved path: ${rel}`), { friendly: true });
  }
  const full = path.resolve(base, rel);
  if (full === base || !full.startsWith(base + path.sep)) {
    throw Object.assign(new Error(`Refusing to write outside the agent folder: ${rel}`), { friendly: true });
  }
  return full;
}

export function writeTree(root, files) {
  /* Every path is checked before the first byte is written: a tree with one
     bad path is refused whole, not half written. */
  const targets = Object.entries(files).map(([rel, content]) => [safeJoin(root, rel), content]);
  for (const [full, content] of targets) {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

/**
 * Makes the folder hold `files`: the one way pull, checkout and rollback
 * change a checkout. A file this checkout wrote before (`previous`, from the
 * lock) that the platform no longer has is deleted — through the same checks
 * as a write, so a lock or a server cannot point a delete outside the folder
 * or into .git.
 */
export function syncTree(root, previous, files) {
  const doomed = Object.keys(previous || {}).filter(rel => !(rel in files)).map(rel => safeJoin(root, rel));
  for (const rel of Object.keys(files)) safeJoin(root, rel);
  for (const full of doomed) { try { fs.unlinkSync(full); } catch { /* already gone */ } }
  writeTree(root, files);
}

/* ── what a push sends ── */

/** A .gitignore pattern as a test on a folder-relative path. Enough of git's rules for what people write. */
function ignoreRule(line) {
  let pat = line.trim();
  if (!pat || pat.startsWith('#') || pat.startsWith('!')) return null;
  const dirOnly = pat.endsWith('/');
  pat = pat.replace(/\/+$/, '');
  const anchored = pat.includes('/');
  pat = pat.replace(/^\//, '');
  const rx = new RegExp('^' + pat.split('**').map(part => part
    .replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')).join('.*') + '$');
  return (rel, isDir) => {
    if (dirOnly && !isDir) return false;
    if (anchored) return rx.test(rel);
    return rx.test(rel.split('/').pop());
  };
}

function ignoreRules(root) {
  try {
    return fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/).map(ignoreRule).filter(Boolean);
  } catch { return []; }
}

/**
 * Every file in the folder that is the agent's (or app's): not git's or our
 * bookkeeping, nothing .gitignore leaves out, and no dotfile but .gitignore
 * itself — a `.env` next to the code is never sent to the platform, and a
 * public app would otherwise serve it.
 */
export function readTree(root) {
  const files = {};
  const base = path.resolve(root);
  const rules = ignoreRules(base);
  const skip = new Set(['.git', '.8legs', 'node_modules', '__pycache__', '.DS_Store']);
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(base, full).split(path.sep).join('/');
      const isDir = entry.isDirectory();
      if (entry.name.startsWith('.') && !(rel === '.gitignore' && !isDir)) continue;
      if (rules.some(rule => rule(rel, isDir))) continue;
      if (isDir) walk(full);
      else if (entry.isFile()) files[rel] = fs.readFileSync(full, 'utf8');
    }
  })(base);
  return files;
}

export function writeLock(root, { agentId, appId, automationId, kind, branch, version, host, files }) {
  const dir = path.join(root, '.8legs');
  fs.mkdirSync(dir, { recursive: true });
  const lock = {
    /* `kind` is absent in folders pulled before apps existed: those are agents. */
    ...(kind === 'app' ? { kind: 'app', appId } : kind === 'automation' ? { kind: 'automation', automationId } : { agentId }),
    branch, version, host,
    pulledAt: new Date().toISOString(),
    files: Object.fromEntries(Object.entries(files).map(([p, c]) => [p, hash(c)])),
  };
  fs.writeFileSync(path.join(root, LOCK), JSON.stringify(lock, null, 2) + '\n');
  return lock;
}

export function readLock(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, LOCK), 'utf8')); }
  catch { return null; }
}

/** Walks up from cwd to find the agent folder, so commands work in a subdirectory. */
export function findRoot(from = process.cwd()) {
  let dir = path.resolve(from);
  for (;;) {
    if (fs.existsSync(path.join(dir, LOCK))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function changes(root, lock) {
  const current = readTree(root);
  const was = lock.files || {};
  const added = [], modified = [], deleted = [];
  for (const [p, content] of Object.entries(current)) {
    if (!(p in was)) added.push(p);
    else if (was[p] !== hash(content)) modified.push(p);
  }
  for (const p of Object.keys(was)) if (!(p in current)) deleted.push(p);
  return { added: added.sort(), modified: modified.sort(), deleted: deleted.sort(), files: current };
}
