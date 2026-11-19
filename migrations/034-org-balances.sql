-- What each organization may spend on models, and what it is charged.
--
-- The platform admin sells model use to organizations: each one gets a
-- balance in USD that the admin tops up by hand (the organization pays
-- outside the platform), and a markup. Every call costs the organization
-- what OpenRouter charged for it plus its markup, taken from its balance
-- (api/_llm.js). At zero, everything in the organization stops; strangers on
-- the widget and WhatsApp get the platform's stop message.
--
-- An organization with no balance (null) has no limit of its own: only the
-- platform's monthly ceiling applies. Every organization starts that way, so
-- nothing stops when this release goes live.

-- USD the organization has left. Null: no limit. It can dip just below zero
-- when the last call costs more than was left; the next call is refused.
alter table org_billing add column if not exists balance_usd numeric;
-- Percent added to OpenRouter's cost: 30 means a call that cost $1 takes $1.30.
alter table org_billing add column if not exists markup_pct numeric not null default 0;

-- Every top-up, correction and change of limit, newest last.
create table if not exists org_topups (
  id             bigserial   primary key,
  org_id         text        not null references organizations(id) on delete cascade,
  -- USD added; negative for a correction. 0 when the row only records the limit being removed.
  amount_usd     numeric     not null,
  -- The balance right after it. Null: the organization has no limit any more.
  balance_after  numeric,
  note           text        not null default '',
  by_user        text        references users(id) on delete set null,
  at             timestamptz not null default now()
);
create index if not exists org_topups_org_at_idx on org_topups (org_id, at desc);

-- What strangers on an organization's widget or WhatsApp read once it has run
-- out, or the platform has reached its monthly ceiling. Empty: a built-in one.
alter table platform_billing add column if not exists stop_message_he text not null default '';
alter table platform_billing add column if not exists stop_message_en text not null default '';
