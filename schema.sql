-- Run this once in the Neon SQL Editor to initialize the database schema.
-- After running this, also run migrations/002-add-users-and-ownership.sql

create extension if not exists "pgcrypto";

create table if not exists agents (
  id          text        primary key,
  data        jsonb       not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists agents_created_at_idx on agents (created_at desc);

-- RAG knowledge documents (one table for global + skill-specific docs)
create table if not exists documents (
  id          text        primary key,
  agent_id    text        not null references agents(id) on delete cascade,
  skill_id    text,       -- NULL = global RAG | skill.id = skill-specific RAG
  title       text        not null default '',
  content     text        not null,
  tsv         tsvector generated always as (
                to_tsvector('simple', coalesce(title,'') || ' ' || content)
              ) stored,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists docs_agent_skill_idx on documents (agent_id, skill_id);
create index if not exists docs_tsv_idx         on documents using gin(tsv);
