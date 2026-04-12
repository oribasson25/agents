-- Add phone column to users table
alter table users add column if not exists phone text;
