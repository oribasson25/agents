-- Groups, part two: the number speaks up on its own. Scheduled messages and
-- reminders, a list of birthdays and other yearly dates, holiday and Shabbat
-- greetings, and a welcome for new members. All of it is set up by an admin on
-- the group's page; nothing here can be changed from inside the group.

alter table wa_groups add column if not exists muted_until timestamptz;   -- only answers when addressed until then
-- { birthdays: { on, time, mode, text }, holidays: { on, time },
--   shabbat: { on, time, city }, welcome: { on, text } }
alter table wa_groups add column if not exists proactive jsonb not null default '{}';
-- The local date each daily job last ran on: { birthdays, holidays, shabbat }.
alter table wa_groups add column if not exists proactive_state jsonb not null default '{}';

-- Messages the number sends on a schedule; a one-time reminder is one of these.
create table if not exists wa_group_schedules (
  id           bigserial   primary key,
  number_id    text        not null,
  jid          text        not null,
  title        text        not null default '',
  kind         text        not null default 'text',   -- text | ai | summary | poll
  body         text        not null default '',       -- the message, the brief for "ai", or the poll question
  poll_options jsonb       not null default '[]',
  repeat       text        not null default 'once',   -- once | daily | weekly | monthly
  on_date      text,                                  -- once: the local day, "YYYY-MM-DD"
  at_time      text        not null,                  -- "HH:MM" in the number's time zone
  weekdays     jsonb       not null default '[]',     -- weekly: 0 (Sunday) – 6
  month_day    int,                                   -- monthly: 1–31 (a shorter month uses its last day)
  next_run_at  timestamptz,                           -- null: finished
  run_now      boolean     not null default false,    -- the admin's "Send now"
  enabled      boolean     not null default true,
  last_run_at  timestamptz,
  last_status  text,
  created_at   timestamptz not null default now(),
  foreign key (number_id, jid) references wa_groups (number_id, jid) on delete cascade
);
create index if not exists wa_group_schedules_group_idx on wa_group_schedules (number_id, jid);
create index if not exists wa_group_schedules_due_idx on wa_group_schedules (number_id, next_run_at) where enabled;

-- Birthdays and other dates that come round every year.
create table if not exists wa_group_dates (
  id         bigserial   primary key,
  number_id  text        not null,
  jid        text        not null,
  name       text        not null,
  phone      text,                                    -- digits; lets the greeting tag the person
  kind       text        not null default 'birthday', -- birthday | anniversary | other
  label      text        not null default '',         -- other: what the day is
  day        int         not null,
  month      int         not null,
  year       int,
  hebrew     boolean     not null default false,      -- celebrate on the Hebrew date (needs the year)
  note       text        not null default '',
  greeted_on text,                                    -- the local day it was last congratulated, "YYYY-MM-DD"
  created_at timestamptz not null default now(),
  foreign key (number_id, jid) references wa_groups (number_id, jid) on delete cascade
);
create index if not exists wa_group_dates_group_idx on wa_group_dates (number_id, jid);
