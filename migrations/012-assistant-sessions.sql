-- Conversations with the assistants, so the Assistant tab can show their
-- history. Separate from chat_sessions: those belong to an agent and record
-- end-user conversations, while the platform assistant belongs to the account
-- and isn't tied to any one agent.
create table if not exists assistant_sessions (
  id         text        primary key,
  user_id    text        not null references users(id) on delete cascade,
  kind       text        not null,                       -- platform | tool | skill
  agent_id   text,                                       -- tool/skill assistants only
  subject    text        not null default '',            -- the tool or skill name
  title      text        not null default '',
  messages   jsonb       not null default '[]',
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists assistant_sessions_user_idx on assistant_sessions (user_id, updated_at desc);
create index if not exists assistant_sessions_kind_idx on assistant_sessions (user_id, kind);
