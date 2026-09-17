-- The GitHub repository behind an agent.
--
-- A repository is made the first time someone actually pulls the agent, not
-- when the agent is created: every sign-up is handed starter agents, and most
-- of them are never opened in an editor at all.

create table if not exists agent_repos (
  agent_id     text        primary key references agents(id) on delete cascade,
  owner        text        not null,
  repo         text        not null,
  webhook_id   bigint,
  -- The last commit this platform itself wrote. The webhook ignores it, so a
  -- mirrored push does not come straight back in as an incoming change.
  last_push_sha text,
  created_at   timestamptz not null default now(),
  unique (owner, repo)
);
