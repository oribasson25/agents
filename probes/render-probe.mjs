/**
 * Actually renders the new pieces of agentforge.html. A component that throws
 * on its first render takes the whole tree down, and the file has no build
 * step to catch it — so the only honest check is to run it.
 */
import fs from 'fs';
import vm from 'vm';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const babel = require('@babel/standalone');
const React = require('react');
const ReactDOMServer = require('react-dom/server');

const src = fs.readFileSync(new URL('../agentforge.html', import.meta.url).pathname, 'utf8');
const body = src.match(/<script type="text\/babel"[^>]*>([\s\S]*?)<\/script>/)[1];

/* Hand the probe the components it wants to render. */
const exposed = ['TokensSection', 'TokenMinter', 'LocalIdePanel', 'SettingsPanel', 'AgentEditor', 'BranchBar', 'MergePanel', 'MobileDraftBar', 'MobileAgentEditor', 'CopyableCommand', 'DocsView', 'HomeChatView', 'AgentBuildCard', 'Sidebar', 'splitOptions', 'HOME_COPY', 'homeSystemExtra', 'greeting', 'L', 'Eyebrow'];
const code = babel.transform(
  body + `\n;globalThis.__probe = { ${exposed.map(n => `${n}: typeof ${n} !== 'undefined' ? ${n} : null`).join(', ')} };`,
  { presets: ['react'] }).code;

const store = () => ({ getItem: () => null, setItem() {}, removeItem() {} });
const calls = [];
const sandbox = {
  React, ReactDOM: { createRoot: () => ({ render() {} }) }, console,
  window: { location: { origin: 'https://www.8legs.world', hash: '' },
            matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
            addEventListener() {}, removeEventListener() {}, dispatchEvent() {} },
  document: { getElementById: () => ({}), documentElement: { setAttribute() {}, style: {} },
              addEventListener() {}, removeEventListener() {}, createElement: () => ({ style: {} }) },
  localStorage: store(), sessionStorage: store(),
  navigator: { clipboard: { writeText: () => Promise.resolve() } },
  fetch: (url, opts) => { calls.push(`${opts?.method || 'GET'} ${url}`);
                          return Promise.resolve({ ok: true, status: 200, json: async () => [] }); },
  setTimeout, clearTimeout, setInterval, clearInterval, crypto: globalThis.crypto, Date, Math, JSON,
  URLSearchParams, URL, TextEncoder, TextDecoder, Intl,
};
sandbox.globalThis = sandbox;
sandbox.window.localStorage = sandbox.localStorage;
sandbox.window.sessionStorage = sandbox.sessionStorage;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'agentforge.html' });

const probe = sandbox.__probe;
let failed = 0;
const render = (label, element) => {
  try {
    const html = ReactDOMServer.renderToString(element);
    console.log(`✓ ${label} renders (${html.length} chars)`);
    return html;
  } catch (e) { console.log(`✗ ${label}: ${e.message}`); failed++; return ''; }
};

for (const name of exposed) if (!probe[name]) { console.log(`✗ ${name} is not defined`); failed++; }

const styles = { sectionStyle: {}, sectionHeader: {}, rowStyle: {}, iconBox: {} };
const tokens = render('TokensSection', React.createElement(probe.TokensSection, styles));
if (tokens && !tokens.includes('Create token')) { console.log('✗ TokensSection has no create button'); failed++; }
for (const cmd of ['npm i -g @8legs/cli', 'npx @8legs/cli login']) {
  if (tokens && !tokens.includes(cmd)) { console.log(`✗ Settings does not show \`${cmd}\``); failed++; }
}
if (tokens && tokens.includes('npm i -g @8legs/cli')) console.log('✓ Settings shows both install commands');

const cmdBox = render('CopyableCommand', React.createElement(probe.CopyableCommand, {
  command: 'npm i -g @8legs/cli', note: 'a note',
}));
if (cmdBox && !cmdBox.includes('Copy')) { console.log('✗ CopyableCommand has no copy button'); failed++; }

const ide = render('LocalIdePanel',
  React.createElement(probe.LocalIdePanel, { agentId: '804fe690-c8b6-4e3a-bb8f-1305bd1721d7', onClose() {} }));
for (const cmd of ['npm i -g @8legs/cli', 'npx @8legs/cli login', '@8legs/cli pull 804fe690-c8b6-4e3a-bb8f-1305bd1721d7']) {
  if (ide && !ide.includes(cmd)) { console.log(`✗ the local-IDE panel is missing \`${cmd}\``); failed++; }
}
if (ide && !ide.includes('Create token')) { console.log('✗ the local-IDE panel cannot mint a token'); failed++; }

const settings = render('SettingsPanel (with the new section)', React.createElement(probe.SettingsPanel, {
  theme: 'dark', onToggleTheme() {}, user: { email: 'a@b.c' }, onLogout() {},
  settings: { provider: 'claude', apiKey: '', model: 'claude-sonnet-4-5' }, onSaveSettings: async () => {},
}));
if (settings && !settings.includes('Personal access tokens')) {
  console.log('✗ SettingsPanel does not include the tokens section'); failed++;
}

const editor = render('AgentEditor header', React.createElement(probe.AgentEditor, {
  agent: { id: 'a-1', name: 'ביטוח רכב', avatar: '🚗', skills: [], tools: [], basePrompt: '' },
  onUpdate() {}, onBack() {}, onTest() {},
}));
if (editor && !editor.includes('Build on local IDE')) { console.log('✗ the editor header has no local-IDE button'); failed++; }

const bar = render('BranchBar on a draft', React.createElement(probe.BranchBar, {
  agent: { id: 'a-1', _branch: 'draft' }, branch: null, onSwitch() {}, onChanged() {},
}));
if (bar && !bar.includes('Publish')) { console.log('✗ the draft bar has no publish button'); failed++; }
if (bar && !bar.includes('live agent')) { console.log('✗ the draft bar does not say the live agent is unchanged'); failed++; }

const live = render('BranchBar on main', React.createElement(probe.BranchBar, {
  agent: { id: 'a-1', _branch: 'main' }, branch: null, onSwitch() {}, onChanged() {},
}));
if (live && live.includes('Publish')) { console.log('✗ main should not offer publish'); failed++; }

const mDraft = render('MobileDraftBar on a draft', React.createElement(probe.MobileDraftBar, {
  agent: { id: 'a-1', _branch: 'draft' }, onChanged() {},
}));
if (mDraft && !mDraft.includes('Publish')) { console.log('✗ the phone draft bar cannot publish'); failed++; }
const mLive = ReactDOMServer.renderToString(React.createElement(probe.MobileDraftBar, {
  agent: { id: 'a-1', _branch: 'main' }, onChanged() {},
}));
if (mLive !== '') { console.log('✗ the phone draft bar shows on main'); failed++; }
else console.log('✓ the phone draft bar stays hidden on main');

const docs = render('DocsView on the CLI section',
  React.createElement(probe.DocsView, { initialSection: 'cli' }));
for (const needle of ['npm i -g @8legs/cli', '8legs traffic', 'config.json', '{{global.NAME}}']) {
  if (docs && !docs.includes(needle)) { console.log(`✗ the CLI page is missing: ${needle}`); failed++; }
}
if (docs && docs.includes('npm i -g @8legs/cli')) console.log('✓ the CLI page has the install command and the reference');
render('DocsView default page', React.createElement(probe.DocsView, {}));

render('MergePanel', React.createElement(probe.MergePanel, {
  agentId: 'a-1', branch: 'warmer-tone', onClose() {}, onMerged() {},
}));

/* ── the home screen ──
   It is the first thing anyone sees, and it is a chat: an empty account gets
   the mark and the one input, an account mid-conversation gets the thread. */
const homeEmpty = render('HomeChatView with no agents', React.createElement(probe.HomeChatView, {
  agents: [], user: { username: 'ori' }, onAgentsChanged: async () => {}, language: 'en',
  onOpenAgent() {}, onTestAgent() {}, onSaved() {}, newChatNonce: 0,
}));
/* The greeting is by the clock, so any of the three counts. */
if (homeEmpty && !/Good (morning|afternoon|evening), ori/.test(homeEmpty)) {
  console.log('✗ the empty home screen does not greet the user by name'); failed++;
}
if (homeEmpty && !homeEmpty.includes('spider-anim')) { console.log('✗ the home logo is not animated'); failed++; }
else if (homeEmpty) console.log('✓ the empty home screen centres the animated mark');

const homeBack = render('HomeChatView with agents', React.createElement(probe.HomeChatView, {
  agents: [{ id: 'a-1', name: 'weather', skills: [], tools: [] }],
  user: { username: 'ori' },
  onAgentsChanged: async () => {}, language: 'en',
  onOpenAgent() {}, onTestAgent() {}, onSaved() {}, newChatNonce: 0,
}));
if (homeBack && !homeBack.includes('Build a new agent, change one you have')) {
  console.log('✗ a returning account gets the wrong subtitle'); failed++;
}

/* The interview is about what was asked for, not about how many agents the
   account has: both prompts must carry both branches. */
for (const [label, first] of [['a new account', true], ['an account with agents', false]]) {
  const extra = probe.homeSystemExtra(first, 'en');
  for (const needle of ['A NEW AGENT is wanted', 'ANYTHING ELSE', 'Do NOT interview']) {
    if (!extra.includes(needle)) { console.log(`✗ the home prompt for ${label} is missing: ${needle}`); failed++; }
  }
}
console.log('✓ the interview runs on intent, whether or not the account has agents');

const card = render('AgentBuildCard mid-build', React.createElement(probe.AgentBuildCard, {
  agent: { id: 'a-1', name: 'מעקב הזמנות', avatar: '📦', basePrompt: 'You answer customers about the status of their order.',
           skills: [{ name: 'order_status' }], tools: [{ name: 'fetch_order' }], whatsapp: { enabled: false } },
  copy: probe.HOME_COPY.en, dir: 'ltr', onOpen() {}, onTest() {},
}));
for (const needle of ['מעקב הזמנות', 'order_status', 'fetch_order']) {
  if (card && !card.includes(needle)) { console.log(`✗ the build card is missing: ${needle}`); failed++; }
}
render('AgentBuildCard before anything exists', React.createElement(probe.AgentBuildCard, {
  agent: null, copy: probe.HOME_COPY.en, dir: 'ltr', onOpen() {}, onTest() {},
}));

const side = render('Sidebar with recent chats', React.createElement(probe.Sidebar, {
  activeNav: 'home', onNav() {}, user: { username: 'ori', isAdmin: false }, onLogout() {},
  settings: { provider: 'claude', apiKey: 'k', model: 'claude-opus-5' },
  recents: [{ id: 's-1', title: 'סוכן למעקב הזמנות' }], activeSessionId: 's-1',
  onPickRecent() {}, onNewChat() {}, language: 'en',
}));
for (const needle of ['Home', 'Agents', 'סוכן למעקב הזמנות']) {
  if (side && !side.includes(needle)) { console.log(`✗ the sidebar is missing: ${needle}`); failed++; }
}
if (side && side.includes('>Assistant<')) { console.log('✗ the sidebar still carries the Assistant tab'); failed++; }

/* A saved chat title is whatever the user typed. Without dir="auto" a Hebrew
   one is truncated at its opening words and its "?" lands at the front. */
if (side && !/dir="auto"[^>]*>[\s\S]{0,40}סוכן למעקב הזמנות/.test(side)) {
  console.log('✗ the chat rows do not carry their own direction'); failed++;
} else console.log('✓ a chat title in the sidebar carries dir="auto"');

/* The eyebrow's letter-spaced mono is an English shape. */
const ebEn = render('Eyebrow in English', React.createElement(probe.Eyebrow, {}, 'Runtime'));
const ebHe = render('Eyebrow in Hebrew', React.createElement(probe.Eyebrow, {}, 'שיחות'));
if (!/letter-spacing/.test(ebEn)) { console.log('✗ the English eyebrow lost its letter-spacing'); failed++; }
if (/letter-spacing/.test(ebHe)) { console.log('✗ a Hebrew eyebrow is still letter-spaced'); failed++; }
else console.log('✓ a Hebrew eyebrow drops the English letter-spacing');

/* The suggested-answer buttons only exist if the marker line is parsed off. */
const parsed = probe.splitOptions('באיזו שפה הוא מדבר?\n::options:: עברית | אנגלית | שתיהן');
if (parsed.options.length !== 3 || parsed.body.includes('::options::')) {
  console.log('✗ the ::options:: line is not split off the answer'); failed++;
} else console.log('✓ suggested answers are parsed out of the reply');
if (probe.splitOptions('just an answer').options.length !== 0) {
  console.log('✗ a plain answer should carry no options'); failed++;
}

console.log(`\n${failed ? `${failed} FAILURE(S)` : 'all green'}`);
process.exit(failed ? 1 : 0);
