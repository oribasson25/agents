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

/** The agent or app folder for commands that need one. */
function requireRoot() {
  const root = findRoot();
  if (!root) die('Not inside an agent, app or automation folder.\n' +
                 '  Run `8legs pull <agent>`, `8legs pull --app <app>` or `8legs pull --automation <name>` first.');
  return { root, lock: readLock(root) };
}

/**
 * What a folder is a checkout of.
 *
 * An agent and an app are pulled, compared and pushed the same way; only the
 * address on the platform and the checks before a push differ. Everything
 * below asks this instead of knowing which one it has.
 */
function thing(lock) {
  const isApp = lock.kind === 'app';
  const isAutomation = lock.kind === 'automation';
  const id = isApp ? lock.appId : isAutomation ? lock.automationId : lock.agentId;
  const noun = isApp ? 'app' : isAutomation ? 'automation' : 'agent';
  return {
    isApp, isAutomation, id, noun,
    files: (branch) => (isApp ? `/api/apps/${id}/files` : isAutomation ? `/api/automations/${id}/files`
      : `/api/agents/${id}/files` + (branch ? `?branch=${encodeURIComponent(branch)}` : '')),
    lock: (extra) => ({ ...(isApp ? { kind: 'app', appId: id } : isAutomation ? { kind: 'automation', automationId: id } : { agentId: id }), ...extra }),
    validate: isApp ? validateAppTree : isAutomation ? validateAutomationTree : validateTree,
    page: `#${noun}/${id}`,
  };
}

/** Branch commands are an agent's: an app is served from main and has versions. */
function agentOnly(lock, command) {
  if (lock.kind === 'automation') {
    die(`Automations have no branches, so \`8legs ${command}\` does not apply here.\n` +
        '  A push saves the draft; `8legs publish` makes it live, and every publish is a version: `8legs versions`.');
  }
  if (lock.kind === 'app') {
    die(`Apps have no branches, so \`8legs ${command}\` does not apply here.\n` +
        '  Every push is kept as a version: `8legs versions`, and `8legs rollback <n>` to go back.');
  }
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

commands.apps = async () => {
  const apps = await api('/api/apps');
  if (!apps.length) return console.log('No apps yet. Create one in the platform, under Apps.');
  const width = Math.max(...apps.map(a => (a.slug || '').length));
  for (const a of apps) {
    console.log(`  ${(a.slug || '').padEnd(width)}  ${a.name || ''}  ${C.dim(a.access === 'link' ? 'anyone with the link' : 'private')}`);
  }
  console.log(C.dim(`\n  8legs pull --app ${apps[0].slug}`));
};

commands.automations = async () => {
  const list = await api('/api/automations');
  if (!list.length) return console.log('No automations yet. Create one in the platform, under Automations.');
  const width = Math.max(...list.map(a => (a.name || '').length));
  for (const a of list) {
    const state = a.published && a.enabled ? C.green('live') : a.published ? 'off' : 'draft';
    console.log(`  ${(a.name || '').padEnd(width)}  ${String(a.trigger).padEnd(8)}  ${state}${a.published && a.unpublished ? C.yellow('  unpublished changes') : ''}  ${C.dim(a.id)}`);
  }
  console.log(C.dim(`\n  8legs pull --automation ${JSON.stringify(list[0].name)}`));
};

/** An automation by id or name. Null when there is none; dies when ambiguous. */
async function findAutomation(wanted) {
  const list = await api('/api/automations');
  const w = wanted.toLowerCase();
  const exact = list.filter(a => a.id === wanted);
  const matches = exact.length ? exact : list.filter(a => (a.name || '').toLowerCase() === w);
  if (matches.length > 1) die(`More than one automation is called "${wanted}". Use its id:\n` +
    matches.map(a => `  ${a.id}`).join('\n'));
  return matches[0] || null;
}

/** An app by slug, id or name. Null when there is none; dies when ambiguous. */
async function findApp(wanted) {
  const apps = await api('/api/apps');
  const w = wanted.toLowerCase();
  const exact = apps.filter(a => a.id === wanted || (a.slug || '').toLowerCase() === w);
  const matches = exact.length ? exact : apps.filter(a => (a.name || '').toLowerCase() === w);
  if (matches.length > 1) die(`More than one app is called "${wanted}". Use its slug:\n` +
    matches.map(a => `  ${a.slug}`).join('\n'));
  return matches[0] || null;
}

commands.pull = async () => {
  let wanted = args[1];
  /* `--app <name>` and `app:<name>` both say "the app, not the agent". */
  let asApp = false;
  if (typeof flags.app === 'string') { wanted = flags.app; asApp = true; }
  else if (flags.app) asApp = true;
  if (wanted && wanted.startsWith('app:')) { wanted = wanted.slice(4); asApp = true; }
  let asAutomation = false;
  if (typeof flags.automation === 'string') { wanted = flags.automation; asAutomation = true; }
  else if (flags.automation) asAutomation = true;
  if (wanted && wanted.startsWith('automation:')) { wanted = wanted.slice(11); asAutomation = true; }

  const existing = !wanted ? requireRoot() : null;
  let target = existing ? thing(existing.lock) : null;

  if (wanted && asAutomation) {
    const found = await findAutomation(wanted);
    if (!found) die(`No automation called "${wanted}". Try \`8legs automations\`.`);
    target = thing({ kind: 'automation', automationId: found.id });
  } else if (wanted && !asApp && /^[0-9a-f-]{36}$/i.test(wanted)) {
    target = thing({ agentId: wanted });
  } else if (wanted) {
    const agents = asApp ? [] : await api('/api/agents');
    const matches = agents.filter(a => (a.name || '').toLowerCase() === wanted.toLowerCase());
    if (matches.length > 1) die(`More than one agent is called "${wanted}". Use its id:\n` +
      matches.map(a => `  ${a.id}`).join('\n'));
    if (matches.length) target = thing({ agentId: matches[0].id });
    else {
      /* No agent by that name: an app's slug is the next thing it could be. */
      const app = await findApp(wanted);
      if (!app) die(asApp ? `No app called "${wanted}". Try \`8legs apps\`.`
                          : `No agent or app called "${wanted}". Try \`8legs list\` or \`8legs apps\`.`);
      target = thing({ kind: 'app', appId: app.id });
    }
  }

  const branch = flags.branch || (existing ? existing.lock.branch : null);
  const pulled = await api(target.files(branch));
  const root = existing ? existing.root
    : path.resolve(flags.dir || slug(pulled) || `${target.noun}-${target.id.slice(0, 8)}`);

  if (existing) {
    const local = changes(root, existing.lock);
    const dirty = [...local.added, ...local.modified, ...local.deleted];
    if (dirty.length && !flags.force) {
      die(`You have local changes that a pull would overwrite:\n` +
          dirty.map(p => `  ${p}`).join('\n') + `\n\nPush them first, or pull with --force.`);
    }
    /* A file the platform no longer has would otherwise linger and be read
       as a local addition. Only files this checkout itself wrote are removed. */
    for (const rel of Object.keys(existing.lock.files || {})) {
      if (!(rel in pulled.files)) { try { fs.unlinkSync(path.join(root, rel)); } catch {} }
    }
  } else if (fs.existsSync(root) && fs.readdirSync(root).length) {
    die(`${root} already exists and is not empty. Use --dir to choose another folder.`);
  }

  writeTree(root, pulled.files);
  writeLock(root, target.lock({ branch: pulled.branch, version: pulled.version,
                                host: session().host, files: pulled.files }));
  const count = Object.keys(pulled.files).length;
  console.log(C.green('✓ ') + `Pulled ${count} files into ${C.bold(path.relative(process.cwd(), root) || '.')}`);
  console.log(C.dim(`  ${pulled.branch} · ${pulled.version}`));
  if (target.isApp) console.log(C.dim(`  live at ${session().host}/a/${pulled.slug}/  (open it with \`8legs open\`)`));
  if (target.isAutomation) console.log(C.dim('  this is the draft: `8legs push` saves it, `8legs run` tests it, `8legs publish` makes it live'));
  if (pulled.git) {
    console.log(C.dim(`  git  ${pulled.git.cloneUrl}`));
    if (!fs.existsSync(path.join(root, '.git'))) {
      console.log(C.dim('       run `8legs git` to work with git as well as the CLI'));
    }
  }
};

/** The agent's own folder name, taken from the config it just sent. */
function slug(pulled) {
  if (pulled.slug) return pulled.slug;
  if (pulled.automationId) {
    return String(pulled.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || null;
  }
  try { return JSON.parse(pulled.files['config.json']).profile.name || null; } catch { return null; }
}

commands.status = async () => {
  const { root, lock } = requireRoot();
  const { added, modified, deleted } = changes(root, lock);
  const it = thing(lock);
  console.log(`${C.bold(lock.branch || 'main')}  ${C.dim(`${it.noun} ${it.id}`)}`);

  const remote = await api(it.files(lock.branch || 'main')).catch(() => null);
  if (remote && remote.version !== lock.version) {
    console.log(C.yellow('  ! ') + `The ${it.noun} changed on the platform since you pulled.`);
    console.log(C.dim('    Run `8legs pull` to take those changes first.'));
  }

  if (!added.length && !modified.length && !deleted.length) return console.log(C.dim('  nothing changed locally'));
  for (const p of modified) console.log(`  ${C.yellow('M')} ${p}`);
  for (const p of added) console.log(`  ${C.green('A')} ${p}`);
  for (const p of deleted) console.log(`  ${C.red('D')} ${p}`);
};

commands.diff = async () => {
  const { root, lock } = requireRoot();
  const pulled = await api(thing(lock).files(lock.branch || 'main'));
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
  const it = thing(lock);
  const problems = it.validate(files);
  if (!problems.length) return console.log(C.green('✓ ') + `The ${it.noun} folder looks valid.`);
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

/** The same, for an app folder. */
export function validateAppTree(files) {
  const problems = [];
  let config = null;
  if (files['app.json'] === undefined) problems.push('app.json is missing');
  else {
    try { config = JSON.parse(files['app.json']); } catch (e) { problems.push(`app.json: ${e.message}`); }
  }
  if (config) {
    if (!config.id) problems.push('app.json: id is required');
    const entry = config.entry || 'index.html';
    if (files[entry] === undefined) problems.push(`${entry} is missing (app.json names it as the entry)`);
    for (const key of ['agents', 'tables', 'automations']) {
      const links = config[key];
      if (links === undefined) continue;
      if (!links || typeof links !== 'object' || Array.isArray(links)) {
        problems.push(`app.json: ${key} must be an object of name → id`);
        continue;
      }
      for (const [alias, target] of Object.entries(links)) {
        if (!/^[A-Za-z0-9_-]{1,40}$/.test(alias)) problems.push(`app.json: ${key}.${alias} — use letters, digits, - and _ for the name`);
        if (!(typeof target === 'string' ? target : target && target.id)) problems.push(`app.json: ${key}.${alias} needs an id`);
      }
    }
  }
  /* The platform carries text. A binary file read as text would arrive broken. */
  for (const [p, content] of Object.entries(files)) {
    if (content.includes('\u0000')) problems.push(`${p} looks like a binary file; apps carry text files only`);
  }
  return problems;
}

commands.push = async () => {
  const { root, lock } = requireRoot();
  const { added, modified, deleted, files } = changes(root, lock);
  const it = thing(lock);
  const publishing = it.isAutomation && !!flags.publish;
  if (!added.length && !modified.length && !deleted.length) {
    if (publishing) return commands.publish();
    return console.log('Nothing to push.');
  }

  const problems = it.validate(files);
  if (problems.length) {
    console.log(C.red('Refusing to push — the folder is not valid:'));
    for (const p of problems) console.log(C.red('  ✗ ') + p);
    process.exit(1);
  }

  let result;
  try {
    result = await api(it.files(lock.branch || 'main'),
                       { method: 'PUT', body: { baseVersion: lock.version, files, ...(publishing ? { publish: true } : {}) } });
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      die(`The ${it.noun} changed on the platform since you pulled.\n` +
          '  Run `8legs pull` to take those changes, redo your edit, and push again.');
    }
    if (e instanceof ApiError && e.status === 422) {
      console.log(C.red(e.body.saved ? 'Saved as the draft, but not published:' : 'The platform rejected these files:'));
      for (const p of e.body.errors || [e.message]) console.log(C.red('  ✗ ') + p);
      if (e.body.saved) writeLock(root, it.lock({ branch: 'main', version: e.body.version, host: lock.host, files }));
      process.exit(1);
    }
    throw e;
  }

  writeLock(root, it.lock({ branch: result.branch, version: result.version, host: lock.host, files }));
  const n = added.length + modified.length + deleted.length;
  console.log(C.green('✓ ') + `Pushed ${n} change(s) to ${C.bold(result.branch)}`);
  console.log(C.dim(`  ${result.version}`));
  if (it.isApp) {
    console.log(C.dim(result.versionNumber
      ? `  live now, as version ${result.versionNumber}`
      : '  nothing the platform stores changed, so no new version'));
  }
  if (it.isAutomation) {
    for (const w of result.unfinished || []) console.log(C.yellow('  ! ') + w);
    for (const w of result.warnings || []) console.log(C.dim(`  · ${w}`));
    console.log(C.dim(result.published
      ? (result.versionNumber ? `  published, as version ${result.versionNumber}` : '  published')
      : '  saved as the draft — `8legs run` to test it, `8legs publish` to make it live'));
  }
};

/* ─────────────────── an automation: publish and run ─────────────────── */

function automationOnly(lock, command) {
  if (lock.kind !== 'automation') die(`\`8legs ${command}\` is for an automation folder (\`8legs pull --automation <name>\`).`);
}

/** Local edits are not what the platform would run or publish; say so. */
function mustBePushed(root, lock, verb) {
  const local = changes(root, lock);
  const dirty = [...local.added, ...local.modified, ...local.deleted];
  if (dirty.length) {
    die(`You have local changes the platform does not have yet:\n` + dirty.map(p => `  ${p}`).join('\n') +
        `\n\nRun \`8legs push\` first, then ${verb}.`);
  }
}

commands.publish = async () => {
  const { root, lock } = requireRoot();
  automationOnly(lock, 'publish');
  mustBePushed(root, lock, '`8legs publish`');
  let done;
  try {
    done = await api(`/api/automations/${lock.automationId}/publish`, { method: 'POST', body: { message: typeof flags.message === 'string' ? flags.message : undefined } });
  } catch (e) {
    if (e instanceof ApiError && e.status === 422) {
      console.log(C.red('The draft cannot be published yet:'));
      for (const p of e.body.errors || [e.message]) console.log(C.red('  ✗ ') + p);
      process.exit(1);
    }
    throw e;
  }
  console.log(C.green('✓ ') + (done.changed ? `Published as version ${done.versionNumber}.` : 'Already published — nothing changed since.'));
  console.log(C.dim(done.enabled ? '  It is switched on: its trigger fires this version now.'
                                 : '  It is switched off, so its trigger does not fire. Switch it on in the platform.'));
};

const short = (value, max = 220) => {
  const text = value === undefined || value === null ? '' : (typeof value === 'string' ? value : JSON.stringify(value));
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
};

/** Runs the draft once on the platform and prints what every step did. */
commands.run = async () => {
  const { root, lock } = requireRoot();
  automationOnly(lock, 'run');
  mustBePushed(root, lock, '`8legs run`');
  let input = {};
  const raw = typeof flags['input-file'] === 'string' ? fs.readFileSync(path.resolve(flags['input-file']), 'utf8')
            : typeof flags.input === 'string' ? flags.input : null;
  if (raw !== null) {
    try { input = JSON.parse(raw); } catch (e) { die(`The input is not valid JSON: ${e.message}`); }
  }
  const mode = flags.live ? 'live' : 'test';
  let started;
  try {
    started = await api(`/api/automations/${lock.automationId}/run`, { method: 'POST', body: { mode, input } });
  } catch (e) {
    if (e instanceof ApiError && e.status === 422) {
      console.log(C.red('The automation cannot run yet:'));
      for (const p of e.body.errors || [e.message]) console.log(C.red('  ✗ ') + p);
      process.exit(1);
    }
    throw e;
  }
  const run = await api(`/api/automation-runs/${started.runId}`);
  if (flags.json) { console.log(JSON.stringify(run, null, 2)); process.exit(run.status === 'failed' ? 1 : 0); }

  console.log(C.dim(`${mode === 'test' ? 'draft' : 'published'} · run ${run.id}`));
  for (const s of run.steps || []) {
    const mark = s.status === 'failed' ? C.red('✗') : s.status === 'waiting' ? C.yellow('…') : C.green('✓');
    const pass = s.iteration === null || s.iteration === undefined ? '' : C.dim(` #${s.iteration + 1}`);
    const way = s.port && s.port !== 'out' ? C.dim(` → ${s.port}`) : '';
    console.log(`  ${mark} ${C.bold(s.step_id)}${pass}${way}  ${C.dim(`${s.step_type} · ${s.ms} ms`)}`);
    if (s.error) console.log(C.red(`      ${s.error}`));
    const out = s.step_type === 'code' && s.output && typeof s.output === 'object' && 'printed' in s.output ? s.output : null;
    if (out && out.printed) for (const line of String(out.printed).trimEnd().split('\n')) console.log(C.dim(`      | ${line}`));
    if (flags.verbose) console.log(C.dim(`      in  ${short(s.input, 2000)}`));
    console.log(C.dim(`      ${short(out ? out.result : s.output, flags.verbose ? 4000 : 220)}`));
  }
  const tone = run.status === 'done' ? C.green : run.status === 'failed' ? C.red : C.yellow;
  console.log(`\n${tone(run.status)}${run.error ? ` — ${run.error}` : ''}`);
  if (run.output !== null && run.output !== undefined) console.log(JSON.stringify(run.output, null, 2));
  if (run.status === 'waiting') console.log(C.dim('  It is parked at a wait and carries on by itself.'));
  if (run.status === 'failed') process.exit(1);
};

/** The checks the server will run on an automation folder, run here first. */
export function validateAutomationTree(files) {
  const problems = [];
  let config = null;
  if (files['automation.json'] === undefined) return ['automation.json is missing'];
  try { config = JSON.parse(files['automation.json']); } catch (e) { return [`automation.json: ${e.message}`]; }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return ['automation.json must be an object'];
  if (!config.id) problems.push('automation.json: id is required');
  if (files['layout.json'] !== undefined) {
    try { JSON.parse(files['layout.json']); } catch (e) { problems.push(`layout.json: ${e.message}`); }
  }
  const steps = Array.isArray(config.steps) ? config.steps : [];
  if (config.steps !== undefined && !Array.isArray(config.steps)) problems.push('automation.json: steps must be a list');
  const ids = new Set();
  for (const s of steps) {
    if (!s || !/^[a-z][a-z0-9_]{0,39}$/.test(String(s.id || ''))) { problems.push(`automation.json: the step id "${s && s.id}" must be lowercase letters, digits and _`); continue; }
    if (ids.has(s.id)) problems.push(`automation.json: two steps are called "${s.id}"`);
    ids.add(s.id);
    if (s.type === 'code' && files[`steps/${s.id}.py`] === undefined) problems.push(`steps/${s.id}.py is missing (the code of the step "${s.id}")`);
  }
  for (const [i, e] of (Array.isArray(config.edges) ? config.edges : []).entries()) {
    if (e.from !== 'trigger' && !ids.has(e.from)) problems.push(`automation.json: edges[${i}] leaves "${e.from}", which is not a step`);
    if (!ids.has(e.to)) problems.push(`automation.json: edges[${i}] leads to "${e.to}", which is not a step`);
  }
  for (const p of Object.keys(files)) {
    if (['automation.json', 'layout.json', 'AGENTS.md', 'CLAUDE.md', '.gitignore'].includes(p)) continue;
    const m = /^steps\/([a-z][a-z0-9_]{0,39})\.py$/.exec(p);
    if (!m) problems.push(`${p} is not part of an automation — it holds automation.json, layout.json and steps/<id>.py`);
    else if (!steps.some(s => s && s.id === m[1] && s.type === 'code')) problems.push(`${p} has no Code step called "${m[1]}" in automation.json`);
  }
  return problems;
}

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
  const it = thing(lock);
  const pulled = await api(it.files());
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
  console.log(C.dim(`  A \`git push\` to this remote is applied to the ${it.noun}, the same as \`8legs push\`.`));
  console.log(C.dim('  A commit that does not validate is marked failed on GitHub and is not made live.'));
};

commands.branches = async () => {
  const { lock } = requireRoot();
  agentOnly(lock, 'branches');
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
  agentOnly(lock, 'branch');
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
  agentOnly(lock, 'checkout');
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
  agentOnly(lock, 'merge');
  const name = args[1] || lock.branch;
  if (!name || name === 'main') die('Name the branch to merge into main.');
  const merged = await api(`/api/agents/${lock.agentId}/branches`,
                           { method: 'POST', body: { action: 'merge', branch: name } });
  console.log(C.green('✓ ') + `Merged ${C.bold(merged.branch)} into main — it is live now.`);
  console.log(C.dim('  Run `8legs checkout main` to follow it.'));
};

commands.traffic = async () => {
  const { lock } = requireRoot();
  agentOnly(lock, 'traffic');
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

/* ─────────────────── an app's versions ─────────────────── */

function appOnly(lock, command) {
  if (lock.kind !== 'app' && lock.kind !== 'automation') {
    die(`\`8legs ${command}\` is for an app or automation folder. An agent has branches: \`8legs branches\`.`);
  }
}

commands.versions = async () => {
  const { lock } = requireRoot();
  appOnly(lock, 'versions');
  const { versions } = lock.kind === 'automation'
    ? await api(`/api/automations/${lock.automationId}/versions`)
    : await api(`/api/apps/${lock.appId}/versions`);
  if (!versions.length) return console.log('Not published yet, so there are no versions.');
  for (const v of versions) {
    const from = v.source === 'git' ? `git ${String(v.commit_sha || '').slice(0, 7)}` : v.source;
    console.log(`  ${String(v.number).padStart(3)}  ${C.dim(String(v.created_at).slice(0, 16).replace('T', ' '))}  ${from.padEnd(11)}` +
                `${v.message || ''}${v.active ? C.cyan('  ← live') : ''}`);
  }
};

commands.rollback = async () => {
  const { root, lock } = requireRoot();
  appOnly(lock, 'rollback');
  const number = args[1];
  if (!number) die('Which version? `8legs versions` lists them, then `8legs rollback 3`.');
  const local = changes(root, lock);
  if ([...local.added, ...local.modified, ...local.deleted].length && !flags.force) {
    die('You have local changes that going back would overwrite. Push them first, or use --force.');
  }
  let done;
  try {
    done = lock.kind === 'automation'
      ? await api(`/api/automations/${lock.automationId}/versions`, { method: 'POST', body: { versionId: String(number) } })
      : await api(`/api/apps/${lock.appId}/versions`, { method: 'POST', body: { versionId: String(number) } });
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) die(`No version ${number}. Try \`8legs versions\`.`);
    throw e;
  }
  console.log(C.green('✓ ') + `Version ${done.versionNumber} is live again.`);
  /* The folder follows, so the next edit starts from what is being served. */
  const pulled = await api(thing(lock).files());
  for (const rel of Object.keys(lock.files || {})) {
    if (!(rel in pulled.files)) { try { fs.unlinkSync(path.join(root, rel)); } catch {} }
  }
  writeTree(root, pulled.files);
  writeLock(root, thing(lock).lock({ branch: pulled.branch, version: pulled.version, host: lock.host, files: pulled.files }));
};

commands.open = async () => {
  const { lock } = requireRoot();
  const url = `${lock.host || DEFAULT_HOST}/${thing(lock).page}`;
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  const { spawn } = await import('child_process');
  spawn(opener, [url], { stdio: 'ignore', detached: true }).unref();
  console.log(url);
};

/* ─────────────────── dispatch ─────────────────── */

const HELP = `
${C.bold('8legs')} — edit an agent, an app or an automation in your own editor, then push it

  ${C.bold('8legs login')}              store a personal access token
  ${C.bold('8legs logout')}             forget it
  ${C.bold('8legs whoami')}             which installation you are logged in to
  ${C.bold('8legs list')}               your agents, with their ids
  ${C.bold('8legs apps')}               your apps, with their slugs
  ${C.bold('8legs automations')}        your automations, and which are live

  ${C.bold('8legs pull <agent>')}       download an agent into a folder
  ${C.bold('8legs pull --app <app>')}   download an app into a folder
  ${C.bold('8legs pull --automation <name>')}  download an automation's draft
  ${C.bold('8legs pull')}               refresh the folder you are in
  ${C.bold('8legs status')}             what changed, here and on the platform
  ${C.bold('8legs diff [file]')}        the changes themselves
  ${C.bold('8legs validate')}           check the folder before pushing
  ${C.bold('8legs push')}               send the changes
  ${C.bold('8legs open')}               open this agent or app in the browser
  ${C.bold('8legs git')}                point this folder's git remote at its repository

  ${C.bold('8legs run')}                run an automation's draft once and print every step
  ${C.bold('8legs publish')}            make an automation's draft what its trigger fires

  ${C.bold('8legs versions')}           an app's or automation's versions, and which one is live
  ${C.bold('8legs rollback <n>')}       make an earlier version live again

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
  ${C.dim('--publish')}          with push, in an automation folder: publish as well
  ${C.dim("--input '<json>'")}   with run: what to hand the trigger (or --input-file <path>)
  ${C.dim('--verbose')}          with run: also print what each step was given
`;

const name = args[0];
if (!name || name === 'help' || flags.help) { console.log(HELP); process.exit(0); }
if (!commands[name]) { console.error(`Unknown command: ${name}`); console.log(HELP); process.exit(1); }

commands[name]().catch(e => {
  if (e.friendly || e instanceof ApiError) die(e.message);
  die(e.stack || e.message);
});
