-- Which agents a new account is handed, chosen deliberately.
--
-- They used to be found by name: the newest admin-owned agent called "weather"
-- or "bobi". Two things went wrong with that. Copy a starter to somebody who is
-- also an admin and let them edit it, and their copy — same name, later
-- updated_at — quietly became the template. And with two agents of yours named
-- alike, whichever you touched last won, without saying so.
--
-- A starter is now a row here: a frozen copy of the agent, taken when an admin
-- marks it, with its documents alongside. Frozen, so editing your own agent
-- afterwards does not change what the next sign-up receives until you refresh
-- the snapshot on purpose; self-contained, so it survives the source agent
-- being renamed, edited or deleted.
create table if not exists starter_agents (
  id              uuid primary key,
  source_agent_id uuid references agents(id) on delete set null,
  name            text        not null,
  data            jsonb       not null,
  documents       jsonb       not null default '[]'::jsonb,
  position        int         not null default 0,
  created_by      uuid references users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists starter_agents_position_idx on starter_agents (position, created_at);

-- Carry over what sign-ups get today, so nobody's next account comes up empty:
-- the same two names, resolved the old way one last time, frozen as they are.
insert into starter_agents (id, source_agent_id, name, data, documents, position, created_by)
select gen_random_uuid(),
       t.id,
       coalesce(t.data->>'name', 'starter'),
       t.data,
       coalesce(
         (select jsonb_agg(jsonb_build_object(
                   'skill_id',    d.skill_id,
                   'title',       d.title,
                   'content',     d.content,
                   'normalized',  d.normalized,
                   'source_type', d.source_type,
                   'source_url',  d.source_url))
            from documents d
           where d.agent_id = t.id and d.parent_id is null),
         '[]'::jsonb),
       t.ord,
       t.user_id
from (
  select distinct on (lower(trim(coalesce(a.data->>'name', ''))))
         a.id, a.data, a.user_id,
         array_position(array['weather', 'bobi'],
                        lower(trim(coalesce(a.data->>'name', '')))) as ord
  from agents a
  join users u on u.id = a.user_id
  where lower(trim(coalesce(a.data->>'name', ''))) = any (array['weather', 'bobi'])
    and u.is_admin
  order by lower(trim(coalesce(a.data->>'name', ''))), a.updated_at desc
) t
where not exists (select 1 from starter_agents);
