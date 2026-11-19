-- Sessions that can be taken back, and access tokens that end.
--
-- A session token was good for seven days whatever happened in between: a
-- password reset of a stolen account, a password change, a removed platform
-- admin. users.token_version goes into every token as `tv`; raising it ends
-- every token signed before. Tokens from before this migration carry no `tv`,
-- which counts as 0 — the default here — so the deploy logs nobody out.
alter table users add column if not exists token_version integer not null default 0;

-- Personal access tokens made from now on end after a year. Existing ones have
-- no end (null) and keep working until revoked; a password reset revokes them.
alter table api_tokens add column if not exists expires_at timestamptz;

-- The brake table is pruned as it is written; this keeps that delete cheap.
create index if not exists auth_throttle_first_at_idx on auth_throttle (first_at);
