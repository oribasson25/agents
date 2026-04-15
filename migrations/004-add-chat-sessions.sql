-- Chat sessions: stores every conversation that happens via the widget
-- (for admin visibility across all agents/users)

create table if not exists chat_sessions (
  id          text        primary key,
  agent_id    text        not null references agents(id) on delete cascade,
  source      text        not null default 'widget',  -- 'widget' | 'test'
  messages    jsonb       not null default '[]',
  started_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists chat_sessions_agent_idx    on chat_sessions (agent_id);
create index if not exists chat_sessions_updated_idx  on chat_sessions (updated_at desc);
