#!/usr/bin/env node
/**
 * 8legs — edit an agent in your own editor, then push it to the platform.
 *
 * Run `8legs` with no arguments for the command list.
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { api, session, ApiError } from '../src/api.js';
import { readConfig, writeConfig, clearConfig, configPath, DEFAULT_HOST } from '../src/config.js';
import { writeTree, writeLock, readLock, findRoot, changes } from '../src/workdir.js';

const C = process.stdout.isTTY
  ? { dim: s => `\x1b[2m${s}\x1b[0m`, bold: s => `\x1b[1m${s}\x1b[0m`, green: s => `\x1b[32m${s}\x1b[0m`,
      red: s => `\x1b[31m${s}\x1b[0m`, yellow: s => `\x1b[33m${s}\x1b[0m`, cyan: s => `\x1b[36m${s}\x1b[0m` }
  : new Proxy({}, { get: () => (s => s) });

const argv = process.argv.slice(2);
const flags = {};
const args = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const [k, inline] = argv[i].slice(2).split('=');
    flags[k] = inline !== undefined ? inline : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
  } else args.push(argv[i]);
}

const die = (msg) => { console.error(C.red('✗ ') + msg); process.exit(1); };

/**
 * Asks a question, optionally without echoing the answer.
 *
 * The muting goes through readline's own output hook. An earlier version
 * cleared and redrew the line on every `data` event instead, which printed the
 * prompt twice and made a paste impossible to read back.
 */
function ask(question, { hidden = false } = {}) {
  /* Piped input: read the line, do not try to be interactive about it. */
  if (!process.stdin.isTTY) {
    return new Promise(resolve => {
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', c => { buf += c; });
      process.stdin.on('end', () => resolve(buf.split('\n')[0].trim()));
    });
  }
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(question, answer => {
      rl.muted = false;
      if (hidden) process.stdout.write('\n');
      rl.close();
      resolve(answer.trim());
    });
    /* Set after question() so the prompt itself still prints. */
    rl.muted = hidden;
    rl._writeToOutput = (str) => { if (!rl.muted) rl.output.write(str); };
  });
}

/** The agent folder for commands that need one. */
function requireRoot() {
  const root = findRoot();
  if (!root) die('Not inside an agent folder. Run `8legs pull <agent>` first.');
  return { root, lock: readLock(root) };
}

/* ─────────────────── commands ─────────────────── */

const commands = {};

commands.login = async () => {
  const host = flags.host || DEFAULT_HOST;
  let token = typeof flags.token === 'string' ? flags.token.trim() : '';
  if (!token) {
    console.log(`Create a token at ${C.cyan(`${host}/#settings`)} → Personal access tokens.\n`);
    token = await ask('Paste your token: ', { hidden: true });
  }
  if (!token) die('No token given.');
  if (!token.startsWith('8legs_pat_')) {
    die('That does not look like a personal access token — they start with `8legs_pat_`.\n' +
        `  Create one at ${host}/#settings → Personal access tokens.`);
  }

  const agents = await api('/api/agents', { token, host }).catch(e => {
    if (e.status === 401) {
      die('That token was not accepted.\n' +
          '  It may have been revoked, or copied incompletely — it is only shown once,\n' +
          `  so if in doubt create a fresh one at ${host}/#settings`);
    }
    throw e;
  });
  writeConfig({ ...readConfig(), token, host });
  console.log(C.green('✓ ') + `Logged in to ${host}. ${agents.length} agent(s) available.`);
  console.log(C.dim(`  Stored in ${configPath}`));
};

commands.logout = async () => { clearConfig(); console.log(C.green('✓ ') + 'Logged out.'); };

commands.whoami = async () => {
  const { host } = session();
  const agents = await api('/api/agents');
  console.log(`${host} — ${agents.length} agent(s)`);
};

commands.list = async () => {
  const agents = await api('/api/agents');
  if (!agents.length) return console.log('No agents yet.');
  const width = Math.max(...agents.map(a => (a.name || '').length));
  for (const a of agents) {
    console.log(`  ${(a.name || '(unnamed)').padEnd(width)}  ${C.dim(a.id)}`);
  }
  console.log(C.dim(`\n  8legs pull ${agents[0].id}`));
};

commands.pull = async () => {
  const wanted = args[1];
  const existing = !wanted ? requireRoot() : null;
  let agentId = existing ? existing.lock.agentId : wanted;

  if (wanted && !/^[0-9a-f-]{36}$/i.test(wanted)) {
    const agents = await api('/api/agents');
    const matches = agents.filter(a => (a.name || '').toLowerCase() === wanted.toLowerCase());
    if (!matches.length) die(`No agent called "${wanted}". Try \`8legs list\`.`);
    if (matches.length > 1) die(`More than one agent is called "${wanted}". Use its id:\n` +
      matches.map(a => `  ${a.id}`).join('\n'));
    agentId = matches[0].id;
  }

  const branch = flags.branch || (existing ? existing.lock.branch : null);
  const pulled = await api(`/api/agents/${agentId}/files${branch ? `?branch=${encodeURIComponent(branch)}` : ''}`);
  const root = existing ? existing.root
    : path.resolve(flags.dir || slug(pulled.files) || `agent-${agentId.slice(0, 8)}`);

  if (existing) {
    const local = changes(root, existing.lock);
    const dirty = [...local.added, ...local.modified, ...local.deleted];
    if (dirty.length && !flags.force) {
      die(`You have local changes that a pull would overwrite:\n` +
          dirty.map(p => `  ${p}`).join('\n') + `\n\nPush them first, or pull with --force.`);
    }
  } else if (fs.existsSync(root) && fs.readdirSync(root).length) {
    die(`${root} already exists and is not empty. Use --dir to choose another folder.`);
  }

  writeTree(root, pulled.files);
  writeLock(root, { agentId, branch: pulled.branch, version: pulled.version,
                    host: session().host, files: pulled.files });
  const count = Object.keys(pulled.files).length;
  console.log(C.green('✓ ') + `Pulled ${count} files into ${C.bold(path.relative(process.cwd(), root) || '.')}`);
  console.log(C.dim(`  ${pulled.branch} · ${pulled.version}`));
  if (pulled.git) {
    console.log(C.dim(`  git  ${pulled.git.cloneUrl}`));
    if (!fs.existsSync(path.join(root, '.git'))) {
      console.log(C.dim('       run `8legs git` to work with git as well as the CLI'));
    }
  }
};

/** The agent's own folder name, taken from the config it just sent. */
function slug(files) {
  try { return JSON.parse(files['config.json']).profile.name || null; } catch { return null; }
}

commands.status = async () => {
  const { root, lock } = requireRoot();
  const { added, modified, deleted } = changes(root, lock);
  console.log(`${C.bold(lock.branch || 'main')}  ${C.dim(lock.agentId)}`);

  const remote = await api(
    `/api/agents/${lock.agentId}/files?branch=${encodeURIComponent(lock.branch || 'main')}`).catch(() => null);
  if (remote && remote.version !== lock.version) {
    console.log(C.yellow('  ! ') + 'The agent changed on the platform since you pulled.');
    console.log(C.dim('    Run `8legs pull` to take those changes first.'));
  }

  if (!added.length && !modified.length && !deleted.length) return console.log(C.dim('  nothing changed locally'));
  for (const p of modified) console.log(`  ${C.yellow('M')} ${p}`);
  for (const p of added) console.log(`  ${C.green('A')} ${p}`);
  for (const p of deleted) console.log(`  ${C.red('D')} ${p}`);
};

commands.diff = async () => {
  const { root, lock } = requireRoot();
  const pulled = await api(
    `/api/agents/${lock.agentId}/files?branch=${encodeURIComponent(lock.branch || 'main')}`);
  const { added, modified, deleted, files } = changes(root, lock);
  const only = args[1];

  for (const p of [...modified, ...added, ...deleted]) {
    if (only && p !== only) continue;
    console.log(C.bold(`\n── ${p}`));
    const before = (pulled.files[p] || '').split('\n');
    const after = (files[p] || '').split('\n');
    for (const line of lineDiff(before, after)) {
      console.log(line.startsWith('+') ? C.green(line) : line.startsWith('-') ? C.red(line) : C.dim(line));
    }
  }
  if (!modified.length && !added.length && !deleted.length) console.log(C.dim('nothing changed locally'));
};

/** A plain longest-common-subsequence diff, with three lines of context. */
function lineDiff(a, b) {
  const n = a.length, m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);

  const rows = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { rows.push(['  ', a[i]]); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { rows.push(['- ', a[i++]]); }
    else { rows.push(['+ ', b[j++]]); }
  }
  while (i < n) rows.push(['- ', a[i++]]);
  while (j < m) rows.push(['+ ', b[j++]]);

  const keep = new Set();
  rows.forEach((r, idx) => { if (r[0] !== '  ') for (let k = idx - 3; k <= idx + 3; k++) keep.add(k); });
  const out = [];
  let skipped = 0;
  rows.forEach((r, idx) => {
    if (!keep.has(idx)) { skipped++; return; }
    if (skipped) { out.push(`  … ${skipped} unchanged line(s)`); skipped = 0; }
    out.push(r[0] + r[1]);
  });
  return out;
}

commands.validate = async () => {
  const { root, lock } = requireRoot();
  const { files } = changes(root, lock);
  const problems = validateTree(files);
  if (!problems.length) return console.log(C.green('✓ ') + 'The agent folder looks valid.');
  for (const p of problems) console.log(C.red('  ✗ ') + p);
  process.exit(1);
};

/** The checks the server will run, run here first so the answer is instant. */
export function validateTree(files) {
  const problems = [];
  const parse = (p) => {
    if (files[p] === undefined) { problems.push(`${p} is missing`); return null; }
    try { return JSON.parse(files[p]); } catch (e) { problems.push(`${p}: ${e.message}`); return null; }
  };
  const config = parse('config.json');
  if (config && !config.profile?.id) problems.push('config.json: profile.id is required');
  if (files['prompt.md'] === undefined) problems.push('prompt.md is missing');

  for (const p of Object.keys(files)) {
    if (p.startsWith('skills/') && p.endsWith('/skill.json')) {
      const dir = p.slice(0, -'/skill.json'.length);
      const sk = parse(p);
      if (!sk) continue;
      if (!sk.id) problems.push(`${p}: id is required`);
      const prompt = `${dir}/${sk.prompts?.skill || 'prompts/skill.md'}`;
      if (files[prompt] === undefined) problems.push(`${prompt} is missing (referenced by ${p})`);
    }
    if (p.startsWith('tools/') && p.endsWith('/tool.json')) {
      const dir = p.slice(0, -'/tool.json'.length);
      const tl = parse(p);
      if (!tl) continue;
      if (!tl.id) problems.push(`${p}: id is required`);
      if (files[`${dir}/run.py`] === undefined) problems.push(`${dir}/run.py is missing`);
    }
  }
  return problems;
}

commands.push = async () => {
  const { root, lock } = requireRoot();
  const { added, modified, deleted, files } = changes(root, lock);
  if (!added.length && !modified.length && !deleted.length) return console.log('Nothing to push.');

  const problems = validateTree(files);
  if (problems.length) {
    console.log(C.red('Refusing to push — the folder is not valid:'));
    for (const p of problems) console.log(C.red('  ✗ ') + p);
    process.exit(1);
  }

  let result;
  try {
    result = await api(`/api/agents/${lock.agentId}/files?branch=${encodeURIComponent(lock.branch || 'main')}`,
                       { method: 'PUT', body: { baseVersion: lock.version, files } });
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      die('The agent changed on the platform since you pulled.\n' +
          '  Run `8legs pull` to take those changes, redo your edit, and push again.');
    }
    if (e instanceof ApiError && e.status === 422) {
      console.log(C.red('The platform rejected these files:'));
      for (const p of e.body.errors || [e.message]) console.log(C.red('  ✗ ') + p);
      process.exit(1);
    }
    throw e;
  }

  writeLock(root, { agentId: lock.agentId, branch: result.branch, version: result.version,
                    host: lock.host, files });
  const n = added.length + modified.length + deleted.length;
  console.log(C.green('✓ ') + `Pushed ${n} change(s) to ${C.bold(result.branch)}`);
  console.log(C.dim(`  ${result.version}`));
};

/**
 * Connects the folder to its repository.
 *
 * Deliberately a command rather than something `pull` does by itself: running
 * `git init` inside a folder someone just downloaded, without being asked,
 * is the kind of surprise that costs trust.
 */
commands.git = async () => {
  const { root, lock } = requireRoot();
  const { execFileSync } = await import('child_process');
  const pulled = await api(`/api/agents/${lock.agentId}/files`);
  if (!pulled.git) {
    die('This platform has no GitHub organisation configured, so there is no repository to connect to.');
  }
  const run = (...a) => execFileSync('git', a, { cwd: root, stdio: 'pipe', encoding: 'utf8' }).trim();
  try {
    if (!fs.existsSync(path.join(root, '.git'))) run('init', '-b', lock.branch || 'main');
    const remotes = run('remote').split('\n').filter(Boolean);
    if (remotes.includes('origin')) run('remote', 'set-url', 'origin', pulled.git.cloneUrl);
    else run('remote', 'add', 'origin', pulled.git.cloneUrl);
  } catch (e) {
    die(`git said: ${(e.stderr || e.message).toString().trim()}`);
  }
  console.log(C.green('✓ ') + `origin → ${pulled.git.cloneUrl}`);
  console.log(C.dim('  A `git push` to this remote is applied to the agent, the same as `8legs push`.'));
  console.log(C.dim('  A commit that does not validate is marked failed on GitHub and is not made live.'));
};

commands.branches = async () => {
  const { lock } = requireRoot();
  const { branches } = await api(`/api/agents/${lock.agentId}/branches`);
  const width = Math.max(...branches.map(b => b.name.length));
  for (const b of branches) {
    const here = b.name === (lock.branch || 'main') ? C.cyan(' ←') : '';
    const share = b.traffic_weight ? C.dim(`  ${b.traffic_weight}% of conversations`) : '';
    const kind = b.kind === 'draft' ? C.dim('  (the interface\'s draft)') : b.live ? C.dim('  (live)') : '';
    console.log(`  ${b.name.padEnd(width)}${kind}${share}${here}`);
  }
};

commands.branch = async () => {
  const { root, lock } = requireRoot();
  const name = args[1];
  if (!name) die('Give the branch a name: `8legs branch warmer-tone`');

  const local = changes(root, lock);
  if ([...local.added, ...local.modified, ...local.deleted].length) {
    die('You have uncommitted local changes. Push them, or undo them, before opening a branch.');
  }
  const made = await api(`/api/agents/${lock.agentId}/branches`,
                         { method: 'POST', body: { name, from: lock.branch || 'main' } });
  console.log(C.green('✓ ') + `Opened ${C.bold(made.name)} from ${made.from}`);
  await checkout(root, lock, made.name);
};

commands.checkout = async () => {
  const { root, lock } = requireRoot();
  const name = args[1];
  if (!name) die('Which branch? Try `8legs branches`.');
  const local = changes(root, lock);
  const dirty = [...local.added, ...local.modified, ...local.deleted];
  if (dirty.length && !flags.force) {
    die('Switching would overwrite local changes:\n' + dirty.map(p => `  ${p}`).join('\n') +
        '\n\nPush them first, or switch with --force.');
  }
  await checkout(root, lock, name);
};

/** Replaces the folder's contents with another branch's. */
async function checkout(root, lock, name) {
  let pulled;
  try {
    pulled = await api(`/api/agents/${lock.agentId}/files?branch=${encodeURIComponent(name)}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) die(`No branch called "${name}". Try \`8legs branches\`.`);
    throw e;
  }
  /* Files the other branch does not have would otherwise linger and be read
     as local additions the moment you ran status. */
  for (const rel of Object.keys(lock.files || {})) {
    if (!(rel in pulled.files)) { try { fs.unlinkSync(path.join(root, rel)); } catch {} }
  }
  writeTree(root, pulled.files);
  writeLock(root, { agentId: lock.agentId, branch: pulled.branch, version: pulled.version,
                    host: lock.host, files: pulled.files });
  console.log(C.green('✓ ') + `Now on ${C.bold(pulled.branch)}`);
}

commands.merge = async () => {
  const { lock } = requireRoot();
  const name = args[1] || lock.branch;
  if (!name || name === 'main') die('Name the branch to merge into main.');
  const merged = await api(`/api/agents/${lock.agentId}/branches`,
                           { method: 'POST', body: { action: 'merge', branch: name } });
  console.log(C.green('✓ ') + `Merged ${C.bold(merged.branch)} into main — it is live now.`);
  console.log(C.dim('  Run `8legs checkout main` to follow it.'));
};

commands.traffic = async () => {
  const { lock } = requireRoot();
  if (flags.stop) {
    const stopped = await api(`/api/agents/${lock.agentId}/branches`,
                              { method: 'PUT', body: { action: 'stop' } });
    console.log(C.green('✓ ') + (stopped.stopped.length
      ? `All conversations back to main (was: ${stopped.stopped.join(', ')}).`
      : 'Nothing was taking traffic.'));
    if (stopped.released) console.log(C.dim(`  ${stopped.released} quiet conversation(s) released.`));
    return;
  }
  const name = args[1] || lock.branch;
  const weight = args[2];
  if (weight === undefined) die('How much? `8legs traffic warmer-tone 20`, or `8legs traffic --stop`.');
  const set = await api(`/api/agents/${lock.agentId}/branches`,
                        { method: 'PUT', body: { branch: name, weight: Number(weight) } });
  console.log(C.green('✓ ') + `${set.branch} takes ${set.traffic_weight}% of conversations, main takes ${set.main}%.`);
};

commands.open = async () => {
  const { lock } = requireRoot();
  const url = `${lock.host || DEFAULT_HOST}/#agent/${lock.agentId}`;
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  const { spawn } = await import('child_process');
  spawn(opener, [url], { stdio: 'ignore', detached: true }).unref();
  console.log(url);
};

/* ─────────────────── dispatch ─────────────────── */

const HELP = `
${C.bold('8legs')} — edit an agent in your own editor, then push it

  ${C.bold('8legs login')}              store a personal access token
  ${C.bold('8legs logout')}             forget it
  ${C.bold('8legs list')}               your agents, with their ids

  ${C.bold('8legs pull <agent>')}       download an agent into a folder
  ${C.bold('8legs pull')}               refresh the folder you are in
  ${C.bold('8legs status')}             what changed, here and on the platform
  ${C.bold('8legs diff [file]')}        the changes themselves
  ${C.bold('8legs validate')}           check the folder before pushing
  ${C.bold('8legs push')}               send the changes
  ${C.bold('8legs open')}               open this agent in the browser
  ${C.bold('8legs git')}                point this folder's git remote at the agent

  ${C.bold('8legs branches')}           the branches, and their share of conversations
  ${C.bold('8legs branch <name>')}      open one and switch to it
  ${C.bold('8legs checkout <name>')}    switch to another one
  ${C.bold('8legs merge [name]')}       apply it to main
  ${C.bold('8legs traffic <name> <%>')} send a share of conversations to it
  ${C.bold('8legs traffic --stop')}     all conversations back to main

  ${C.dim('--host <url>')}       talk to a different installation
  ${C.dim('--token <token>')}    log in without being prompted
  ${C.dim('--dir <path>')}       pull into a specific folder
  ${C.dim('--branch <name>')}    pull a branch instead of main
  ${C.dim('--force')}            let pull or checkout overwrite local changes
`;

const name = args[0];
if (!name || name === 'help' || flags.help) { console.log(HELP); process.exit(0); }
if (!commands[name]) { console.error(`Unknown command: ${name}`); console.log(HELP); process.exit(1); }

commands[name]().catch(e => {
  if (e.friendly || e instanceof ApiError) die(e.message);
  die(e.stack || e.message);
});
