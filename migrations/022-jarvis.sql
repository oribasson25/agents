-- Jarvis: WhatsApp numbers linked as a device (the way WhatsApp on a computer
-- is), each answering with an AI Chatbot by default and with a private Jarvis
-- for the people an admin puts on its list.
--
-- Only admins configure any of this. A person's Jarvis is private: its
-- conversation, memory and reminders live in their own tables, never in
-- chat_sessions, so they never show up in Interactions or in the admin's chat
-- history.

create table if not exists wa_numbers (
  id              text        primary key,
  label           text        not null default '',
  -- Whose AI Chatbots this number may answer with, and whose API settings run it.
  owner_user_id   text        not null references users(id) on delete cascade,
  -- 'agent'  : everyone gets agent_id, people on the list get their Jarvis
  -- 'jarvis' : only people on the list get answers, nobody else does
  mode            text        not null default 'agent',
  agent_id        text        references agents(id) on delete set null,
  enabled         boolean     not null default true,
  -- Digits with country code, known once a phone has linked. Null = not linked.
  phone           text,
  -- What the worker last reported: status, qr (data URL), me, error, updatedAt.
  state           jsonb       not null default '{}',
  -- While an admin has the QR on screen, the worker runs even though nothing is linked.
  qr_wanted_until timestamptz,
  -- At most one worker session holds the connection; this is its lease.
  lease_token     text,
  lease_until     timestamptz,
  -- Something the admin asked the worker to do ('logout').
  command         text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- The linked device's credentials and Signal keys (Baileys auth state).
create table if not exists wa_auth (
  number_id  text not null references wa_numbers(id) on delete cascade,
  k          text not null,
  v          text not null,
  primary key (number_id, k)
);

-- WhatsApp can deliver a message again after a reconnect; answer it once.
create table if not exists wa_seen (
  number_id  text        not null references wa_numbers(id) on delete cascade,
  wa_id      text        not null,
  created_at timestamptz not null default now(),
  primary key (number_id, wa_id)
);
create index if not exists wa_seen_created_idx on wa_seen (created_at);

-- The people who get a private Jarvis on a number.
create table if not exists jarvis_people (
  id                    text        primary key,
  number_id             text        not null references wa_numbers(id) on delete cascade,
  name                  text        not null default '',
  phone                 text        not null,           -- digits with country code
  active                boolean     not null default true,
  prompt                text        not null default '',
  call_name             text        not null default '',
  timezone              text        not null default 'Asia/Jerusalem',
  capabilities          jsonb       not null default '{}',
  proactive             jsonb       not null default '{}',
  admin_can_view_memory boolean     not null default false,
  last_message_at       timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (number_id, phone)
);

create table if not exists jarvis_messages (
  id         bigserial   primary key,
  person_id  text        not null references jarvis_people(id) on delete cascade,
  role       text        not null,                       -- 'user' | 'assistant'
  content    text        not null,
  created_at timestamptz not null default now()
);
create index if not exists jarvis_messages_person_idx on jarvis_messages (person_id, id desc);

create table if not exists jarvis_memory (
  id         bigserial   primary key,
  person_id  text        not null references jarvis_people(id) on delete cascade,
  fact       text        not null,
  created_at timestamptz not null default now()
);
create index if not exists jarvis_memory_person_idx on jarvis_memory (person_id, id);

create table if not exists jarvis_reminders (
  id         bigserial   primary key,
  person_id  text        not null references jarvis_people(id) on delete cascade,
  text       text        not null,
  due_at     timestamptz not null,
  sent_at    timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists jarvis_reminders_due_idx on jarvis_reminders (due_at) where sent_at is null;
