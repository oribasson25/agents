/**
 * The app every new account is handed: a chat page over the AI Chatbots the
 * account starts with.
 *
 * It is given at sign-up, next to the starter chatbots, so an account opens
 * with an app that already works — linked to real chatbots of its own — rather
 * than an empty Apps screen. It is an ordinary app from then on: the owner can
 * edit it, pull it with the CLI, rename it or delete it.
 *
 * Unlike the starter chatbots it is not picked by an admin. It is code, so a
 * change to it is a commit like any other, and it reaches accounts made after
 * the change; apps already handed out are theirs and are never rewritten.
 */
import { sql } from './_db.js';
import { createApp } from './_apps.js';

export const DEFAULT_APP_NAME = 'Chat';
const DESCRIPTION = 'A page of your own for talking to your AI Chatbots. Edit it here, or pull it with 8legs pull --app.';

/** A name a page's code can use: `legs.agent('support')`. */
function aliasFor(name, index, taken) {
  const base = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30)
    || `chatbot_${index + 1}`;
  let alias = base;
  for (let n = 2; taken.has(alias); n++) alias = `${base}_${n}`;
  taken.add(alias);
  return alias;
}

/**
 * Hands the default app to a user. Links every AI Chatbot the account has at
 * this moment — at sign-up, the starters it was just given.
 *
 * Never throws: a sign-up must not fail over an app.
 */
export async function seedDefaultApp(userId) {
  try {
    const rows = await sql`
      select id, data->>'name' as name from agents
      where user_id = ${userId}
      order by created_at
      limit 20
    `;
    const taken = new Set();
    const agents = Object.fromEntries(rows.map((r, i) => [aliasFor(r.name, i, taken), r.id]));
    const app = await createApp({
      user: { userId }, name: DEFAULT_APP_NAME, description: DESCRIPTION,
      files: defaultAppFiles(), agents, uniqueSlug: true, message: 'Created with the account',
    });
    console.log(`[seed] user=${userId} got the default app (${rows.length} AI Chatbot(s) linked)`);
    return app.id;
  } catch (err) {
    console.error('[seed] could not create the default app:', err.message);
    return null;
  }
}

export function defaultAppFiles() {
  return {
    'index.html': INDEX_HTML,
    'app.js': APP_JS,
    'style.css': STYLE_CSS,
  };
}

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Chat</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div class="shell">
    <header class="top">
      <div class="brand">
        <span class="mark" aria-hidden="true"></span>
        <span id="title">Chat</span>
      </div>
      <nav id="bots" class="bots" aria-label="AI Chatbots"></nav>
    </header>

    <main id="thread" class="thread" aria-live="polite"></main>

    <section id="empty" class="empty" hidden>
      <h1 id="empty-title"></h1>
      <p id="empty-text"></p>
    </section>

    <form id="composer" class="composer" hidden>
      <textarea id="input" rows="1" dir="auto" autocomplete="off"></textarea>
      <button id="send" type="submit"></button>
    </form>
  </div>
  <script src="app.js"></script>
</body>
</html>
`;

const APP_JS = `/*
 * A chat page over the AI Chatbots this app links.
 *
 * \`legs\` is the platform's handle, put on every page of an app:
 *   legs.agents                         the names linked in app.json
 *   legs.agent(name).info()             { name, openingMessage }
 *   legs.agent(name).chat().send(text)  the reply, keeping the conversation
 *
 * Link more AI Chatbots on the app's "AI Chatbots & Tables" tab, or under
 * "agents" in app.json, and they appear here as tabs.
 */
const HE = /^he|^iw/i.test(navigator.language || '');
const T = HE ? {
  dir: 'rtl', title: 'צ׳אט', placeholder: 'כתבו הודעה…', send: 'שליחה',
  emptyTitle: 'עוד אין כאן AI Chatbot',
  emptyText: 'קשרו AI Chatbot לאפליקציה בלשונית "AI Chatbots & Tables" שלה, והוא יופיע כאן.',
  gone: 'לא ניתן לטעון את ה-AI Chatbots של האפליקציה.',
  hello: 'שלום! במה אפשר לעזור?',
} : {
  dir: 'ltr', title: 'Chat', placeholder: 'Write a message…', send: 'Send',
  emptyTitle: 'No AI Chatbot here yet',
  emptyText: 'Link one to this app on its "AI Chatbots & Tables" tab, and it shows up here.',
  gone: 'The AI Chatbots of this app could not be loaded.',
  hello: 'Hi! How can I help?',
};

document.documentElement.lang = HE ? 'he' : 'en';
document.documentElement.dir = T.dir;
const $ = (id) => document.getElementById(id);
const title = legs.app.name && legs.app.name !== 'Chat' ? legs.app.name : T.title;
$('title').textContent = title;
document.title = title;
$('input').placeholder = T.placeholder;
$('send').textContent = T.send;

/* One conversation per chatbot, kept while the page is open, so switching
   tabs and back does not lose what was said. */
const bots = [];
const talks = new Map();
let current = null;
let busy = false;

function bubble(who, text) {
  const el = document.createElement('div');
  el.className = 'msg ' + who;
  el.dir = 'auto';
  el.textContent = text;
  return el;
}

function render() {
  const thread = $('thread');
  thread.replaceChildren(...talks.get(current).items);
  thread.scrollTop = thread.scrollHeight;
  for (const b of $('bots').children) b.setAttribute('aria-selected', String(b.dataset.alias === current));
}

function pick(alias) {
  if (!talks.has(alias)) {
    const bot = bots.find(b => b.alias === alias);
    talks.set(alias, { chat: legs.agent(alias).chat(),
                       items: [bubble('bot', bot.openingMessage || T.hello)] });
  }
  current = alias;
  render();
  $('input').focus();
}

function showEmpty(text) {
  $('empty').hidden = false;
  $('empty-title').textContent = T.emptyTitle;
  $('empty-text').textContent = text || T.emptyText;
  $('thread').hidden = true;
}

async function start() {
  const found = await Promise.allSettled(legs.agents.map(a => legs.agent(a).info()));
  found.forEach((r, i) => { if (r.status === 'fulfilled') bots.push({ alias: legs.agents[i], ...r.value }); });

  if (!bots.length) return showEmpty(legs.agents.length ? T.gone : null);

  for (const bot of bots) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'bot';
    tab.dir = 'auto';
    tab.dataset.alias = bot.alias;
    tab.setAttribute('role', 'tab');
    tab.textContent = bot.name;
    tab.addEventListener('click', () => pick(bot.alias));
    $('bots').appendChild(tab);
  }
  /* One chatbot needs no switcher. */
  $('bots').hidden = bots.length < 2;
  $('composer').hidden = false;
  pick(bots[0].alias);
}

async function send() {
  const input = $('input');
  const text = input.value.trim();
  if (!text || busy || !current) return;
  const talk = talks.get(current);
  const alias = current;
  input.value = '';
  grow();
  busy = true;
  $('send').disabled = true;

  talk.items.push(bubble('me', text));
  const typing = bubble('bot typing', '');
  typing.innerHTML = '<span></span><span></span><span></span>';
  talk.items.push(typing);
  if (current === alias) render();

  try {
    const reply = await talk.chat.send(text);
    talk.items.splice(talk.items.indexOf(typing), 1, bubble('bot', reply));
  } catch (err) {
    talk.items.splice(talk.items.indexOf(typing), 1, bubble('error', err.message));
  } finally {
    busy = false;
    $('send').disabled = false;
    if (current === alias) render();
  }
}

function grow() {
  const input = $('input');
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
}

$('composer').addEventListener('submit', (e) => { e.preventDefault(); send(); });
$('input').addEventListener('input', grow);
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});

start();
`;

const STYLE_CSS = `:root {
  --bg: #f7f7f5; --panel: #ffffff; --text: #16181d; --muted: #6b7280; --line: #e6e4df;
  --accent: #ef9f27; --accent-ink: #1a1206; --bot: #ffffff; --me: #ef9f27; --me-ink: #1a1206;
  --error-bg: #fdecec; --error-ink: #b42318;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1117; --panel: #161922; --text: #f0f0f5; --muted: #9ca3af; --line: #262a36;
    --bot: #1e2130; --error-bg: rgba(239, 68, 68, 0.14); --error-ink: #fca5a5;
    color-scheme: dark;
  }
}

* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body { background: var(--bg); color: var(--text); font: 15px/1.55 system-ui, -apple-system, 'Segoe UI', sans-serif; }

.shell { height: 100%; max-width: 760px; margin: 0 auto; display: flex; flex-direction: column; }

.top { padding: 18px 20px 12px; display: flex; flex-direction: column; gap: 12px; border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 18px; letter-spacing: -0.01em; }
.mark { width: 12px; height: 12px; border-radius: 4px; background: var(--accent); box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 22%, transparent); }

.bots { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; }
.bots[hidden] { display: none; }
.bot {
  flex-shrink: 0; padding: 7px 14px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--line); background: var(--panel); color: var(--muted);
  font: inherit; font-size: 13.5px; font-weight: 600; transition: background .15s, color .15s, border-color .15s;
}
.bot:hover { color: var(--text); }
.bot[aria-selected="true"] { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }

.thread { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 10px; }
.msg { max-width: 82%; padding: 10px 14px; border-radius: 18px; white-space: pre-wrap; overflow-wrap: anywhere; }
.msg.bot { align-self: flex-start; background: var(--bot); border: 1px solid var(--line); border-end-start-radius: 6px; }
.msg.me { align-self: flex-end; background: var(--me); color: var(--me-ink); border-end-end-radius: 6px; }
.msg.error { align-self: flex-start; background: var(--error-bg); color: var(--error-ink); border-end-start-radius: 6px; }

.typing { display: flex; gap: 5px; padding: 14px 16px; }
.typing span { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); animation: blink 1.2s infinite ease-in-out; }
.typing span:nth-child(2) { animation-delay: .15s; }
.typing span:nth-child(3) { animation-delay: .3s; }
@keyframes blink { 0%, 80%, 100% { opacity: .25; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-3px); } }
@media (prefers-reduced-motion: reduce) { .typing span { animation: none; opacity: .6; } }

.composer { display: flex; gap: 8px; align-items: flex-end; padding: 12px 20px 20px; }
.composer[hidden] { display: none; }
.composer textarea {
  flex: 1; resize: none; max-height: 160px; padding: 11px 14px; border-radius: 14px;
  border: 1px solid var(--line); background: var(--panel); color: var(--text); font: inherit; outline: none;
}
.composer textarea:focus { border-color: var(--accent); }
.composer button {
  padding: 11px 18px; border-radius: 14px; border: 0; cursor: pointer;
  background: var(--accent); color: var(--accent-ink); font: inherit; font-weight: 700;
}
.composer button:disabled { opacity: .5; cursor: default; }

.empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 40px 24px; }
.empty[hidden] { display: none; }
.empty h1 { font-size: 19px; margin: 0 0 8px; }
.empty p { color: var(--muted); max-width: 420px; margin: 0; }

@media (max-width: 520px) {
  .top { padding: 14px 16px 10px; }
  .thread { padding: 16px; }
  .composer { padding: 10px 16px 16px; }
  .msg { max-width: 90%; }
}
`;
