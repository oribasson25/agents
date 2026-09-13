-- Knowledge retrieval: make the search index match the queries, and give a
-- document searchable chunks instead of one giant row.
--
-- Two things were wrong.
--
-- 1. The index was built with to_tsvector('english', …) while every query used
--    plainto_tsquery('simple', …). The index stores stems ('open', 'hour'),
--    the query asked for raw words ('opening', 'hours'), so they never met.
--    Even the single word "experience" failed to find a CV containing it.
--    The vector now carries BOTH forms: 'simple' keeps words as written, which
--    is what Hebrew needs since no Hebrew stemmer exists here, and 'english'
--    adds stems so English questions match English documents.
--
-- 2. A document was stored as one row, however long. Retrieval then returned
--    the entire file and ts_rank had nothing to rank. Documents now keep a
--    parent row (what the user sees and edits) plus chunk rows (what search
--    reads), linked by parent_id.

alter table documents add column if not exists parent_id   text;
alter table documents add column if not exists chunk_index integer;
alter table documents add column if not exists normalized  boolean not null default false;
alter table documents add column if not exists raw_content text;

-- A chunk dies with its parent. Existing rows are all parents, so this is safe.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'documents_parent_fk'
  ) then
    alter table documents
      add constraint documents_parent_fk
      foreign key (parent_id) references documents(id) on delete cascade;
  end if;
end $$;

create index if not exists docs_parent_idx on documents (parent_id);
create index if not exists docs_agent_parent_idx on documents (agent_id, parent_id);

-- Rebuild the search vector over both configurations. Dropping the generated
-- column drops its dependent index too, so the gin index is recreated after.
alter table documents drop column if exists tsv;

alter table documents
  add column tsv tsvector
  generated always as (
    to_tsvector('simple',  coalesce(title, '') || ' ' || coalesce(content, '')) ||
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, ''))
  ) stored;

create index if not exists docs_tsv_idx on documents using gin (tsv);
