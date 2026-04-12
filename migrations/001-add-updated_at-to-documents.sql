-- Migration: Add updated_at column and fix tsvector language
-- Run this in your Neon SQL Editor if you already have documents table

ALTER TABLE IF EXISTS documents ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- IMPORTANT: Regenerate tsvector columns with 'simple' language (not 'english')
-- to support Hebrew and other non-English languages properly
-- Note: After this, the tsvector column will be regenerated automatically
