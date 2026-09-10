-- WhatsApp webhook hardening (run after 006-whatsapp.sql)

-- 1. Two-phase idempotency.
--    A row is *claimed* when processing starts and *confirmed* (processed_at)
--    only once the reply has been sent. Before this, a crash or a maxDuration
--    timeout left the message marked as handled, so Meta's retry was dropped
--    and the user never got an answer.
alter table whatsapp_messages
  add column if not exists processed_at timestamptz;

-- Existing rows predate the two-phase flow and were all fully handled;
-- confirm them so they aren't treated as stale claims and answered twice.
update whatsapp_messages set processed_at = created_at where processed_at is null;

create index if not exists whatsapp_messages_unconfirmed_idx
  on whatsapp_messages (created_at) where processed_at is null;

-- 2. A phone_number_id may belong to at most one agent.
--    phone_number_id is not a secret, so without this a second tenant could
--    configure a victim's number and hijack — or silently break — routing.
--    The API rejects a conflicting save with 409; this is the backstop.
--
--    If this index fails to create, two agents already share a number. List
--    them and clear the wrong one before re-running:
--
--      select data->'whatsapp'->>'phoneNumberId' as phone_number_id,
--             array_agg(id) as agent_ids
--      from agents
--      where coalesce(data->'whatsapp'->>'phoneNumberId', '') <> ''
--      group by 1
--      having count(*) > 1;
create unique index if not exists agents_whatsapp_phone_uniq
  on agents ((data->'whatsapp'->>'phoneNumberId'))
  where coalesce(data->'whatsapp'->>'phoneNumberId', '') <> '';
