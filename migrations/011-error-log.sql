-- Failures the assistants can read back. Without this, an error that happened
-- in the widget or on WhatsApp is only visible in the platform's own logs, so
-- an assistant asked to fix a tool has nothing to go on.
create table if not exists error_log (
  id         bigserial   primary key,
  agent_id   text,
  source     text        not null,          -- widget | whatsapp | tool | assistant | save | crawl
  message    text        not null,
  context    jsonb       not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists error_log_created_idx on error_log (created_at desc);
create index if not exists error_log_agent_idx   on error_log (agent_id, created_at desc);
