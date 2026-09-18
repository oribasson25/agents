# 8Legs.ai

Platform for building AI agents: prompt, model, skills, Python tools, a knowledge base, and
distribution over a website widget and WhatsApp — configured in the browser, with no build step.

The in-app **Documentation** tab is the user-facing guide, and is written in Hebrew. This file
covers running and maintaining the deployment.

**What the product calls things.** The interface calls an agent an **AI Chatbot** (plural
*AI Chatbots*), everywhere a person reads: the interface in both languages, the Documentation
tab, the assistants' system prompts and their tool descriptions. That is a label, not a rename
of the thing: the table is still `agents`, the routes are still `/api/agents`, the assistant's
tools are still `create_agent` and friends, and the CLI still pulls an agent folder — renaming
any of those would break the data, the widget and every installed CLI. This file uses the
code's word throughout, and so does the manual wherever it is naming code rather than the
product.

## Stack

- **Frontend** — one file, `agentforge.html`: React 18 + Babel + Monaco loaded from CDNs
- **Backend** — Vercel Serverless Functions under `api/` (Node) plus two Python functions
- **Database** — Neon Postgres; an agent is a single JSONB row in `agents`
- **Models** — Claude (Anthropic), OpenAI, or a self-hosted Ollama, chosen once per account
- **Tools** — user Python executed in `api/run_tool.py`, with `pip install` on demand
- **Crawler** — Playwright + Chromium (`api/scrape_browser.js`), renders JS before extracting

## Layout

```
agentforge.html            the whole app
api/
  _agentRunner.js          one agent turn: RAG, DLP, tool loop, per provider
  _auth.js                 JWT sign/verify, checkAuth, checkAdmin
  _db.js                   Neon client
  _gmail.js                per-agent Gmail: token refresh, send
  _settings.js             the account's provider/key/model, and resolving it
  _whatsappClaim.js        a phone number belongs to one agent
  agents.js, agents/[id]/  CRUD, documents, RAG retrieval, crawl
  admin/                   users, chat history, per-user agents
  auth/                    register, login
  chat-sessions.js         the Interactions list, filtered
  gmail/                   OAuth start, callback, status, disconnect, send
  whatsapp/                webhook, connection test
  widget/                  public embed endpoints
  cron/crawl-all.js        re-crawls every agent's sites
migrations/                schema changes, applied in filename order
  run.mjs                  the migration runner
schema.sql                 initial schema
seed_demo.js               demo data
```

## Setup

```bash
git clone https://github.com/oribasson25/agents.git
cd agents
npm install
```

1. Create a Neon project and run `schema.sql` in its SQL editor.
2. Import the repo in Vercel and set the environment variables below.
3. Apply the migrations (see next section).

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Neon connection string |
| `JWT_SECRET` | yes | signs login tokens and the Gmail OAuth state |
| `GOOGLE_CLIENT_ID` | for Gmail | OAuth client for the `send_email` tool |
| `GOOGLE_CLIENT_SECRET` | for Gmail | same |
| `APP_URL` | no | base URL for the OAuth redirect; derived from the request when unset. Normalised on read (whitespace stripped, scheme added, trailing slash dropped) — a newline pasted in here used to reach Google inside `redirect_uri` and get the whole flow rejected |

Leaving `JWT_SECRET` unset falls back to a hard-coded development value — set it.

### Knowledge base

A document is rewritten once by the account's model on upload — short titled
sections, resolved references, and a keyword line in both Hebrew and English —
then split into chunk rows that search reads. The original is kept in
`raw_content`, so the rewrite is always undoable from the UI.

`node migrations/backfill-knowledge.mjs --dry` reports what would happen to
documents stored before this existed; without `--dry` it rewrites and re-chunks
them, spending the owner's API credits, one call per ~9k characters.
`--chunk-only` rebuilds chunks without calling any model.

## Account API settings

The provider, API key and model are account-wide, held in `user_settings` and edited in the
Settings screen — not per agent. Everything the account owns runs on them: every agent, the
widget, WhatsApp, the builder assistants and the platform assistant.

The browser reads the key from `GET /api/settings` because model calls are made client-side in
the test chat and the assistants, the same trust model the per-agent key had. The public
channels resolve it server-side from the agent's owner (`resolveAgentApiConfig`), falling back
to an agent's own stored `apiConfig` only while the account's settings are still empty —
migration `010` backfills them from each user's most recently updated agent that had a key.

## Language

Hebrew in a layout built for English needs help from the browser: a full stop
lands on the wrong side, and a truncated line loses its opening words because
the ellipsis goes to the head. `<html data-ui-lang>` carries the interface
language, and one stylesheet rule gives every block `unicode-bidi: plaintext`
while it is Hebrew, so each block takes its direction from its own first
letter. A saved chat title is the user's own words in either language, so those
rows carry `dir="auto"` whatever the interface is set to. `Eyebrow` drops its
mono, letter-spaced, upper-cased shape for a Hebrew label — that shape is an
English one, and Hebrew put through it comes out as spaced-apart letters.

The interface is English. `user_settings.assistant_language` (`en` or `he`) switches the whole
of it — chrome and assistants alike — and it is edited as **Interface language** in Settings.
In the browser it lands in one module variable behind `L(en, he)`, `uiLang()` and `uiDir()`;
`setAccountApi` keeps it in step with the account, so a save re-renders the tree in the other
language. The one thing that does not follow it is the **Documentation** tab, which is written
in Hebrew either way — translating that manual is its own piece of work, and Settings says so
under the switch.

## The home screen

The first screen after login is a conversation, not a list: the mark animated in the middle of
the page and one input under it. `HomeChatView` and the Assistant chat are two dressings of
`usePlatformAssistant`, the hook that holds the conversation, the tool loop and the saving —
so the home screen builds agents with the same tools the assistant always had.

Asking for a new agent — in any words, whether it is the first or the tenth — starts an
interview: `homeSystemExtra` tells the model one question per message, and to call
`create_agent` as soon as it knows the job rather than at the end. A question about the
platform, or a change to an agent that already exists, does not: those are answered or done in
one turn. Which of the two a turn is, is the model's reading of what was asked, not a count of
how many agents the account has. When a question has a few likely answers the model ends its
message with a `::options:: a | b | c` line, which the screen turns into buttons; a model that
omits it just produces a message without them.

The screen opens on the time of day and the user's name — `greeting()` — with night counted as
evening, since "good night" is a goodbye.

Beside the thread, `AgentBuildCard` shows the agent this conversation created or changed —
role, skills, tools, channel — filling in as answers arrive. It appears only when there is
something to show, and on a phone it rides inside the thread instead of in a column.

The agent list lives under **Agents**; every route into the editor (a link from Interactions,
the assistant history, the Gmail OAuth return) navigates there. "Build with the assistant",
wherever it is clicked, opens the home chat with that question already asked instead of the
floating bubble — which is hidden on the home screen, since the screen is already a chat.

## Phones

An open keyboard shrinks the visual viewport but leaves `100dvh` alone, so a
shell sized in `dvh` keeps its composer under the keys. `useViewportHeight`
writes `window.visualViewport.height` into `--app-h`, and the shell, the test
drawer and the sheets are sized by it.

The whole app is one unhashed HTML file, so `vercel.json` sends it with
`max-age=0, must-revalidate`. Without that a phone can go on serving an old
build for days after a deploy — which looks exactly like a feature that never
shipped.

The phone shell is a separate React branch (`MobileApp`), and two desktop leaves reach into it
where their proportions do not survive the trip. The test chat (`ChatTestDrawer fullScreen`)
re-cuts its header, padding and composer, because the phone drops the app's 80% zoom and an
iOS-forced 16px field beside a rectangular button comes out squashed. In the agent editor, a
skill or a tool opened inside a tab reports `onDetail`, and the 94px rail and the agent header
step aside so Monaco — minimap off, wrapping on — gets the whole screen instead of the ~270px
left beside them.

## Drafts

Editing in the browser never writes to the live agent: a `PUT /api/agents/:id`
with no branch lands on the agent's draft, opening one if it has none, and
answers with `_branch` set to what it wrote to. The browser reads that back and
notes it on its copy (`SET_BRANCH`), which is what makes the publish bar appear
the moment you type instead of on the next full load of the agent list. The
save is debounced, so that action carries only the branch — replacing the whole
record with the response would undo whatever was typed while it was in flight.

## Assistant conversations

The platform assistant is also a floating chat, reachable by the ✨ button in the corner of
every screen but Home. Every turn of every assistant — platform, tool and skill — is saved to
`assistant_sessions` (migration `012`) through `PUT /api/assistant-sessions`. A row in that list clamps its title to two lines, and the clamp is on a span
inside the button rather than on the button: a button cannot be a
`-webkit-box`, so the engine drops the clamp silently. The row also sets
`flex-shrink: 0`, or a short window squeezes a three-line title into two lines'
worth of box and slices the last one through the middle. What a conversation is
called is derived from
its messages by `sessionTitle`, wherever it is listed: the first thing the user typed
themselves — never the sentence a "build it for me" button put in their mouth — and only its
first sentence, since no list column shows a paragraph. Deriving it at display time rather than
trusting the stored `title` also repairs the rows saved before this existed. The sidebar lists
the recent platform conversations under the nav items and reopens one in the home screen;
**All conversations** below them opens the full history, with filters per kind, a keyword
search over the transcripts, and each conversation's tool calls with their arguments and
results. Saving is fire-and-forget: a failure there must never interrupt the conversation.

## Error log

Failures are recorded in `error_log` (migration `011`) so the assistants can read them back:
tool exceptions raised mid-conversation, turns the widget or WhatsApp could not produce, Graph
API rejections including an expired token, and provider errors. `api/_errorLog.js` writes them
— never throwing, since it runs inside somebody else's catch — prunes rows older than 14 days
on write, and `GET /api/errors` returns them scoped to the caller's own agents.

The browser keeps its own session log for test runs and provider errors. Together they are what
the tool assistant, the skill assistant and the platform assistant receive, so "fix it" works
without pasting a traceback.

## Starter agents

Every new account is seeded with a copy of each admin-owned agent named in
`TEMPLATE_AGENT_NAMES` (`api/_defaultAgent.js`) — currently `weather` and `bobi`. The copies
are live: editing one of those agents changes what the next sign-up receives. Each carries the
prompt, skills, tools and knowledge documents, but none of the owner's credentials — no LLM API
key, no WhatsApp number or tokens, no Gmail connection, and tool secret values blanked while
their names are kept as a hint.

Seeding never fails a sign-up: a missing, renamed or unreadable template is logged and skipped,
and one template failing does not stop the others. `GET /api/admin/starter-agent` reports each
template's state and, when one is missing, why — no agent by that name, an ownerless one, one
owned by a non-admin, or a near-miss name — which the Admin tab shows at the top.

## Migrations

`schema.sql` is the starting point; everything after it lives in `migrations/` and is applied
in filename order, once each, recorded in `schema_migrations`.

```bash
npm run migrate -- --dry   # list what would run
npm run migrate            # apply it
```

`DATABASE_URL` is read from the environment or from a local `.env`. Each file is written to be
idempotent, so a first run against a database whose early migrations were applied by hand
re-applies them harmlessly, and a run that stops on an error can be repeated once the cause is
fixed. The runner splits files into single statements while respecting dollar-quoted blocks,
strings and comments.

Two migrations are load-bearing for features rather than performance:

- `007-whatsapp-hardening.sql` — adds `processed_at`; without it every inbound WhatsApp message
  fails, and adds the unique index that keeps a phone number bound to one agent
- `008-gmail-per-agent.sql` — moves Gmail tokens from user scope to agent scope; without it
  connecting a mailbox fails. It sets the old table aside as `gmail_tokens_user_legacy` rather
  than dropping it, and every agent reconnects

## Local development

```bash
cp .env.example .env       # fill in DATABASE_URL (and JWT_SECRET)
vercel dev                 # or serve agentforge.html and point it at a deployed API
```

There is no build step: editing `agentforge.html` and reloading is the whole loop. Because the
page is transformed by Babel in the browser, a JSX syntax error shows up as a blank screen —
worth transforming the `text/babel` script once before deploying if you changed it heavily.

## Scheduled work

`vercel.json` registers two daily crons that re-crawl every agent's configured sites, and raises
`maxDuration` for the crawler, the browser scraper and the WhatsApp webhook.

## Security notes

- An agent belongs to a user; every endpoint verifies ownership before reading or writing.
  Admins can act on any agent.
- The account API key lives in `user_settings.api_key`, and WhatsApp tokens and tool secrets in
  the agent's JSONB row — all in plaintext, and all readable by the account's owner.
- The platform assistant acts as the signed-in user through the same authenticated endpoints,
  so it cannot reach another account's data. It asks for confirmation before deleting an agent.
- Tool code runs server-side with the environment variables that tool declares. Anyone who can
  edit a tool can read its secrets and run arbitrary Python in the function.
- `/api/run-tool`, `/api/scrape`, `/api/scrape-browser` and `/api/ollama-proxy` are reachable
  without authentication. They are called server-to-server by the agent runner; putting them
  behind a shared secret is an open item.
- The widget and the WhatsApp webhook are public by design; conversations through them bill the
  agent owner's API key. Watch **Interactions** for volume.
- DLP masks credit-card and Israeli-ID shaped numbers before they reach the model and before
  history is stored. It is a filter for those two patterns, not a guarantee.

## Full-text search and language

Documents are indexed with Postgres's `simple` tokenizer, so Hebrew, Arabic and CJK text work
and matching is case-insensitive — but there is no stemming: "car" and "cars" are different
terms. Split long documents by topic and write them in the language users will ask in.

## Agents as code

An agent can be edited in an editor instead of the browser. `npx @8legs/cli
pull <agent>` writes it to a folder — `config.json`, `prompt.md`, a directory
per skill and per tool — and `8legs push` sends it back. The agent editor has
the exact pull command for the agent on screen.

Each agent also gets a private GitHub repository, made the first time someone
pulls it. A `git push` to it is applied the same as `8legs push`: the webhook
validates the pushed tree and, if it holds together, makes it live. If it does
not, the commit is marked failed on GitHub and the agent stays on the last
commit that worked — git has already accepted the push, so declining to run it
is the only honest answer.

Editing in the browser writes to a **draft**, not to the live agent, and the
bar above the tabs is where you publish it. Branches beyond that are
experiments: each can take a share of real conversations, drawn once per
conversation so nobody's agent changes personality halfway through.

### Environment

| Variable | What it is for |
|---|---|
| `GITHUB_AGENTS_TOKEN` | fine-grained token on the agents organisation, with Administration and Contents write |
| `GITHUB_AGENTS_ORG` | the organisation the repositories live in |
| `GITHUB_WEBHOOK_SECRET` | signs webhook deliveries; without it nothing incoming is trusted |

All three are optional. Without them the CLI still works and no repository is
made — only the git half is off.

### Probes

`npm run probe` runs everything under `probes/`. It is the substitute for a
test framework in the two places that have none: `agentforge.html` has no
build step and fails as a blank screen, and a bug in the file converter
deletes fields from a live agent.
