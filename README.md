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
- **Crawler** — `api/_crawlSite.js`, plain fetch over a site's own HTML and its sitemap
- **Live scraper** — Playwright + Chromium (`api/scrape_browser.js`), renders JS, one page at a time

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

## Two tours

**The language, first of all.** The very first screen a new account sees is one question —
English or עברית — written in both, because nobody can read the one they have not chosen yet. The
answer is saved as the account's `assistantLanguage`, so every screen and every assistant follows
it, and the tour starts immediately in that language. A failed save still lets the tour run in the
language they picked; reading five cards in the wrong one is the worse failure.

**The platform, on arrival.** Five things pointed at in turn: a spotlight on one element, a card
beside it, **Next** to carry on. It changes screens as it goes — the home chat, AI Chatbots,
Tables, Interactions, Settings — so each step shows the real screen rather than naming it. Its
last card offers to build one of their own, which opens Autopilot; the useful next thing is
building something, not reading more.

**The editor, once they have built one.** There is no sense teaching how a chatbot is put together
before somebody has one of their own, and every account is handed the starter chatbots at
registration — so "has a chatbot" is not the question. `seededFrom` is written onto each copy when
the account is seeded, and accounts from before that marker fall back to the ids the account held
when the first tour ended; anything that appears after is theirs. The second tour then opens on
that chatbot and walks its base prompt, skills, tools, knowledge and test chat, naming it as it
goes.

That order also repairs a trigger that never fired: Autopilot opened itself only for an account
with no chatbots, which the starter agents make impossible, so no real user had ever seen it open.

Targets are `data-tour` attributes on real elements, never CSS selectors — a selector breaks
silently the next time something is restyled, an attribute breaks in `probes/tour-probe.mjs`. Each
step names the content it would rather point at and the menu item it settles for when that content
is missing, so a thin account still gets a whole tour; a step whose target never appears moves on
after 2.5s.

The spotlight is one element whose huge `box-shadow` spread paints everything outside the hole —
fewer moving parts than four panels, perfect rounded corners, no seams, and the same shadow
carries the amber glow. The card goes below the target, above it when that does not fit, and
*beside* it when the target is tall, so it never covers what it explains. The one thing this turns
on is the `zoom: 0.72` on `<body>`: `getBoundingClientRect` reports visual pixels and a fixed box
drawn inside the zoomed subtree is scaled again, so every measurement is divided by the zoom
first. Without it the ring lands 28% too small and up and to the left, which reads as a styling
wobble rather than a bug — hence the probe.

Not on phones; that shell has its own tree and a bottom nav. Both are marked seen there rather
than ambushing someone on a desktop later, and both can be replayed from the top of the
Documentation tab.

## Autopilot

A wizard that builds a whole AI Chatbot for somebody who does not know how to build one. It
opens by itself the first time an account with no chatbots is used, and **New AI Chatbot** now
shows a fork first: **Autopilot**, or **Advanced** — the editor, exactly as it was.

The design rests on one rule: when the wizard closes, nothing may be left that needs the editor.
So the API key, the site crawl, the file uploads, the table, the Gmail connection and the channel
all happen inside it, against the same endpoints the editor calls.

Nobody is asked about a base prompt or a skill. They are asked about the business and about what
has to happen, and `autopilotBrief` turns every answer into one paragraph that `autopilotGenerate`
sends to the account's model, which returns the name, opening message, base prompt and skills as
JSON.

Two of the screens are conditional, which is why the flow is an ordered list rather than
`step + 1`. The key screen appears only for an account whose key **works**: the stored key is
tried against the provider in the background while the first question is on screen, and only a key
that answered takes the screen out of the flow, dropping the question count from six to five.
`accountApiUsable` says only that the field is not empty, and a field that is not empty is not a
key — an account here ran for a day with `25102004` in it, and everything reported "configured"
until a model was asked for something.

`verifyApiKey` is the check, and it is cheap on purpose: one token for Claude, a model listing for
OpenAI, an `/api/tags` for a self-hosted server. It now guards Settings too, which is where the
bad key got in; a key the provider refuses is not stored, and the refusal is shown in the
provider's own words. And a build that dies on the key offers **Fix the key**, which returns to
the key screen and then straight back into the build — retrying into the same wall was the only
thing on offer before. The answer is latched when the run starts — supplying the key on screen 3
would otherwise take screen 3 out of the flow and shrink "question 3 of 6" to "of 5" under the
person who had just answered it.

Each screen is shaped by the one before it. `AUTOPILOT_CATALOG` holds six verticals, each with
four jobs; the jobs ticked on screen 2 decide which knowledge sources screen 4 offers, whether
screen 5 shows a Gmail button at all, and which columns a proposed table gets. Every vertical has
at least one job that needs a table and one that needs email, so there is always something to
branch on — `probes/autopilot-probe.mjs` holds that, along with the brief carrying every answer.

**The review loop** is what makes "no going back to settings" true. Screen 8 is a real test chat
beside a free-text notes field; each *Fix and rebuild* folds the notes back into the brief,
regenerates, saves and resets the chat, and raises the round counter. What has already been fixed
stays listed next to it, because after three rounds nobody remembers what they asked for. Only the
green **It all looks right** moves on to publishing, and publishing can be skipped.

Two things worth knowing about the plumbing. The agent row is created on the way into screen 4,
because documents, a crawl and a Gmail token all need something to hang off. And the answers live
in `sessionStorage`, because connecting Gmail hands the browser to Google and gets it back a
minute later — the return lands back in the wizard rather than in the editor.

**Tools, only where there is no alternative.** Almost nothing needs code: knowledge answers
questions, the table records what is collected, Gmail sends, the crawler reads the site. A tool is
for the one thing none of those reach — another company's system. `autopilotDetectTools` runs once,
on the way out of the abilities screen and only when free text was written, and is instructed to
refuse by default: an empty list is the expected answer, and then screen 6 never appears. When one
is warranted, the screen names it in the owner's words, names the service, and gives each
credential a field, numbered steps for fetching it and a link to the right page. `autopilotWriteTool`
then writes the Python per tool, one call each; a tool that does not come back is dropped rather
than saved half-written, because a broken tool inside a chatbot its owner cannot read is worse than
no tool. At most two.

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

Two things reach this screen from elsewhere: a conversation picked in the sidebar, and a
question a "build it for me" button asked. They are instructions, not state, so the screen
reports back through `onHandoffUsed` and App clears them. Without that, leaving Home and
returning replays the last one — the screen never opens fresh, and a seeded question is asked
again, and paid for again, on every visit.

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

## Width

A screen you work in takes the window: the agent editor, the grid of AI Chatbots, the
Interactions table and Admin drop the content column's cap and its deep bottom padding, which
is there so a scrolling page ends clear of the edge. On a 1512pt laptop that was 289px of
gutter and 80px at the bottom going spare. Documentation and Settings keep the 1460 measure —
a line of prose two thousand pixels long is a line nobody finishes.

## The mark as an avatar

An AI Chatbot does not wear an emoji or an uploaded picture: it wears the platform's own mark,
drawn in one of eight colours, with no tile or frame around it. What is stored in `avatar` is a
hex colour. Anything stored before this — an emoji, a data URL — resolves through
`avatarColor()` to one colour of the palette by hashing its own text, so an old AI Chatbot
keeps a stable colour without a migration and without losing its row.

The drawing lives in three places that cannot share code: `spiderPaths(color)` in the browser
as JSX, `markSvgString(color)` in the browser for the embed snippet it hands out as text, and
`api/_mark.js` for the widget the server renders into somebody else's site. The palette is
duplicated in the last of those; `probes/render-probe.mjs` checks the two lists still match.

## Tables

Rows an account keeps and its agents read and write — a price list, orders, leads. A table
belongs to the account, not to one agent, so several can answer from the same rows; which
agent may touch which is a list of table ids on the agent itself (`data->'tables'`), so it
travels with the agent through export, branches and the CLI.

Rows are JSONB against a column definition (`data_tables.columns`), not real Postgres columns:
a table per user table would mean running DDL on somebody's input at runtime and a migration
every time they add a field. Values are coerced to their column's type on the way in, so a
number column never holds `"about fifty"`. Renaming a column keeps its key and the rows follow
it; dropping one leaves the value in the row, invisible but recoverable.

An agent gets four tools, and only when it has a table ticked: `table_list`, `table_find`,
`table_add_row`, `table_update_row`. There is no tool that deletes a row or reshapes a table —
those belong to the person whose account it is. Access is gated twice: the table must be the
owner's *and* ticked on the agent, so a ticked id belonging to somebody else opens nothing.

`api/_tables.js` holds the logic, and all three callers run it: `_agentRunner.js` for the
widget and WhatsApp, `api/agents/[id]/tables.js` for the browser's own tool loop in the test
chat, and the platform assistant, which additionally gets `create_table`. The test chat goes
through the server rather than calling the table endpoints directly, or it would reach tables
the agent is not allowed to touch and stop telling you the truth about your agent.

Every row records who wrote it (`written_by`: `user`, or the agent's id), which is what the
sheet's footer reads back.

### What a field name means, and what a date is

Two things here were quietly losing people's data, both of them worse in Hebrew.

A field was matched to a column by its **exact** key or name, and anything else was dropped
without a word — while `table_add_row` still answered `Added a row`. A chatbot told somebody it
had registered them for an event and wrote `{}`; there are three such rows in the first table
anyone built. A field name now also matches with case, spaces, underscores and hyphens folded
(`שם מלא`, `שם_מלא`, `Full Name`, `full-name` are one column), and a tool that could not place
what it was given says so and lists the columns that exist instead of reporting a save.

Dates went through `new Date(value)`, which reads `9.1.2025` as the ninth month and then loses a
day converting a local midnight to UTC: the 9th of January was stored as **2025-08-31**.
`21/01/2025` was rejected outright and left in a date column as raw text. `parseDay` now reads
ISO as ISO and anything dot- or slash-separated day-first, which is how it is written here, and
assembles the day from its parts so no timezone can move it. A value that is not a day is
refused and named, rather than stored in a date column as prose.

## Gmail, and why only one address connects

`send_email` sends from the mailbox connected on that AI Chatbot (Tools tab), over
`https://www.googleapis.com/auth/gmail.send`. That is a **sensitive** scope, and while the Google
Cloud project's OAuth consent screen is in **Testing**, Google lets only the accounts listed under
**Test users** authorise it. Every other address is refused at Google's own screen and comes back
as `access_denied`, which reads as "no permission" and sends people looking for a setting here.
There isn't one — it is set in the Cloud Console, under APIs & Services -> OAuth consent screen.

Two ways out: add each address as a Test user (up to 100, quick), or publish the consent screen
and put the app through verification (slower, but the only thing that lifts the limit).

The same Testing status has a second effect worth knowing: Google **expires refresh tokens after
7 days** for an unverified app, so even a mailbox that works stops sending about once a week with
`invalid_grant`. `api/_gmail.js` reports that as TOKEN_EXPIRED and says to reconnect; publishing
the consent screen is what stops it recurring.

## Every chatbot knows the date

A model has no clock; left alone it answers "today" from wherever its training stopped, which is
how a booking chatbot offers an appointment in a year that has already gone. So the date is not a
tool a model may or may not call — `api/_now.js` builds a `## Right now` block that opens the
system prompt of **every turn of every chatbot**, and of the platform assistant, which writes
dates into tables itself.

It carries the weekday (a working day here is not a working day everywhere), the date in words,
the time, and `Today is YYYY-MM-DD. Tomorrow is …` — tomorrow because date arithmetic is something
models get wrong unaided — plus an instruction never to answer about the date from training.

The zone is fixed at `Asia/Jerusalem`, not read from the machine. A Vercel function runs in UTC
and a browser runs wherever its owner is sitting; if those disagreed, the test chat would be
telling you about a chatbot you do not have. The browser keeps a word-for-word copy of the block
for its own tool loop, and `probes/now-probe.mjs` compares the two across four instants, including
both sides of the daylight-saving change and an hour that is already tomorrow in Israel while
still yesterday in UTC.

## Saying which chatbot you mean

The home screen lists the account's chatbots under the suggestions. Picking one makes it the
subject of the conversation: an `About <name>` bar appears over the composer, the placeholder
changes to "What should change in …", and what is typed goes out as `About the AI Chatbot "<name>":
…`. The name rides in the message rather than only in the system prompt, so reopening the
conversation weeks later still says what it was about. The subject holds for the whole
conversation — the second question would otherwise lose it in silence — and is cleared by the ✕
or by starting a new chat.

Every chatbot card also carries **Edit with AI** beside **Edit**. It opens the home chat with a request
that names that chatbot and tells the assistant to read it before asking anything, so a change can
be described rather than found: "ask for an email too", "never promise a price". The assistant
makes it through the tools it already has. Naming the chatbot is also what gives the conversation
a title of its own instead of a column of identical ones in the history.

## Crawling a site

One URL on an AI Chatbot's **Knowledge** tab means the domain behind it, not the page. The crawl
starts at whatever that URL redirects to, follows every internal link from every page it reads,
and reads the site's `sitemap.xml` alongside — which is the only way to reach a page that nothing
links to. Four pages are fetched at a time, `robots.txt` is obeyed, and a page limit beside the
field (25 to 500) is what finally stops it.

Three things used to end a crawl on its first page, and each has a test in `probes/crawl-probe.mjs`:

- **A redirect to `www`.** The old loop kept the origin of the URL the user typed and compared
  every link against it, so a site that redirects `example.com` to `www.example.com` — most of
  them — threw away nearly every link it found. On one real site that was 3 links kept out of 44.
  `example.com` and `www.example.com` are now the same site. A subdomain is not, and needs its
  own URL.
- **A thin landing page.** Links were read after the "is there enough text here to store?" test,
  so a splash page or a JavaScript shell was skipped before anything was taken off it.
  Links are read first now, always.
- **`?` in the href.** The link pattern was `href=["']([^"'#?]+)["']`, which discarded every link
  carrying a query string. `?page=2` and `?id=7` are how a great many sites expose the rest of
  themselves. Query strings are kept, minus tracking parameters, and capped at eight variants per
  path so a filter page does not become infinite.

Some smaller things it now gets right: a page is decoded in the character set it declares, so a
Hebrew site served as `windows-1255` is stored as Hebrew rather than mojibake; a non-2xx response
is reported instead of filed as knowledge; two URLs that redirect to the same page are stored
once; and the previous crawl's documents are deleted only once this crawl has a page to put in
their place, so a site that is down for the afternoon does not empty the knowledge base.

It reads the HTML a server returns and does not run JavaScript. A site rendered in the browser
comes back near-empty, and the screen says how many such pages there were.

## Starter agents

Every new account is seeded with a copy of each row in `starter_agents` (migration `018`), the
list an admin picks by hand in the Admin tab. A starter is a **frozen copy** — the agent's
definition and its documents as they were the moment it was marked — so editing your own agent
afterwards changes nothing until you press Refresh, and the panel says when the two have
drifted apart. Each copy carries the prompt, skills, tools and knowledge documents, but none of
the owner's credentials: no LLM API key, no WhatsApp number or tokens, no Gmail connection, and
tool secret values blanked while their names are kept as a hint.

They used to be found by name — the newest admin-owned agent called `weather` or `bobi` — which
had two ways to go wrong. Hand a starter to somebody who is also an admin, let them edit it,
and their copy (same name, later `updated_at`) quietly became the template. And with two agents
of yours named alike, whichever you touched last won without saying so. The list holds ids now,
and `snapshotAgent` refuses anything an admin does not own, so neither is reachable: a copy in
somebody else's account is a different row and can never stand in for the starter. Migration
`018` carries today's two over, frozen as they are, so no account comes up empty on deploy.

Seeding never fails a sign-up: an unreadable starter is logged and skipped, one failing does
not stop the others, and an empty list simply means a new account starts empty — which the
Admin tab warns about. `probes/starters-probe.mjs` holds the guarantees: the frozen copy is
what is handed out, another admin's same-named copy is not, a refresh moves it forward, and
nothing of the owner's travels with it.

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
