/**
 * Turns an app into a folder of files and back again.
 *
 * The same contract `_agentFiles.js` keeps for agents, and for the same reason:
 *
 *     filesToApp(appToFiles(a), a).app  deep-equals  a
 *
 * Every push runs the second half against the live app, so a field this
 * forgets is a field a push deletes. `probes/app-probe.mjs` checks it.
 *
 * An app is simpler than an agent: its own files are stored as they are
 * (`app.files`), and `app.json` carries the rest — the name, the description,
 * which file opens first, and the AI Chatbots and Tables the app may reach.
 *
 * Three fields never come from a file. They are restored from the stored app:
 *
 *   slug       the app's address; fixed at creation so a link never moves
 *   access     who may open it; a push must not be able to publish an app
 *   createdAt  set once
 */
import { agentVersion, extrasOf, compact, json, parseJson } from './_agentFiles.js';

const SERVER_OWNED = ['slug', 'access', 'createdAt'];
const MAPPED = new Set(['id', 'name', 'description', 'entry', 'agents', 'tables', 'automations', 'files', ...SERVER_OWNED]);

/* Files the platform writes into the folder; an app cannot have its own. */
const GENERATED = new Set(['app.json', 'AGENTS.md', 'CLAUDE.md', '.gitignore']);

export const LIMITS = { files: 300, bytes: 2 * 1024 * 1024 };
const ALIAS = /^[A-Za-z0-9_-]{1,40}$/;

/** A path a browser can ask for and a filesystem can hold, and nothing else. */
export function badPath(path) {
  if (!path || path.length > 200) return 'is not a usable path';
  if (path.startsWith('/') || path.includes('\\') || path.includes('\u0000')) return 'is not a usable path';
  const parts = path.split('/');
  if (parts.some(p => !p || p === '.' || p === '..')) return 'is not a usable path';
  /* `~` opens a private link's token segment in the app's URL. */
  if (parts[0].startsWith('~')) return 'may not start with ~';
  if (parts[0] === '.8legs' || parts[0] === '.git') return 'is reserved';
  return null;
}

/**
 * The app's content hash — what a push is checked against.
 *
 * `access` is left out: switching an app between private and public is not an
 * edit, and must not make somebody's checkout look stale.
 */
export function appVersion(app) {
  const { access, ...content } = app || {};
  return agentVersion(content);
}

/** `{ alias: id }` or `{ alias: { id, readonly } }`, checked for shape only. */
function checkLinks(value, label, errors) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`app.json: ${label} must be an object of name → id`);
    return {};
  }
  for (const [alias, target] of Object.entries(value)) {
    if (!ALIAS.test(alias)) errors.push(`app.json: ${label}.${alias} — use letters, digits, - and _ for the name`);
    const id = typeof target === 'string' ? target : target && target.id;
    if (!id || typeof id !== 'string') errors.push(`app.json: ${label}.${alias} needs an id`);
  }
  return value;
}

/** The id behind a link, whichever of the two shapes it was written in. */
export const linkId = (target) => (typeof target === 'string' ? target : (target && target.id) || '');

/* ─────────────────── app → files ─────────────────── */

export function appToFiles(app) {
  const files = { ...(app.files || {}) };
  files['app.json'] = json(compact({
    version: '1.0',
    id: app.id,
    /* Shown so the folder says where it is served; a push cannot change it. */
    slug: app.slug,
    name: app.name || '',
    description: app.description || '',
    entry: app.entry || 'index.html',
    agents: app.agents || {},
    tables: app.tables || {},
    /* Left out of app.json until an app links one, so an app that never did
       reads exactly as it always has. */
    ...(Object.keys(app.automations || {}).length ? { automations: app.automations } : {}),
    extras: extrasOf(app, MAPPED),
  }));
  files['.gitignore'] = ['.8legs/', 'node_modules/', '*.log', '.DS_Store', ''].join('\n');
  files['AGENTS.md'] = AGENTS_MD;
  files['CLAUDE.md'] = '@AGENTS.md\n';
  return files;
}

/* ─────────────────── files → app ─────────────────── */

export function filesToApp(files, existing = {}) {
  const errors = [];
  const config = parseJson(files, 'app.json', errors);
  if (!config) return { app: null, errors };
  if (typeof config !== 'object' || Array.isArray(config)) {
    return { app: null, errors: ['app.json must be an object'] };
  }

  if (!config.id) errors.push('app.json: id is required');
  const entry = config.entry || 'index.html';

  const own = {};
  let bytes = 0;
  for (const [path, content] of Object.entries(files)) {
    if (GENERATED.has(path)) continue;
    /* The CLI's bookkeeping, if somebody committed it. Not the app's. */
    if (path.startsWith('.8legs/')) continue;
    const why = badPath(path);
    if (why) { errors.push(`${path} ${why}`); continue; }
    if (typeof content !== 'string') { errors.push(`${path} is not text`); continue; }
    bytes += Buffer.byteLength(content, 'utf8');
    own[path] = content;
  }
  const count = Object.keys(own).length;
  if (count > LIMITS.files) errors.push(`An app holds at most ${LIMITS.files} files; this has ${count}`);
  if (bytes > LIMITS.bytes) errors.push(`An app holds at most ${LIMITS.bytes / 1024 / 1024} MB; this is ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  if (own[entry] === undefined) errors.push(`${entry} is missing (app.json names it as the entry)`);

  const agents = checkLinks(config.agents, 'agents', errors);
  const tables = checkLinks(config.tables, 'tables', errors);
  const automations = checkLinks(config.automations, 'automations', errors);

  if (errors.length) return { app: null, errors };

  const app = compact({
    id: config.id,
    name: config.name || '',
    description: config.description || '',
    entry,
    agents,
    tables,
    ...(Object.keys(automations).length ? { automations } : {}),
    files: own,
    ...(config.extras || {}),
  });
  for (const key of SERVER_OWNED) if (existing[key] !== undefined) app[key] = existing[key];
  return { app, errors: [] };
}

/* ─────────────────── a new app ─────────────────── */

/** What a freshly created app holds: enough to open, and to show the SDK. */
export function starterFiles(name) {
  const title = String(name || 'My app').replace(/[<>&"]/g, '');
  return {
    'index.html': `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p id="status">Loading…</p>
    <form id="ask" hidden>
      <input id="question" placeholder="Ask the AI Chatbot…" autocomplete="off">
      <button>Send</button>
    </form>
    <div id="thread"></div>
  </main>
  <script src="app.js"></script>
</body>
</html>
`,
    'app.js': `/* \`legs\` is the platform's handle, injected into every app page.
   Link an AI Chatbot or a Table in app.json, then reach it by the name you gave it:

     legs.agent('support').chat().send('hello')     -> the reply text
     legs.table('leads').rows()                     -> { rows, total, columns }
     legs.table('leads').add({ name: 'Dana' })
*/
const status = document.getElementById('status');
const form = document.getElementById('ask');
const thread = document.getElementById('thread');

const say = (who, text) => {
  const p = document.createElement('p');
  p.className = who;
  p.textContent = text;
  thread.appendChild(p);
  return p;
};

if (!legs.agents.length) {
  status.textContent = 'This app is live. Link an AI Chatbot in app.json to talk to it from here.';
} else {
  const chat = legs.agent(legs.agents[0]).chat();
  status.textContent = 'Connected to "' + legs.agents[0] + '".';
  form.hidden = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('question');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    say('me', text);
    const reply = say('bot', '…');
    try { reply.textContent = await chat.send(text); }
    catch (err) { reply.textContent = 'Error: ' + err.message; }
  });
}
`,
    'style.css': `body { margin: 0; font: 16px/1.5 system-ui, sans-serif; background: #0f1117; color: #f0f0f5; }
main { max-width: 640px; margin: 0 auto; padding: 48px 20px; }
h1 { margin: 0 0 8px; letter-spacing: -0.02em; }
#status { color: #9ca3af; }
form { display: flex; gap: 8px; margin: 24px 0; }
input { flex: 1; padding: 10px 12px; border-radius: 10px; border: 1px solid #2a2d3e; background: #1e2130; color: inherit; font: inherit; }
button { padding: 10px 16px; border-radius: 10px; border: 0; background: #ef9f27; color: #111; font: inherit; font-weight: 600; cursor: pointer; }
#thread p { padding: 10px 14px; border-radius: 14px; margin: 8px 0; white-space: pre-wrap; }
#thread .me { background: #ef9f27; color: #111; margin-inline-start: 20%; }
#thread .bot { background: #1e2130; margin-inline-end: 20%; }
`,
  };
}

const AGENTS_MD = `# 8Legs app

This folder is one app on [8legs.world](https://www.8legs.world): a small web
interface the platform hosts. Edit the files, then \`8legs push\` (or
\`git push\`, which the platform picks up). A push that validates is live at
once and kept as a version you can go back to.

| What to change | Where |
|---|---|
| The page that opens | \`index.html\` (or whatever \`entry\` names in \`app.json\`) |
| Scripts, styles, data | any other file; reference them with relative paths |
| Name and description | \`app.json\` |
| Which AI Chatbots and Tables the app may reach | \`agents\` and \`tables\` in \`app.json\` |

## The files are served as they are

There is no build step. If you use a bundler, commit its output. Files are
text (HTML, JS, CSS, JSON, SVG); binary assets are not carried.

## Talking to the platform

Every page gets a global \`legs\`:

\`\`\`js
legs.app                                  // { id, slug, name }
legs.agents, legs.tables                  // the names linked in app.json

const { name, openingMessage } = await legs.agent('support').info();
const chat = legs.agent('support').chat();
const reply = await chat.send('hello');   // keeps the conversation going

const leads = legs.table('leads');
const { rows, total, columns } = await leads.rows({ q: '', limit: 100 });
await leads.add({ name: 'Dana' });
await leads.update(rowId, { status: 'won' });
await leads.remove(rowId);

const result = await legs.automation('new_lead').run({ name: 'Dana' });  // what its Output returned
\`\`\`

Link them in \`app.json\` by the name your code will use:

\`\`\`json
"agents": { "support": "<agent id>" },
"tables": { "leads": "<table id>", "prices": { "id": "<table id>", "readonly": true } },
"automations": { "new_lead": "<automation id>" }
\`\`\`

## Rules

- **Never change \`id\`.** It is how the platform matches this folder to the app.
- \`slug\` is the app's address and cannot be changed by a push.
- Whether the app is private or open to anyone with the link is set in the
  platform, not here.
- The page runs sandboxed: no cookies or localStorage, and it reaches the
  platform only through \`legs\`.
- Run \`8legs validate\` before pushing.
`;
