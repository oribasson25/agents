-- Organizations: several people working on the same AI Chatbots, Tables and Apps.
--
-- Until now everything belonged to one user. From here it belongs to an
-- organization, and a user belongs to exactly one:
--
--   org_role = 'admin'   sees and edits everything in the organization, adds
--                        and removes its members and decides what each sees
--   org_role = 'member'  sees what they were given: `org_access` is their
--                        level across the whole organization, and a row in
--                        access_grants overrides it for one item
--
-- users.is_admin keeps meaning what it meant: the platform's own admin, who
-- creates organizations and can open anything.
--
-- `user_id` stays on agents, data_tables and apps, now meaning who is
-- responsible for the item. `org_id` is who it belongs to. A trigger fills
-- org_id from the user on every insert, so the half-dozen places that create
-- an item did not each have to learn about organizations.

create table if not exists organizations (
  id          text        primary key,
  name        text        not null,
  created_by  text        references users(id) on delete set null,
  created_at  timestamptz not null default now()
);

alter table users add column if not exists org_id text references organizations(id) on delete cascade;
-- The safe defaults: a row written without saying otherwise is a member who
-- sees nothing. Every existing account is made its organization's admin below.
alter table users add column if not exists org_role text not null default 'member';
alter table users add column if not exists org_access text not null default 'none';
alter table users add column if not exists must_change_password boolean not null default false;

do $$ begin
  alter table users add constraint users_org_role_check check (org_role in ('admin', 'member'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table users add constraint users_org_access_check check (org_access in ('none', 'view', 'edit'));
exception when duplicate_object then null; end $$;

create index if not exists users_org_idx on users (org_id);

-- One item, one member, one level. No row means the member's org_access.
create table if not exists access_grants (
  user_id     text        not null references users(id) on delete cascade,
  kind        text        not null check (kind in ('agent', 'table', 'app')),
  item_id     text        not null,
  level       text        not null check (level in ('none', 'view', 'edit')),
  granted_by  text        references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (user_id, kind, item_id)
);

create index if not exists access_grants_item_idx on access_grants (kind, item_id);

alter table agents      add column if not exists org_id text references organizations(id) on delete cascade;
alter table data_tables add column if not exists org_id text references organizations(id) on delete cascade;
alter table apps        add column if not exists org_id text references organizations(id) on delete cascade;

create index if not exists agents_org_idx      on agents (org_id);
create index if not exists data_tables_org_idx on data_tables (org_id);
create index if not exists apps_org_idx        on apps (org_id);

-- The organization's model settings. One key drives every AI Chatbot in it.
-- user_settings keeps what is personal: the interface language.
create table if not exists org_settings (
  org_id      text        primary key references organizations(id) on delete cascade,
  provider    text        not null default 'claude',
  api_key     text        not null default '',
  model       text        not null default 'claude-sonnet-5-5',
  ollama_host text        not null default '',
  updated_at  timestamptz not null default now()
);

-- The Claude balance belongs with the key, so with the organization too.
create table if not exists org_credit (
  org_id        text        primary key references organizations(id) on delete cascade,
  balance_cents bigint      not null,
  balance_at    timestamptz not null,
  updated_at    timestamptz not null default now()
);

-- ── every existing account becomes an organization of its own ──
-- Its user is that organization's admin, and everything it owned is the
-- organization's. Nothing changes for anybody: they see exactly what they saw.
insert into organizations (id, name, created_by)
select 'org-' || u.id, u.username, u.id from users u where u.org_id is null
on conflict (id) do nothing;

update users set org_id = 'org-' || id, org_role = 'admin', org_access = 'edit' where org_id is null;

update agents a      set org_id = u.org_id from users u where a.user_id = u.id and a.org_id is null;
update data_tables t set org_id = u.org_id from users u where t.user_id = u.id and t.org_id is null;
update apps p        set org_id = u.org_id from users u where p.user_id = u.id and p.org_id is null;

insert into org_settings (org_id, provider, api_key, model, ollama_host)
select u.org_id, s.provider, s.api_key, s.model, s.ollama_host
from user_settings s join users u on u.id = s.user_id
on conflict (org_id) do nothing;

insert into org_credit (org_id, balance_cents, balance_at, updated_at)
select u.org_id, c.balance_cents, c.balance_at, c.updated_at
from claude_credit c join users u on u.id = c.user_id
on conflict (org_id) do nothing;

-- ── new items take their organization from the user who made them ──
create or replace function set_org_from_user() returns trigger language plpgsql as $$
begin
  if new.org_id is null and new.user_id is not null then
    select org_id into new.org_id from users where id = new.user_id;
  end if;
  return new;
end $$;

drop trigger if exists agents_set_org on agents;
create trigger agents_set_org before insert on agents
  for each row execute function set_org_from_user();
drop trigger if exists data_tables_set_org on data_tables;
create trigger data_tables_set_org before insert on data_tables
  for each row execute function set_org_from_user();
drop trigger if exists apps_set_org on apps;
create trigger apps_set_org before insert on apps
  for each row execute function set_org_from_user();
