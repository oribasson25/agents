-- Gmail moves from user scope to agent scope: every agent connects its own
-- mailbox, so an agent's send_email tool sends from that agent's account.
--
-- Existing user-level connections are NOT migrated (each agent reconnects).
-- The old table is set aside rather than dropped, so a refresh token can still
-- be recovered if someone needs it; drop it once you're sure:
--   drop table gmail_tokens_user_legacy;

do $$
begin
  -- Only rename the pre-agent table, so re-running this migration is a no-op.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'gmail_tokens'
      and column_name  = 'user_id'
  ) then
    alter table gmail_tokens rename to gmail_tokens_user_legacy;
  end if;
end $$;

create table if not exists gmail_tokens (
  agent_id      text        primary key references agents(id) on delete cascade,
  email         text        not null,
  access_token  text        not null,
  refresh_token text        not null default '',
  expiry        bigint      not null,
  created_at    timestamptz not null default now()
);
