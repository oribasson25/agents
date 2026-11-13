-- The Claude credit card counts what 8legs itself spends with the account's
-- key, instead of reading the organization's spend with an Admin key. The
-- account wanted it to work with the key it already has, and a regular key
-- cannot read any spend from Anthropic — so 8legs adds up the price of every
-- call it makes, from the token counts each response reports.
--
-- No account ever stored an Admin key (the table was empty), so its columns go.
alter table claude_credit drop column if exists admin_key;
alter table claude_credit drop column if exists spend_offset_cents;

-- One row per call to Claude made with an account's key: by an AI Chatbot on
-- any channel, by Jarvis, by knowledge processing, or from the browser (the
-- builder, the test chat, the assistant). cost_usd is null when the model is
-- not in the price table, so an unknown model is visible instead of free.
create table if not exists claude_usage (
  id                 bigserial   primary key,
  user_id            text        not null references users(id) on delete cascade,
  at                 timestamptz not null default now(),
  source             text        not null,
  model              text        not null,
  input_tokens       integer     not null default 0,
  output_tokens      integer     not null default 0,
  cache_write_tokens integer     not null default 0,
  cache_read_tokens  integer     not null default 0,
  web_searches       integer     not null default 0,
  cost_usd           numeric
);

create index if not exists claude_usage_user_at_idx on claude_usage (user_id, at desc);
