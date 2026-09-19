-- Tables: shared knowledge an account keeps, and its AI Chatbots read and write.
--
-- A table belongs to the account, not to one chatbot, so several of them can
-- answer from the same rows. Which chatbot may touch which table is a list of
-- ids on the chatbot itself (`data->'tables'`), so it stays with the agent
-- through export, branches and the CLI.
--
-- Rows are JSONB against a column definition rather than real Postgres
-- columns. Creating a table per user table would mean running DDL on someone
-- else's input at runtime, and a migration every time somebody adds a field.
create table if not exists data_tables (
  id          text primary key,
  user_id     text references users(id) on delete cascade,
  name        text        not null,
  description text        not null default '',
  columns     jsonb       not null default '[]'::jsonb,   -- [{ key, name, type }]
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists data_table_rows (
  id          text primary key,
  table_id    text references data_tables(id) on delete cascade,
  data        jsonb       not null default '{}'::jsonb,
  -- Who put it there: 'user', or the id of the AI Chatbot that wrote it. A row
  -- that looks wrong is a row somebody has to trace.
  written_by  text        not null default 'user',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists data_tables_user_idx on data_tables (user_id, updated_at desc);
create index if not exists data_table_rows_table_idx on data_table_rows (table_id, created_at);
