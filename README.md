# 8Legs.ai

Platform for building AI agents: prompt, model, skills, Python tools, a knowledge base, and
distribution over a website widget and WhatsApp — configured in the browser, with no build step.

The in-app **Documentation** tab is the user-facing guide, and is written in English whichever
language the interface is set to. This file covers running and maintaining the deployment.

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
- **Models** — any model on OpenRouter, through the platform's one key; the platform admin picks the model each organization runs on
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
  _invites.js              invitation codes: mint, check, claim, release
  _settings.js             the account's provider/key/model, and resolving it
  _whatsappClaim.js        a phone number belongs to one agent
  agents.js, agents/[id]/  CRUD, documents, RAG retrieval, crawl
  admin/                   users, chat history, per-user agents, invitation codes
  auth/                    login, register (invitation only), invite-check
  chat-sessions.js         the Interactions list, filtered
  gmail/                   OAuth start, callback, status, disconnect, send
  whatsapp/                webhook, connection test
  widget/                  public embed endpoints
  cron/crawl-all.js        re-crawls every agent's sites
migrations/                schema changes, applied in filename order
  run.mjs                  the migration runner
privacy.html               public privacy policy, served at /privacy
terms.html                 public terms, served at /terms
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
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | first run | used once, to create the first administrator on a database with no users. After that the admin mints invitation codes |
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

## Models

Models come only from the platform. Every call to a model goes through the server — the gateway
in `api/_llm.js` — on the platform's one OpenRouter key, in the chat-completions shape. No
organization holds a key: there is nothing to set in Settings, and migration `033` deletes the
keys and Ollama addresses organizations had stored, and every agent's own `apiConfig`.

The platform admin sets it up under **Admin › Billing**: the OpenRouter key (sealed in
`platform_billing` like a connection's tokens, checked with OpenRouter before it is stored), a
default model, a model per organization where it should differ (`org_billing`), and a monthly
ceiling in dollars. `getUserSettings` resolves every person to provider `openrouter` with their
organization's model; `configUsable` is true once the platform has a key and a model. On every
call the model is the organization's, whatever the request asked for.

The browser's calls (the test chat, the building assistants, Autopilot, the home chat) post to
`/api/llm`; the server ones (the channels, knowledge processing, the automation AI step, Jarvis,
the groups and learning a group) call `llmFetch` directly. Jarvis's web search is a tool of its own
that asks OpenRouter's `web` plugin on the same model (`webSearch`). The groups ask for their
decision as a JSON schema when the model supports structured outputs, and in words otherwise;
prompt caching is marked only for `anthropic/` models.

Every successful call is a row in `llm_usage`: organization, the member who set it off (none for a
widget or WhatsApp visitor), what it is charged to (`item_type`/`item_id`), tokens, and the cost
OpenRouter reported. Before each call the month's spend (UTC calendar month) is compared with the
ceiling, and once it is reached every call is refused with a message until the 1st — the platform
stops itself rather than wait for OpenRouter's own budget to refuse. A 402 from OpenRouter (no
credit) or a 403 (a workspace budget) is OpenRouter refusing the platform's account: the caller
gets `PROVIDER_REFUSED` with OpenRouter's own words, and the error log keeps them (source
`openrouter`). `npm run probe:llm` checks the gateway and the settings resolution.

### Balances and markup

The platform admin sells model use to organizations (migration `034`). An organization can have a
balance in USD (`org_billing.balance_usd`; null means no limit of its own, which is how every
organization starts) and a markup percentage. Every call costs it OpenRouter's cost × (1 + markup
/ 100): one statement in `recordCall` writes the `llm_usage` row with `charged_usd` and takes the
same amount off the balance, so calls finishing together all come off it. Before each call the
gateway refuses with `ORG_BALANCE` once the balance is at or below zero (the last call may take it
a little below). Top-ups, corrections and a limit being removed are rows in `org_topups`, with the
balance after each; the admin types them in Admin › Billing (or an opening balance and markup when
creating an organization), since organizations pay outside the platform.

When an organization has run out, or the platform has reached its ceiling, strangers on the
widget, WhatsApp and Jarvis get the platform's stop message (`stopMessage`, Hebrew when they wrote
in Hebrew; set in Billing, with a built-in default), members see a banner, and the organization's
admin sees the balance, top-ups and this month's charges by item in Settings › Model usage
(`/api/org/billing`) — only what they were charged, never the cost or the markup. Billing shows
the month's charges and profit (counting only calls made since balances existed), and warns when
the balances handed out can buy more at OpenRouter than is left under the ceiling.

### Models per item, and monthly limits

The platform admin gives each organization a list of models (`org_billing.allowed_models`,
migration `035`) besides its default. An AI Chatbot (`data.model`), an automation's AI step
(`config.model`) and an app (`app.json` `"ai": { "model" }`) may name one; `resolveApiConfig(settings,
{ model })` uses it only while the list has it, and the default otherwise, so taking a model off
the list moves its users back without touching them. The browser's test chat sends the draft's
model to `/api/llm` the same way. `/api/models` gives a member the list with the organization's
prices (OpenRouter's × the markup) for the pickers.

`legs.ai(prompt | { system, prompt, messages, json, maxTokens })` lets an app call a model directly
(`op: 'ai'` in `api/app-run.js`), only when its `app.json` has `"ai"`; it is charged to the app.

`usage_limits` holds the organization admin's monthly caps, in charged USD, on an item (`agent`,
`app`, `automation`, `number`) or a `member`. `gate()` in `api/_llm.js` reads the balance and both
caps in one query before each call and refuses with `ITEM_LIMIT` (strangers get the stop message)
or `MEMBER_LIMIT` (only that member is stopped). They are set in Settings › Model usage
(`PUT /api/org/billing { kind, targetId, monthlyUsd }`).

`OPENROUTER_BASE_URL` overrides where the gateway sends calls, for local testing against a
stand-in; never set it in production.

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
in English either way. One manual rather than two: two would mean one of them quietly falling a
release behind the other, and a stale manual is worse than one in a second language. Settings
says so under the switch.

**Asked once, on the account.** `user_settings.language_chosen` is what decides whether to ask,
and it is set only by an answer — the language screen posts `languageChosen: true`, and so does
touching the switch in Settings. Every other save round-trips whatever the server last said, so
saving an API key cannot silently answer a question nobody was shown. Migration 020 marks every
existing row as answered, because whatever those accounts are reading, they have been reading it
for a while.

It used to hang off the same `localStorage` flag as the tour, which got it wrong in both
directions: a second person signing in on the same machine was never asked, and the same person
on a new laptop was asked again. It also runs on a phone, where the tour does not — a spotlight
over a phone's nav is a different design, but this is a screen with two buttons on it.

## Invitation-only sign-up

There is no way to create an account from the login screen. An admin mints a code in
**Admin -> Invitations**, hands it over, and that code is the only door in.

The code is `7QF4-2MKD-8RTV`: twelve characters from a 31-letter alphabet with no `0/O` and no
`1/I/L`, because it gets read out over the phone. About 59 bits, which is far past guessable at
one HTTP request a go. Case, spaces and misplaced dashes all wash out on the way in
(`normalizeCode`), so a code retyped in lower case with the dashes in the wrong places is still
the same code.

**It is stored the way a password is** — `invite_codes.code_hash` holds a sha256 and nothing
else. The plain text exists for the length of one response; there is no endpoint that reads one
back, and the list shows `prefix` (the first four characters) because there is nothing else to
show. An admin who loses one mints another and revokes the first.

**One code, one account.** `/api/auth/invite-check` is public and tells the login screen whether
to show a form; it reserves nothing. The gate is `claimInvite`, one UPDATE with `used_at is null`
in its WHERE, so two people racing the same code both reach it and Postgres lets exactly one of
them change the row. Registration checks the username first (a name already taken must not cost
somebody their invitation), claims the code, then writes the account — and hands the claim back
with `releaseInvite` if that last step falls over. `used_by` is filled in afterwards, because it
is a foreign key and there is no user to point at yet.

Codes expire by themselves after 14 days and can be revoked while open. `inviteState` reduces a
row to one of `open` / `used` / `revoked` / `expired`, and `refusal` turns that into the sentence
the person at the door reads.

`probes/invite-probe.mjs` covers the alphabet, the normalising, the race, the release on a failed
registration, and that the plain code never appears among the values written to the database.

## Two tours

**The language, first of all.** Before either tour comes the one question — English or עברית,
written in both, because nobody can read the one they have not chosen yet. It is a screen of its
own rather than a step of the tour, and the tour waits for it: there is no point reading five
cards in a language nobody picked. A failed save still lets them carry on in the language they
chose. See **Language** above for where the answer lives.

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
So the site crawl, the file uploads, the table, the Gmail connection and the channel
all happen inside it, against the same endpoints the editor calls.

Nobody is asked about a base prompt or a skill. They are asked about the business and about what
has to happen, and `autopilotBrief` turns every answer into one paragraph that `autopilotGenerate`
sends to the account's model, which returns the name, opening message, base prompt and skills as
JSON.

Two of the screens are conditional, which is why the flow is an ordered list rather than
`step + 1`: knowledge is dropped when the plan says it is not needed, and connections appear only
when a tool was proposed. There is no key screen — models come from the platform.

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

A note on the file upload, because it failed in a way that left no trace. The `change` handler
clears the input the moment it returns, so the same file can be chosen twice — and the input's
`FileList` is live, so clearing it empties the list the handler just passed on. `uploadFiles`
awaited before reading that list, by which point it was empty: no row appeared and no document
arrived, and nothing was logged either way. It copies the list synchronously now, before anything
can yield. `ensureAgent` was fixed alongside it — it read the agent id out of state, which has not
landed when a second caller arrives, so two quick actions could each create an agent; the id lives
in a ref and concurrent callers share one promise.

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

### Publishing it, step by step

`gmail.send` is **sensitive**, not **restricted**. That is the distinction that decides the cost:
sensitive means a review of a few business days, restricted would mean a CASA third-party
security assessment and a bill. There is no assessment here.

**The domain is `8legs.world`.** `8legs.ai` is the product name and does not resolve — nothing in
the submission may point at it, and no contact address may live on it. The values below are the
ones to paste; getting one of them wrong is the usual cause of a rejection.

| Console field | Value |
| --- | --- |
| App name | `8Legs.ai` |
| User support email | `oribasson25@gmail.com` |
| Application home page | `https://www.8legs.world/` |
| Privacy policy link | `https://www.8legs.world/privacy` |
| Terms of service link | `https://www.8legs.world/terms` |
| Authorised domain | `8legs.world` |
| Developer contact | `oribasson25@gmail.com` |
| Authorised redirect URI | `https://www.8legs.world/api/gmail/callback` |
| Scopes | `.../auth/gmail.send` and `.../auth/userinfo.email` |

The three public pages are already there and linked from the sign-in screen: `/` describes the
product, and `privacy.html` and `terms.html` are plain static files routed in `vercel.json` ahead
of the `/` catch-all. Both name the domain explicitly, because a reviewer seeing an app called
8Legs.ai on 8legs.world will otherwise ask.

Then, in order:

1. **Verify `8legs.world` in Google Search Console**, signed in as `oribasson25@gmail.com` — the
   same account that owns the Cloud project. This is the step most submissions fail on, and the
   failure is not reported as "unverified domain"; it comes back as a missing or unreachable home
   page. Either method works:
   - *HTML file* — Search Console gives a `google<hash>.html`. Drop it in the repo root, commit,
     push. Vercel serves root files as they are (`/widget-test.html` proves it), so it is live on
     the next deploy and Verify passes.
   - *DNS TXT* — a TXT record on `8legs.world`. Verifies the apex and `www` together, and does not
     need a deploy.
2. **Set `APP_URL` in Vercel** to `https://www.8legs.world` before submitting. Without it the
   redirect URI is derived from the request host, so a preview deployment sends Google a
   `redirect_uri` that is not on the authorised list and the flow dies at Google's screen.
3. **APIs & Services -> OAuth consent screen** — fill in the table above. Set the user type to
   **External**.
4. **Scopes** — add `.../auth/gmail.send` and `.../auth/userinfo.email`, and justify the first in
   one plain sentence: *the user connects their own mailbox so the chatbot they built can send
   email on their behalf; the app never reads mail, and holds no scope that would let it.*
5. **Demo video** — an unlisted YouTube screen recording showing the whole flow end to end:
   signing in at `www.8legs.world`, a chatbot's Tools tab, pressing Connect, Google's own consent
   screen with the scopes visible, and an email arriving. Google does not approve a Gmail scope
   without watching it be used, and a video that starts after the consent screen is the second
   most common rejection.
6. **Publish app**, then **Submit for verification.** Expect 3-5 business days and one round of
   questions. Answer from `oribasson25@gmail.com`, not from anywhere else.

Until it is published, each address that needs to connect goes on the Test users list — and keeps
losing its refresh token every seven days.

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

`npm run migrate -- --upto 032` stops after the files numbered up to 032 and leaves the rest
pending — for a release whose later migration must wait until its code is live (033 deletes the
model keys the code before 032 still reads).

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

## Automations

An automation is one trigger and a graph of steps, drawn on a canvas
(**Automations** in the sidebar) and run by the platform.

- **Triggers**: a manual run, a webhook (`/api/hook/<key>`), or a schedule
  (every N, a time of day on chosen days, or cron — in the platform's time zone);
  and the three under "Reaching out" below.
- **Steps**: Code (Python, the same runner tools use), HTTP request (method,
  params, headers, auth, body; imports a cURL line), If, Switch, Loop, Wait,
  Set values, Run automation, Output; and the ones under "Reaching out".
- **References**: a field reads an earlier step as `{{step_id.field}}`, the
  trigger as `{{trigger.…}}`, a secret as `{{secrets.NAME}}`, and inside a loop
  `{{item}}` and `{{index}}`. A field that is nothing but one reference keeps
  the value's type.
- **Draft and published**: the canvas edits a draft and saves as you go. Test
  runs the draft, for real. Triggers fire what was last published, and only
  while the automation is switched on. Every publish is kept as a version.
- **Runs**: every firing is kept for 30 days with what each step was given and
  returned. A Wait longer than a few seconds parks the run; the cron at
  `/api/cron/automations` carries it on, fires schedules, and picks up a run
  whose function died.
- **Secrets** are stored beside the automation, never in its definition, a
  version or a run log (their values are masked wherever they would appear).

### Reaching out: connections

Three more triggers — a WhatsApp message on a linked number, a new email, a
new table row — and the steps that go with them: Send WhatsApp, Ask for
approval (a yes/no on WhatsApp that parks the run until it is answered), Send
email, Find emails, Table, Ask AI Chatbot and AI.

Mailboxes and WhatsApp numbers are **connections** (`api/_connections.js`,
migration 031): linked once per organization by its admin, named, and used by
name. Tokens are encrypted at rest (AES-256-GCM; key from `CONNECTIONS_KEY`,
else derived from `JWT_SECRET`).

- **Gmail** reuses the Google client and the `/api/gmail/callback` redirect the
  per-chatbot flow already has on file; the connection flow is told apart by
  its signed state. It asks for `gmail.send` and `gmail.readonly`.
- **Microsoft 365** needs `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`
  from a multi-tenant app registered in Microsoft Entra, with the redirect
  `<APP_URL>/api/connections/callback` and delegated `Mail.Send`, `Mail.Read`,
  `User.Read`, `offline_access`. The steps are in the app under
  Documentation › Connections.
- **WhatsApp**: only a number's worker holds its connection, so a step queues
  the message in `wa_outbox` and the worker sends it a couple of seconds
  later — one at a time, at most 120 an hour per number.

### As files

`8legs pull --automation <name>` gives `automation.json`, `steps/<id>.py` for
each Code step, and `layout.json` (`api/_automationFiles.js`). `8legs push`
replaces the draft, all or nothing; `8legs run` runs it and prints every step;
`8legs publish` makes it live. An automation's GitHub repository holds what is
published: a push to `main` that validates is published.

### From elsewhere

A chatbot runs the automations ticked on it (`automation_list`,
`automation_run` — `api/_automationTools.js`). An app runs the ones linked in
`app.json`: `legs.automation('name').run(input)`. The platform assistant
writes, tests and publishes them.

The rules live in `api/_automationSpec.js` (shape, validation, references),
`api/_automationEngine.js` (the walk) and `api/_automationSteps.js` (what each
step does); `api/_automations.js` is the database side. `npm run
probe:automations` checks the first three without a database.

The HTTP step refuses addresses inside the platform's own network, resolving
the name and checking each redirect.

## Scheduled work

`vercel.json` registers two daily crons that re-crawl every agent's configured sites, and raises
`maxDuration` for the crawler, the browser scraper and the WhatsApp webhook.

## Security notes

- An agent belongs to a user; every endpoint verifies ownership before reading or writing.
  Admins can act on any agent.
- The platform's OpenRouter key is sealed (AES-256-GCM) in `platform_billing` and never leaves the
  server. WhatsApp tokens and tool secrets live in the agent's JSONB row, in plaintext, readable
  by the account's owner.
- The platform assistant acts as the signed-in user through the same authenticated endpoints,
  so it cannot reach another account's data. It asks for confirmation before deleting an agent.
- Tool code runs server-side with the environment variables that tool declares. Anyone who can
  edit a tool can read its secrets and run arbitrary Python in the function.
- `/api/run-tool`, `/api/scrape` and `/api/scrape-browser` are reachable
  without authentication. They are called server-to-server by the agent runner; putting them
  behind a shared secret is an open item.
- The widget and the WhatsApp webhook are public by design; conversations through them count
  against the platform's monthly ceiling. Watch **Interactions** and Admin › Billing for volume.
- `/privacy`, `/terms` and `/api/auth/invite-check` are public on purpose. The first two have to
  be, for Google's review; the third reserves nothing and refuses a malformed code without
  touching the database.
- Sign-up is invitation only, and an invitation code is stored as a sha256 — like a password, it
  cannot be read back by anyone, including an admin.
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

Several probes lift source straight out of `agentforge.html` and run it, so a
boundary comment they slice on is load-bearing — inserting code between two of
those markers silently changes what a probe is testing. `invite-probe.mjs`
additionally asserts on the login screen's source: that the sign-in/register
toggle is gone, that registration carries a code, and that the server refuses
one without.
