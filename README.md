# AgentForge

AI Agent Builder Platform — create, configure, test, and export AI agents with structured prompts, skills, and tools.

## Stack

- **Frontend**: Single HTML file (`agentforge.html`) — React 18 + Babel + Tailwind + Monaco via CDN
- **Backend**: Vercel Serverless Functions (`api/`)
- **Database**: Neon Postgres (JSONB storage)
- **Auth**: Password protection via `APP_PASSWORD` env var

## Setup

### 1. Clone the repo

```bash
git clone <your-repo-url>
cd agentforge
npm install
```

### 2. Create Neon database

1. Go to [neon.tech](https://neon.tech) and create a new project
2. Open the SQL Editor and run `schema.sql`
3. Copy the connection string

### 3. Deploy to Vercel

1. Import the repo in [vercel.com](https://vercel.com)
2. Add environment variables:
   - `DATABASE_URL` — your Neon connection string
   - `APP_PASSWORD` — choose a password to protect the app
3. Deploy

### 3.1 Database Migrations (if upgrading)

If you already have an existing database, run these migrations in the Neon SQL Editor:

```sql
-- Add updated_at column to documents (if missing)
ALTER TABLE IF EXISTS documents ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
```

### 4. Access

Go to your Vercel URL → enter your `APP_PASSWORD` → start creating agents.

## Local Development

```bash
cp .env.example .env.local
# Fill in DATABASE_URL and APP_PASSWORD in .env.local
vercel dev
# Open http://localhost:3000
```

## Security Notes

- All agents (including stored API keys) are accessible to anyone with `APP_PASSWORD`
- API calls to Claude/OpenAI are made directly from the browser using the stored key
- Do not share `APP_PASSWORD` publicly
- For multi-user scenarios, consider adding per-user auth
