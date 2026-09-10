-- The API key and model move from each agent to the account: one key drives
-- every agent, the test chat, the builder assistants and the platform
-- assistant. Agents keep their old apiConfig in their JSON as a fallback for
-- anyone whose settings row is empty.

create table if not exists user_settings (
  user_id            text        primary key references users(id) on delete cascade,
  provider           text        not null default 'claude',
  api_key            text        not null default '',
  model              text        not null default 'claude-sonnet-4-5',
  ollama_host        text        not null default '',
  assistant_language text        not null default 'he',
  updated_at         timestamptz not null default now()
);

-- Carry over what each user already had, so nothing stops working: the config
-- of their most recently updated agent that actually has a key.
insert into user_settings (user_id, provider, api_key, model, ollama_host)
select distinct on (a.user_id)
       a.user_id,
       coalesce(nullif(a.data->'apiConfig'->>'provider', ''), 'claude'),
       coalesce(a.data->'apiConfig'->>'apiKey', ''),
       coalesce(nullif(a.data->'apiConfig'->>'model', ''), 'claude-sonnet-4-5'),
       coalesce(a.data->'apiConfig'->>'ollamaHost', '')
from agents a
where a.user_id is not null
  and (
    coalesce(a.data->'apiConfig'->>'apiKey', '') <> ''
    or (a.data->'apiConfig'->>'provider' = 'ollama' and coalesce(a.data->'apiConfig'->>'ollamaHost', '') <> '')
  )
order by a.user_id, a.updated_at desc
on conflict (user_id) do nothing;
