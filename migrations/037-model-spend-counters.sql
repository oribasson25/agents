-- What has been spent on models this month, kept as running counters, and
-- money held for calls still in flight.
--
-- Before this, every call summed llm_usage for the month (the platform's
-- spend, and an item's and a member's when they had a limit), and the balance
-- and limits were checked before the call but charged after it, with nothing
-- held in between: fifty calls sent at once all saw the same balance and all
-- went through. Now the gateway (api/_llm.js) holds what a call can cost at
-- most before it is sent — on the organization's balance and on every
-- counter with a cap — in one statement, and settles it to what the call
-- really cost afterwards.
--
-- scope / key:
--   'platform'   / ''                         OpenRouter's cost (the platform's monthly ceiling)
--   'org-public' / <org id>                   OpenRouter's cost of calls strangers set off (widget, apps, WhatsApp)
--   'item'       / <org id>:<kind>:<item id>  what the organization was charged (cost plus markup)
--   'member'     / <org id>:<user id>         what the organization was charged
-- month is the first day of the calendar month (UTC).
create table if not exists llm_month_spend (
  scope       text        not null,
  key         text        not null,
  month       date        not null,
  spent_usd   numeric     not null default 0,
  -- Held for calls in flight. A hold older than ten minutes belongs to a call
  -- that died before settling, and counts as nothing.
  held_usd    numeric     not null default 0,
  held_at     timestamptz,
  -- The cap the last hold was checked against, for reading only.
  cap_usd     numeric,
  primary key (scope, key, month)
);

-- What one statement held on a balance, read back by the same statement.
alter table org_billing add column if not exists last_hold_usd numeric;

-- The share of the platform's monthly ceiling that strangers on one
-- organization's widget, apps and WhatsApp may use up. Without it, one
-- organization's public chatbot could spend the whole ceiling and stop every
-- other organization until the 1st.
alter table platform_billing add column if not exists org_public_cap_pct numeric not null default 50;
-- The same, for one organization, in USD of OpenRouter's cost. Null: the platform's share.
alter table org_billing add column if not exists public_monthly_cap_usd numeric;

-- A ceiling of 0 used to mean "no ceiling" while a limit of 0 meant "stop".
-- 0 now stops, everywhere; a ceiling that was 0 becomes the largest the admin
-- screen accepts, which is what it meant.
update platform_billing set monthly_ceiling_usd = 100000 where monthly_ceiling_usd <= 0;

-- This month so far, so the counters start where the sums are.
insert into llm_month_spend (scope, key, month, spent_usd)
select 'platform', '', date_trunc('month', now() at time zone 'utc')::date, coalesce(sum(cost_usd), 0)
from llm_usage where at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'
on conflict (scope, key, month) do nothing;

insert into llm_month_spend (scope, key, month, spent_usd)
select 'org-public', org_id, date_trunc('month', now() at time zone 'utc')::date, coalesce(sum(cost_usd), 0)
from llm_usage
where at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'
  and org_id is not null and user_id is null and source in ('agents', 'app')
group by org_id
on conflict (scope, key, month) do nothing;

insert into llm_month_spend (scope, key, month, spent_usd)
select 'item', org_id || ':' || item_type || ':' || item_id, date_trunc('month', now() at time zone 'utc')::date, coalesce(sum(charged_usd), 0)
from llm_usage
where at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'
  and org_id is not null and item_type is not null and item_id is not null
group by org_id, item_type, item_id
on conflict (scope, key, month) do nothing;

insert into llm_month_spend (scope, key, month, spent_usd)
select 'member', org_id || ':' || user_id, date_trunc('month', now() at time zone 'utc')::date, coalesce(sum(charged_usd), 0)
from llm_usage
where at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'
  and org_id is not null and user_id is not null
group by org_id, user_id
on conflict (scope, key, month) do nothing;

-- A conversation is stored under the id its first message chose, and only
-- that chatbot, on that channel, may write to it again (api/_agentRunner.js).
-- This finds "is this id taken, and by whom" without reading the messages.
create index if not exists chat_sessions_agent_started_idx on chat_sessions (agent_id, started_at desc);
