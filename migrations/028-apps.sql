-- Apps: small web interfaces an account hosts on the platform.
--
-- An app is a folder of web files (index.html, scripts, styles) plus an
-- `app.json` that names the AI Chatbots and Tables it may reach. Like an
-- agent, the whole thing is one JSONB blob in `apps.data`, which is what is
-- live; it becomes files for the CLI and for git, and comes back from them.
--
-- The slug is the app's address (/a/<slug>/) and is fixed at creation, so a
-- link somebody was sent never moves under them.
create table if not exists apps (
  id                text        primary key,
  user_id           text        not null references users(id) on delete cascade,
  slug              text        not null unique,
  data              jsonb       not null,
  active_version_id text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists apps_user_idx on apps (user_id, updated_at desc);

-- Every change to an app's content is kept, so the live app can be put back
-- to any earlier one. `apps.data` is always a copy of the active version.
create table if not exists app_versions (
  id          text        primary key,
  app_id      text        not null references apps(id) on delete cascade,
  number      int         not null,
  data        jsonb       not null,
  -- Where it came from: 'ui', 'cli', or 'git' (then commit_sha says which push).
  source      text        not null default 'ui',
  commit_sha  text,
  message     text        not null default '',
  created_by  text        references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (app_id, number)
);

create index if not exists app_versions_app_idx on app_versions (app_id, number desc);

-- The GitHub repository behind an app; the same arrangement as agent_repos.
create table if not exists app_repos (
  app_id        text        primary key references apps(id) on delete cascade,
  owner         text        not null,
  repo          text        not null,
  webhook_id    bigint,
  last_push_sha text,
  created_at    timestamptz not null default now(),
  unique (owner, repo)
);
