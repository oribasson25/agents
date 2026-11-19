-- Models come only from the platform, through OpenRouter.
--
-- Every call to a model goes through the server (api/_llm.js) on the
-- platform's one OpenRouter key. No organization holds a key of its own any
-- more (the keys stored until now are deleted by 033, once this is live). The
-- platform admin chooses the model each organization runs on, or leaves it on
-- the platform's default. Nothing here touches what the code before this
-- release reads, so it can run before that code is replaced.

-- The platform's own settings: one row.
create table if not exists platform_billing (
  id              boolean     primary key default true check (id),
  -- The OpenRouter API key, encrypted like a connection's tokens
  -- (api/_connections.js seal/unseal). Empty until the admin sets one.
  openrouter_key  text        not null default '',
  -- The last four characters, to show which key is set without unsealing it.
  key_hint        text        not null default '',
  updated_by      text        references users(id) on delete set null,
  updated_at      timestamptz not null default now()
);
-- The OpenRouter model id an organization runs on unless it has its own.
alter table platform_billing add column if not exists default_model text not null default '';
-- What the whole platform may spend through OpenRouter in a calendar month
-- (UTC), in USD. 8legs stops every call once this month's calls reach it,
-- with a message, before OpenRouter's own budget would refuse them.
alter table platform_billing add column if not exists monthly_ceiling_usd numeric not null default 50;
insert into platform_billing (id) values (true) on conflict (id) do nothing;

-- The model an organization runs on, when it is not the platform's default.
create table if not exists org_billing (
  org_id          text        primary key references organizations(id) on delete cascade,
  -- An OpenRouter model id, e.g. 'anthropic/claude-sonnet-4.5'. Empty: the platform's default.
  default_model   text        not null default '',
  updated_at      timestamptz not null default now()
);
-- From a first draft of this migration, where an organization could still be on its own key.
alter table org_billing drop column if exists on_openrouter;

-- One row per call to a model.
create table if not exists llm_usage (
  id                 bigserial   primary key,
  at                 timestamptz not null default now(),
  org_id             text        references organizations(id) on delete cascade,
  -- Who set it off: a member in the browser, or the owner of what ran. Null
  -- for a stranger on the widget or WhatsApp.
  user_id            text        references users(id) on delete set null,
  -- 'openrouter'. Kept so a row says how it was paid for.
  via                text        not null,
  -- agents | knowledge | automation | jarvis | groups | group-learning | builder | test-chat | assistant | home
  source             text        not null,
  -- What it is charged to inside the organization: 'agent' | 'automation' | 'app' | 'number' | null
  item_type          text,
  item_id            text,
  model              text        not null,
  input_tokens       integer     not null default 0,
  output_tokens      integer     not null default 0,
  cache_read_tokens  integer     not null default 0,
  cache_write_tokens integer     not null default 0,
  -- What the call cost, in USD, as OpenRouter reported it.
  cost_usd           numeric,
  -- What the organization was charged for it (cost plus its markup). Null
  -- until balances exist.
  charged_usd        numeric
);

create index if not exists llm_usage_org_at_idx on llm_usage (org_id, at desc);
create index if not exists llm_usage_at_idx     on llm_usage (at desc);
