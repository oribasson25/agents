# 8Legs.ai

Platform for building AI agents: prompt, model, skills, Python tools, a knowledge base, and
distribution over a website widget and WhatsApp — configured in the browser, with no build step.

The in-app **Documentation** tab is the user-facing guide. This file covers running and
maintaining the deployment.

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
| `APP_URL` | no | base URL for the OAuth redirect; derived from the request when unset |

Leaving `JWT_SECRET` unset falls back to a hard-coded development value — set it.

## Account API settings

The provider, API key and model are account-wide, held in `user_settings` and edited in the
Settings screen — not per agent. Everything the account owns runs on them: every agent, the
widget, WhatsApp, the builder assistants and the platform assistant.

The browser reads the key from `GET /api/settings` because model calls are made client-side in
the test chat and the assistants, the same trust model the per-agent key had. The public
channels resolve it server-side from the agent's owner (`resolveAgentApiConfig`), falling back
to an agent's own stored `apiConfig` only while the account's settings are still empty —
migration `010` backfills them from each user's most recently updated agent that had a key.

`user_settings.assistant_language` (`he` or `en`) selects the platform assistant's language.

## Assistant conversations

The platform assistant is a floating chat, reachable from every screen by the ✨ button in the
corner. Every turn of every assistant — platform, tool and skill — is saved to
`assistant_sessions` (migration `012`) through `PUT /api/assistant-sessions`, and the
**Assistant chats** tab lists them with filters per kind, a keyword search over the
transcripts, and each conversation's tool calls with their arguments and results. Saving is
fire-and-forget: a failure there must never interrupt the conversation.

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
