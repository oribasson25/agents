-- Connections: accounts an organization links once and its automations use
-- by name — a Gmail mailbox, a Microsoft 365 mailbox, a linked WhatsApp
-- number.
--
-- An automation never holds a token. Its steps say `"connection": "Sales
-- inbox"`, and the name is looked up here when the step runs, inside the
-- automation's own organization. Only the organization's admin adds and
-- removes connections; anyone who can edit an automation can use one.
create table if not exists connections (
  id          text        primary key,
  org_id      text        not null references organizations(id) on delete cascade,
  -- 'gmail' | 'microsoft' | 'whatsapp'
  kind        text        not null,
  -- What automations call it. Unique in the organization.
  name        text        not null,
  -- What to show for it: the mailbox address, or the number's label.
  account     text        not null default '',
  -- gmail / microsoft: the tokens, encrypted (see api/_connections.js).
  -- whatsapp: { numberId } — which linked number may send for automations.
  data        jsonb       not null default '{}',
  -- Set when the account stopped answering (a revoked or expired permission).
  problem     text,
  created_by  text        references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists connections_name_idx on connections (org_id, lower(name));

-- Messages automations asked a linked number to send.
--
-- Only the number's worker holds its WhatsApp connection, so nothing else can
-- send. A step puts the message here and the worker, which looks every couple
-- of seconds, sends it. Sending is paced, and a number can only be asked for
-- so many an hour: a linked number that suddenly sends in bulk is how a
-- number gets banned.
create table if not exists wa_outbox (
  id          bigserial   primary key,
  number_id   text        not null references wa_numbers(id) on delete cascade,
  -- A phone number in digits with country code, or a group's id (…@g.us).
  recipient   text        not null,
  body        text        not null,
  -- What asked for it, e.g. 'automation:<id>'.
  source      text        not null default '',
  -- 'queued' → 'sent' | 'failed'
  status      text        not null default 'queued',
  error       text,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);

create index if not exists wa_outbox_queue_idx on wa_outbox (number_id, id) where status = 'queued';
create index if not exists wa_outbox_recent_idx on wa_outbox (number_id, created_at);

-- What a polling trigger remembers between looks: for a new-mail trigger, the
-- time of the newest message it has already fired for.
alter table automations add column if not exists trigger_state jsonb not null default '{}';
