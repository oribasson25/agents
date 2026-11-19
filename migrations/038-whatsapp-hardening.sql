-- WhatsApp: limits on private-chat replies, who joined a group when, and the
-- indexes the hot WhatsApp queries and the hourly cleanups need.

-- One row per reply a linked number sent in a private chat. The router counts
-- these before each reply: so many per chat in ten minutes, so many per number
-- in an hour (a number that answers without end gets banned, and two bots
-- answering each other run up model costs). Kept a day.
create table if not exists wa_dm_replies (
  id          bigserial   primary key,
  number_id   text        not null references wa_numbers(id) on delete cascade,
  -- The chat's jid ("972…@s.whatsapp.net").
  chat        text        not null,
  at          timestamptz not null default now()
);
create index if not exists wa_dm_replies_number_idx on wa_dm_replies (number_id, at);
create index if not exists wa_dm_replies_at_idx on wa_dm_replies (at);

-- When someone joined a group, as the linked number saw it. A recap someone
-- asks for ("what did I miss?") starts no earlier than this: a newcomer is not
-- read what was said before they were there. `member` is the user part of
-- their jid (phone or LID); both are stored when WhatsApp gives both.
create table if not exists wa_group_joins (
  number_id   text        not null references wa_numbers(id) on delete cascade,
  jid         text        not null,
  member      text        not null,
  joined_at   timestamptz not null default now(),
  primary key (number_id, jid, member)
);
create index if not exists wa_group_joins_at_idx on wa_group_joins (joined_at);

-- A linked number's conversations are found by id prefix
-- (wal_<number>_<agent>_<phone>_…) within one chatbot: LIKE 'prefix%' on this
-- index instead of reading every conversation the chatbot has.
create index if not exists chat_sessions_agent_id_prefix_idx on chat_sessions (agent_id, id text_pattern_ops);

-- The hourly cleanups delete by date.
create index if not exists wa_group_events_at_idx on wa_group_events (at);
create index if not exists wa_outbox_created_idx on wa_outbox (created_at);

