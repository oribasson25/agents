-- A soft brake on password guessing.
--
-- Login has never limited attempts, so a stolen or guessed username can be
-- hammered as fast as the network allows. scryptSync is slow, which helps, but
-- it is not a lockout. This records failures per (key), where the key is a
-- username or a client address, in a short rolling window.
--
-- It is deliberately forgiving: the limiter fails OPEN (if this table cannot
-- be read, the login proceeds), the window is short, and a success clears the
-- record. It exists to make bulk guessing expensive, not to lock out a person
-- who fat-fingered their password five times.
create table if not exists auth_throttle (
  bucket      text        primary key,          -- 'user:<name>' or 'ip:<addr>'
  fails       int         not null default 0,
  first_at    timestamptz not null default now(),
  locked_until timestamptz
);

create index if not exists auth_throttle_locked_idx on auth_throttle (locked_until);
