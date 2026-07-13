-- WhatsApp channel: fast phone_number_id -> agent routing
create index if not exists agents_whatsapp_phone_idx
  on agents ((data->'whatsapp'->>'phoneNumberId'));

-- Webhook idempotency: Meta may deliver the same message twice
create table if not exists whatsapp_messages (
  message_id text        primary key,       -- Meta wamid
  agent_id   text        not null,
  created_at timestamptz not null default now()
);
create index if not exists whatsapp_messages_created_idx
  on whatsapp_messages (created_at);
