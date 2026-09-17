-- Branches of an agent.
--
-- `agents.data` stays exactly what it was: the live agent, which is `main`.
-- A branch is one more row carrying its own copy of that same blob, so
-- nothing about the existing agent has to be taken apart to add this, and an
-- agent with no branches behaves as it always did.
--
-- Two kinds:
--   'branch' — an experiment, opened from the CLI or the interface
--   'draft'  — the interface's working copy. There is at most one per agent:
--              editing in the browser writes here and `main` does not move
--              until someone publishes, so the live agent cannot change by
--              accident mid-edit.

create table if not exists agent_branches (
  id             text        primary key,
  agent_id       text        not null references agents(id) on delete cascade,
  name           text        not null,
  kind           text        not null default 'branch',
  data           jsonb       not null,
  base_version   text        not null default '',
  traffic_weight int         not null default 0,
  created_by     text        references users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  merged_at      timestamptz
);

-- A name identifies a branch only while it is open; merged ones keep theirs
-- for history without blocking the name from being used again.
create unique index if not exists agent_branches_name_idx
  on agent_branches (agent_id, lower(name)) where merged_at is null;

-- At most one draft per agent.
create unique index if not exists agent_branches_one_draft_idx
  on agent_branches (agent_id) where kind = 'draft' and merged_at is null;

create index if not exists agent_branches_agent_idx on agent_branches (agent_id) where merged_at is null;

-- Which branch answered a conversation. Null means main, which is every
-- conversation that already exists.
alter table chat_sessions add column if not exists branch_id text
  references agent_branches(id) on delete set null;

create index if not exists chat_sessions_branch_idx on chat_sessions (branch_id);
