-- WhatsApp groups for linked numbers: the number joins a group like any member
-- and takes part in the conversation the way its admin set it up (ported from
-- the Grois group bot).
--
-- A group appears here the first time the number sees it, switched off: anyone
-- can add a number to a group, and every reply costs the owner's credit, so an
-- admin turns each group on.

-- Settings that hold for every group of the number: the name and words it
-- answers to, quiet hours, and the limits on how often it may speak.
alter table wa_numbers add column if not exists group_settings jsonb not null default '{}';

create table if not exists wa_groups (
  number_id        text        not null references wa_numbers(id) on delete cascade,
  jid              text        not null,
  name             text,
  mode             text        not null default 'off',     -- off | mention | smart | always
  agent_id         text        references agents(id) on delete set null,  -- null: the number's AI Chatbot
  instructions     text        not null default '',        -- this group's rules; they win over everything else
  engagement       text        not null default 'medium',  -- smart mode: how eager to join in
  reply_length     text        not null default 'low',
  allow_reactions  boolean     not null default true,
  seen_message_id  bigint,                                 -- the last message a turn already considered
  -- Learned from a chat export: { profile, samples, stats, importedAt, job }.
  knowledge        jsonb,
  last_activity_at timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (number_id, jid)
);

-- What was said in the group: the context the number reads before it decides.
-- Kept for 30 days (pruned by the cron).
create table if not exists wa_group_messages (
  id           bigserial   primary key,
  number_id    text        not null,
  jid          text        not null,
  wa_id        text        not null,
  sender_jid   text,
  sender_name  text,
  text         text        not null,
  from_me      boolean     not null default false,
  quoted_wa_id text,
  quoted_text  text,
  ts           timestamptz not null,
  unique (number_id, jid, wa_id),
  foreign key (number_id, jid) references wa_groups (number_id, jid) on delete cascade
);
create index if not exists wa_group_messages_chat_idx on wa_group_messages (number_id, jid, id desc);
create index if not exists wa_group_messages_ts_idx on wa_group_messages (ts);

-- The admin's activity log: what the number did in the group and why. It also
-- counts actions for the per-hour limits.
create table if not exists wa_group_events (
  id          bigserial   primary key,
  number_id   text        not null,
  jid         text        not null,
  at          timestamptz not null default now(),
  action      text        not null,   -- reply | react | silent | limited | error | knowledge
  unsolicited boolean     not null default false,
  details     jsonb       not null default '{}',
  foreign key (number_id, jid) references wa_groups (number_id, jid) on delete cascade
);
create index if not exists wa_group_events_chat_idx on wa_group_events (number_id, jid, at desc);
