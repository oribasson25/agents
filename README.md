# 8Legs.ai

Platform for building AI agents: prompt, model, skills, Python tools, a knowledge base, and
distribution over a website widget and WhatsApp — configured in the browser, with no build step.

The in-app **Documentation** tab is the user-facing guide. This file covers running and
maintaining the deployment.

## Stack

- **Frontend** — one file, `agentforge.html`: React 18 + Babel + Monaco loaded from CDNs
- **Backend** — Vercel Serverless Functions under `api/` (Node) plus two Python functions
- **Database** — Neon Postgres; an agent is a single JSONB row in `agents`
- **Models** — Claude (Anthropic), OpenAI, or a self-hosted Ollama, chosen per agent
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

## The starter agent

Every new account is seeded with a copy of the agent named `weather` owned by an admin
(`api/_defaultAgent.js`). The copy is live — editing that agent changes what the next sign-up
receives — and carries the prompt, skills, tools and knowledge documents, but none of the
owner's credentials: no LLM API key, no WhatsApp number or tokens, no Gmail connection, and
tool secret values blanked while their names are kept as a hint. Seeding never throws, so a
missing or renamed template leaves the new account empty rather than failing the sign-up. To
change which agent is the template, rename it or edit `TEMPLATE_AGENT_NAME`.

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
- API keys, WhatsApp tokens and tool secrets live in the agent's JSONB row in plaintext.
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
