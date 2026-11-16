-- Automations: a trigger and a graph of steps the platform runs.
--
-- An automation is edited as a draft and runs as what was last published:
--
--   data       the draft — what the canvas, the CLI and git write
--   published  the copy that triggers fire; null until the first publish
--
-- Every publish is also kept in automation_versions, so the live automation
-- can be put back to any earlier one. Testing runs the draft.
create table if not exists automations (
  id                text        primary key,
  user_id           text        not null references users(id) on delete cascade,
  org_id            text        references organizations(id) on delete cascade,
  data              jsonb       not null,
  published         jsonb,
  active_version_id text,
  -- A published automation only fires while this is on.
  enabled           boolean     not null default false,
  -- Values the steps read as {{secrets.NAME}}. Never in data, a version or a file.
  secrets           jsonb       not null default '{}',
  -- The unguessable part of the webhook address (/api/hook/<key>).
  hook_key          text        not null unique,
  -- What each step last returned in a test, so the editor can offer real
  -- fields to pick from. Trimmed; never used by a live run.
  samples           jsonb       not null default '{}',
  -- When a schedule trigger fires next; null for every other trigger.
  next_run_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists automations_org_idx on automations (org_id, updated_at desc);
create index if not exists automations_due_idx on automations (next_run_at) where next_run_at is not null;

drop trigger if exists automations_set_org on automations;
create trigger automations_set_org before insert on automations
  for each row execute function set_org_from_user();

create table if not exists automation_versions (
  id            text        primary key,
  automation_id text        not null references automations(id) on delete cascade,
  number        int         not null,
  data          jsonb       not null,
  -- Where it came from: 'ui', 'cli', or 'git' (then commit_sha says which push).
  source        text        not null default 'ui',
  commit_sha    text,
  message       text        not null default '',
  created_by    text        references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  unique (automation_id, number)
);

create index if not exists automation_versions_idx on automation_versions (automation_id, number desc);

-- One firing of an automation.
--
-- `definition` is the automation as it was when the run began: a run that
-- waits a day finishes on the steps it started with, whatever was published
-- in between. `state` is where the run has got to — which steps finished,
-- what each returned, which connections fired — so any function can pick the
-- run up where the last one left it.
create table if not exists automation_runs (
  id            text        primary key,
  automation_id text        not null references automations(id) on delete cascade,
  org_id        text,
  -- 'test' runs the draft from the editor; 'live' is a trigger firing.
  mode          text        not null default 'live',
  -- What started it: 'manual', 'webhook', 'schedule', 'call'.
  source        text        not null default 'manual',
  -- queued → running → (waiting → running)* → done | failed | stopped
  status        text        not null default 'queued',
  definition    jsonb       not null,
  input         jsonb,
  output        jsonb,
  state         jsonb       not null default '{}',
  error         text,
  -- A waiting or queued run is picked up once this has passed.
  resume_at     timestamptz,
  -- Renewed while a function is working the run; a stale one means it died.
  heartbeat_at  timestamptz,
  -- The public address the run was started on, for calling the code runner.
  host          text,
  started_by    text        references users(id) on delete set null,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz
);

create index if not exists automation_runs_list_idx on automation_runs (automation_id, started_at desc);
create index if not exists automation_runs_due_idx on automation_runs (resume_at)
  where status in ('queued', 'waiting');
create index if not exists automation_runs_live_idx on automation_runs (heartbeat_at)
  where status = 'running';

-- What each step was given and what it returned, in the order they ran.
create table if not exists automation_run_steps (
  id          bigserial   primary key,
  run_id      text        not null references automation_runs(id) on delete cascade,
  step_id     text        not null,
  step_type   text        not null,
  step_name   text        not null default '',
  -- 'done', 'failed', 'skipped', 'waiting'
  status      text        not null,
  -- Which way it went on: 'out', 'yes', 'no', a switch case, 'each', 'done'.
  port        text,
  -- Inside a loop: which pass this was (0, 1, 2…); null outside one.
  iteration   int,
  input       jsonb,
  output      jsonb,
  error       text,
  ms          int         not null default 0,
  created_at  timestamptz not null default now()
);

create index if not exists automation_run_steps_idx on automation_run_steps (run_id, id);

-- Members can be given an automation the way they are given a chatbot.
alter table access_grants drop constraint if exists access_grants_kind_check;
alter table access_grants add constraint access_grants_kind_check
  check (kind in ('agent', 'table', 'app', 'automation'));

-- The GitHub repository behind an automation; the same arrangement as
-- agent_repos and app_repos. Its `main` is what is published.
create table if not exists automation_repos (
  automation_id text        primary key references automations(id) on delete cascade,
  owner         text        not null,
  repo          text        not null,
  webhook_id    bigint,
  last_push_sha text,
  created_at    timestamptz not null default now(),
  unique (owner, repo)
);
