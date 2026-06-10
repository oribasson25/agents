-- Add crawl source tracking to documents table
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS source_type text DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS source_url  text;

CREATE INDEX IF NOT EXISTS idx_documents_source_url
  ON documents(agent_id, source_url);
