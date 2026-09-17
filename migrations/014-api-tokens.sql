-- Personal access tokens, so the CLI can act for a user without a password.
--
-- Only the hash is stored: a leaked database row cannot be used as a token.
-- The prefix is kept in the clear so the Settings screen can show which token
-- a row is ("8legs_pat_k3Jd…") without being able to reconstruct it.

create table if not exists api_tokens (
  id           text        primary key,
  user_id      text        not null references users(id) on delete cascade,
  name         text        not null default '',
  token_hash   text        not null unique,
  token_prefix text        not null default '',
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

create index if not exists api_tokens_user_idx on api_tokens (user_id);
create index if not exists api_tokens_hash_idx on api_tokens (token_hash) where revoked_at is null;
