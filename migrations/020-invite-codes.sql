-- Sign-up is invitation only.
--
-- There is no way to create an account from the login screen any more. An
-- admin mints a code, hands it over, and that code is the only door in.
--
-- The code is stored the way a password is: only its hash. The plain text is
-- shown once, at the moment it is minted, and the platform cannot show it
-- again — an admin who loses one mints another and revokes the first. What is
-- kept in clear is the first four characters, so a row in the list can still
-- be recognised as the code somebody is holding.
create table if not exists invite_codes (
  id          text        primary key,
  code_hash   text        not null unique,   -- sha256 of the normalised code
  prefix      text        not null,          -- first 4 characters, for the list
  created_by  text        references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  used_at     timestamptz,
  used_by     text        references users(id) on delete set null
);

create index if not exists invite_codes_created_idx on invite_codes (created_at desc);

-- Which language the interface speaks is asked once, on first arrival, and the
-- answer belongs to the account rather than to the browser that was in front
-- of them at the time. Accounts that already exist are not asked again:
-- whatever they are reading today, they have been reading it for a while.
alter table user_settings add column if not exists language_chosen boolean not null default false;
update user_settings set language_chosen = true where language_chosen = false;
