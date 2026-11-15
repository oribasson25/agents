/** Drives the real CLI binary against the stand-in platform. */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawn } from 'child_process';

const TOKEN = '8legs_pat_TESTTOKEN';

/* The server runs in its own process: execFileSync blocks this one, so an
   in-process server could never answer the CLI's requests. */
const proc = spawn(process.execPath, [new URL('./fake-server.mjs', import.meta.url).pathname],
                   { stdio: ['ignore', 'pipe', 'inherit'] });
const HOST = await new Promise((resolve, reject) => {
  let buf = '';
  proc.stdout.on('data', d => { buf += d; const m = buf.match(/READY (\S+)/); if (m) resolve(m[1]); });
  proc.on('exit', c => reject(new Error(`server exited with ${c}`)));
  setTimeout(() => reject(new Error('server did not start')), 10000);
});
const CLI = new URL('../cli/bin/8legs.js', import.meta.url).pathname;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), '8legs-home-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), '8legs-work-'));
fs.mkdirSync(path.join(HOME, '.8legs'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.8legs', 'config.json'),
                 JSON.stringify({ token: TOKEN, host: HOST }));

const current = async () => (await fetch(`${HOST}/__agent`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
const editInUi = (patch) => fetch(`${HOST}/__ui_edit`, { method: 'POST',
  headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && detail ? `\n    ${String(detail).replace(/\n/g, '\n    ')}` : ''}`);
  if (!ok) failed++;
};
let CWD = WORK;
function run(cmdArgs, cwd = CWD, expectFail = false) {
  try {
    return { ok: true, out: execFileSync(process.execPath, [CLI, ...cmdArgs],
      { cwd, env: { ...process.env, HOME, NO_COLOR: '1' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    if (!expectFail) console.log('    (command failed)', (e.stderr || e.stdout || '').slice(0, 300));
    return { ok: false, out: (e.stdout || '') + (e.stderr || '') };
  }
}

check('list shows the agent', run(['list']).out.includes('car-insurance'));

const pulled = run(['pull', 'car-insurance']);
check('pull writes a folder', pulled.ok && /Pulled \d+ files/.test(pulled.out), pulled.out);
const ROOT = path.join(WORK, 'car-insurance');
CWD = ROOT;
check('the tree is on disk',
      fs.existsSync(path.join(ROOT, 'config.json')) &&
      fs.existsSync(path.join(ROOT, 'prompt.md')) &&
      fs.existsSync(path.join(ROOT, 'skills/pricing/prompts/skill.md')) &&
      fs.existsSync(path.join(ROOT, 'tools/fetch_quote/run.py')) &&
      fs.existsSync(path.join(ROOT, 'AGENTS.md')));
check('no secret on disk',
      !fs.readFileSync(path.join(ROOT, 'tools/fetch_quote/tool.json'), 'utf8').includes('SECRET'));

check('status is clean right after a pull', run(['status']).out.includes('nothing changed locally'));

/* Edit the prompt the way a person would. */
const promptPath = path.join(ROOT, 'prompt.md');
fs.writeFileSync(promptPath, fs.readFileSync(promptPath, 'utf8').replace('- Be brief.', '- Be brief and warm.'));
const st = run(['status']);
check('status notices the edit', st.out.includes('M prompt.md'), st.out);

const df = run(['diff']);
check('diff shows the line that changed',
      df.out.includes('- - Be brief.') && df.out.includes('+ - Be brief and warm.'), df.out);

/* A command run from a subdirectory must still find the agent. */
check('status works from a subdirectory',
      run(['status'], path.join(ROOT, 'skills')).out.includes('M prompt.md'));

/* Validation must catch a broken file before the network does. */
const skillJson = path.join(ROOT, 'skills/pricing/skill.json');
const goodSkill = fs.readFileSync(skillJson, 'utf8');
fs.writeFileSync(skillJson, '{ broken');
const badValidate = run(['validate'], ROOT, true);
check('validate rejects broken JSON', !badValidate.ok && badValidate.out.includes('skill.json'), badValidate.out);
const badPush = run(['push'], ROOT, true);
check('push refuses before sending anything', !badPush.ok && badPush.out.includes('Refusing to push'), badPush.out);
check('the platform was not touched', (await current()).basePrompt.includes('- Be brief.\n'));
fs.writeFileSync(skillJson, goodSkill);

check('validate passes once fixed', run(['validate']).out.includes('looks valid'));

/* The happy path. */
const pushed = run(['push']);
check('push succeeds', pushed.ok && pushed.out.includes('Pushed 1 change'), pushed.out);
check('the platform has the new prompt', (await current()).basePrompt.includes('- Be brief and warm.'));
check('the api key survived the push', (await current()).apiConfig.apiKey === 'SECRET-KEY');
check('the tool env value survived', (await current()).tools[0].envVars[0].value === 'SECRET');
check('status is clean after a push', run(['status']).out.includes('nothing changed locally'));

/* Someone edits in the UI, then we push a conflicting change. */
await editInUi({ openingMessage: 'Changed in the UI' });
const warned = run(['status']);
check('status warns the platform moved', warned.out.includes('changed on the platform'), warned.out);
fs.writeFileSync(promptPath, fs.readFileSync(promptPath, 'utf8') + '\n- Always confirm the plate.\n');
const conflict = run(['push'], ROOT, true);
check('push refuses on a stale version', !conflict.ok && conflict.out.includes('changed on the platform'), conflict.out);
const afterConflict = await current();
check('the conflicting push wrote nothing', afterConflict.basePrompt.includes('- Be brief and warm.') &&
      !afterConflict.basePrompt.includes('Always confirm the plate'));

/* Pull refuses to clobber local work. */
const clobber = run(['pull'], ROOT, true);
check('pull refuses to overwrite local changes', !clobber.ok && clobber.out.includes('local changes'), clobber.out);

/* Take theirs, redo ours, push. */
const forced = run(['pull', '--force']);
check('pull --force takes the platform version', forced.ok, forced.out);
check('the UI edit arrived', fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').includes('Changed in the UI'));
fs.writeFileSync(promptPath, fs.readFileSync(promptPath, 'utf8') + '\n- Always confirm the plate.\n');
const retry = run(['push']);
check('the redone push lands', retry.ok && (await current()).basePrompt.includes('Always confirm the plate'), retry.out);
check('and the UI edit is still there', (await current()).openingMessage === 'Changed in the UI');

/* ── branches ─────────────────────────────────────────────────────────── */
const opened = run(['branch', 'warmer-tone']);
check('branch opens one and switches to it',
      opened.ok && opened.out.includes('Now on warmer-tone'), opened.out);
check('the lock followed the switch',
      JSON.parse(fs.readFileSync(path.join(ROOT, '.8legs/lock.json'), 'utf8')).branch === 'warmer-tone');
check('branches marks where you are', run(['branches']).out.includes('warmer-tone'));

/* An edit on the branch must not touch the live agent. */
const liveBefore = (await current()).basePrompt;
fs.writeFileSync(promptPath, fs.readFileSync(promptPath, 'utf8').replace('## Role', '## Role (warmer)'));
const branchPush = run(['push']);
check('a push on a branch succeeds', branchPush.ok && branchPush.out.includes('warmer-tone'), branchPush.out);
check('and leaves the live agent alone', (await current()).basePrompt === liveBefore);

/* Switching back gives main's content, not the branch's. */
const backToMain = run(['checkout', 'main']);
check('checkout main comes back', backToMain.ok && backToMain.out.includes('Now on main'), backToMain.out);
check('main still has its own prompt',
      !fs.readFileSync(promptPath, 'utf8').includes('(warmer)'));

/* Traffic. */
const split = run(['traffic', 'warmer-tone', '20']);
check('traffic splits the conversations', split.ok && split.out.includes('20%'), split.out);
const tooMuch = run(['traffic', 'warmer-tone', '140'], ROOT, true);
check('an impossible share is refused', !tooMuch.ok, tooMuch.out);
const stop = run(['traffic', '--stop']);
check('stop brings everything back to main', stop.ok && stop.out.includes('back to main'), stop.out);

/* Merge. */
const merged = run(['merge', 'warmer-tone']);
check('merge applies the branch', merged.ok, merged.out);
check('the live agent has the branch prompt now', (await current()).basePrompt.includes('(warmer)'));
check('a merged branch is gone from the list', !run(['branches']).out.includes('warmer-tone'));

/* Checking out a missing branch must say so, not crash. */
const missing = run(['checkout', 'no-such-branch'], ROOT, true);
check('an unknown branch is a clear message', !missing.ok && missing.out.includes('No branch called'), missing.out);

/* ── apps: the same folder flow, for an app ───────────────────────────── */
const liveApp = async () => (await fetch(`${HOST}/__app`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
CWD = WORK;
check('apps lists the app by its slug', run(['apps']).out.includes('leads-desk'));
const appPull = run(['pull', '--app', 'leads-desk']);
check('pull --app writes the app folder', appPull.ok && /Pulled \d+ files/.test(appPull.out), appPull.out);
const APPROOT = path.join(WORK, 'leads-desk');
CWD = APPROOT;
check('the app tree is on disk',
      ['app.json', 'index.html', 'app.js', 'style.css', 'AGENTS.md'].every(f => fs.existsSync(path.join(APPROOT, f))));
check('the lock says it is an app',
      JSON.parse(fs.readFileSync(path.join(APPROOT, '.8legs/lock.json'), 'utf8')).kind === 'app');
check('a name with no agent behind it finds the app', run(['pull', 'leads-desk', '--dir', 'again'], WORK).ok);
check('status is clean right after pulling an app', run(['status']).out.includes('nothing changed locally'));

const indexPath = path.join(APPROOT, 'index.html');
fs.writeFileSync(indexPath, fs.readFileSync(indexPath, 'utf8').replace('Loading…', 'Edited in my editor'));
fs.mkdirSync(path.join(APPROOT, 'pages'));
fs.writeFileSync(path.join(APPROOT, 'pages/about.html'), '<h1>About</h1>\n');
const appStatus = run(['status']);
check('status sees an edit and a new file', appStatus.out.includes('M index.html') && appStatus.out.includes('A pages/about.html'), appStatus.out);
check('validate accepts the app folder', run(['validate']).out.includes('looks valid'));
const appPush = run(['push']);
check('push makes the app live as a new version', appPush.ok && appPush.out.includes('version 2'), appPush.out);
const afterPush = await liveApp();
check('the platform has the edit and the new file',
      afterPush.files['index.html'].includes('Edited in my editor') && afterPush.files['pages/about.html'] === '<h1>About</h1>\n');
check('status is clean after the push', run(['status']).out.includes('nothing changed locally'));

/* A broken folder must not leave the machine. */
const appJson = path.join(APPROOT, 'app.json');
const goodJson = fs.readFileSync(appJson, 'utf8');
fs.unlinkSync(indexPath);
const noEntry = run(['push'], APPROOT, true);
check('push refuses an app with no entry page', !noEntry.ok && noEntry.out.includes('index.html is missing'), noEntry.out);
check('and the live app still has it', !!(await liveApp()).files['index.html']);
run(['pull', '--force']);
check('pull --force restores the folder', fs.existsSync(indexPath) && fs.readFileSync(appJson, 'utf8') === goodJson);

/* Versions and going back. */
const listed = run(['versions']);
check('versions shows which one is live', /2 .*← live/.test(listed.out) && listed.out.includes('Created'), listed.out);
const rolled = run(['rollback', '1']);
check('rollback makes the earlier version live', rolled.ok && (await liveApp()).files['index.html'].includes('Loading…'), rolled.out);
check('and the folder follows it',
      fs.readFileSync(indexPath, 'utf8').includes('Loading…') && !fs.existsSync(path.join(APPROOT, 'pages/about.html')));
const noBranch = run(['branch', 'x'], APPROOT, true);
check('branch commands explain that apps have versions instead', !noBranch.ok && noBranch.out.includes('8legs versions'), noBranch.out);

console.log(`\n${failed ? `${failed} FAILURE(S)` : 'all green'}`);
proc.kill();
process.exit(failed ? 1 : 0);
