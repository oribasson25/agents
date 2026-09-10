-- Supports the Interactions view: sessions are listed newest-first by start
-- time and filtered by channel.
create index if not exists chat_sessions_started_idx on chat_sessions (started_at desc);
create index if not exists chat_sessions_source_idx  on chat_sessions (source);
