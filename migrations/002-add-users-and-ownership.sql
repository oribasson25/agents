-- Run this in the Neon SQL Editor after 001-add-updated_at-to-documents.sql

-- Users table
create table if not exists users (
  id            text        primary key,
  username      text        unique not null,
  password_hash text        not null,
  is_admin      boolean     not null default false,
  created_at    timestamptz not null default now(),
  last_login_at timestamptz
);

-- Add user_id column to agents (nullable so existing rows aren't broken)
alter table agents add column if not exists user_id text references users(id);

create index if not exists agents_user_id_idx on agents (user_id);
