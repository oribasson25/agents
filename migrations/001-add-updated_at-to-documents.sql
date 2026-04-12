-- Migration: Add updated_at column to documents table
-- Run this in your Neon SQL Editor if you already have documents table

ALTER TABLE IF EXISTS documents ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
