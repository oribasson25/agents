-- Run this once in the Neon SQL Editor to initialize the database schema.

create extension if not exists "pgcrypto";

create table if not exists agents (
  id          text        primary key,
  data        jsonb       not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists agents_created_at_idx on agents (created_at desc);
