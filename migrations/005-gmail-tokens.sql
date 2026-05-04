-- Gmail OAuth token storage per user
create table if not exists gmail_tokens (
  user_id       text        primary key references users(id) on delete cascade,
  email         text        not null,
  access_token  text        not null,
  refresh_token text        not null default '',
  expiry        bigint      not null,
  created_at    timestamptz not null default now()
);
