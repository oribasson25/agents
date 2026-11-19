-- Which models an organization may choose from, and monthly limits inside it.
--
-- The platform admin gives each organization a list of models. Whoever may
-- edit an AI Chatbot, an app or an automation's AI step can run it on any
-- model in that list; anything that names no model, or one no longer in the
-- list, runs on the organization's default (api/_settings.js). An empty list
-- leaves only the default, which is where every organization starts.
--
-- The organization's admin can cap what one item, or one member, may be
-- charged in a calendar month (UTC). The gateway (api/_llm.js) refuses a call
-- once the cap is reached, the same way it does when the balance runs out.

alter table org_billing add column if not exists allowed_models text[] not null default '{}';

create table if not exists usage_limits (
  org_id       text        not null references organizations(id) on delete cascade,
  -- What is capped: an item ('agent' | 'app' | 'automation' | 'number', as
  -- llm_usage.item_type names it) or a person ('member', by users.id).
  kind         text        not null check (kind in ('agent', 'app', 'automation', 'number', 'member')),
  target_id    text        not null,
  -- USD it may be charged this month (OpenRouter's cost plus the markup). 0 stops it outright.
  monthly_usd  numeric     not null check (monthly_usd >= 0),
  updated_by   text        references users(id) on delete set null,
  updated_at   timestamptz not null default now(),
  primary key (org_id, kind, target_id)
);

-- What an item and a member were charged this month, read before each capped call.
create index if not exists llm_usage_org_item_at_idx on llm_usage (org_id, item_type, item_id, at);
create index if not exists llm_usage_org_user_at_idx on llm_usage (org_id, user_id, at);
