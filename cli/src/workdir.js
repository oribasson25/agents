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

/** Refuses to escape the agent folder — a path from the server is not trusted. */
function safeJoin(root, rel) {
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw Object.assign(new Error(`Refusing to write outside the agent folder: ${rel}`), { friendly: true });
  }
  return full;
}

export function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = safeJoin(path.resolve(root), rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

/** Every file in the folder, except git's and our own bookkeeping. */
export function readTree(root) {
  const files = {};
  const skip = new Set(['.git', '.8legs', 'node_modules', '__pycache__', '.DS_Store']);
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[path.relative(root, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf8');
    }
  })(path.resolve(root));
  return files;
}

export function writeLock(root, { agentId, branch, version, host, files }) {
  const dir = path.join(root, '.8legs');
  fs.mkdirSync(dir, { recursive: true });
  const lock = {
    agentId, branch, version, host,
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
