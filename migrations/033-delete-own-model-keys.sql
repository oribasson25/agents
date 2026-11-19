-- The model keys organizations held until models moved to the platform
-- (032), deleted on the platform admin's decision (2026-11-19).
--
-- Run this only once the code that reads models from the platform is live
-- and the platform's OpenRouter key and default model are set under
-- Admin › Billing: the code before that release still answers with these
-- keys. It cannot be undone.
update org_settings  set api_key = '', ollama_host = '' where api_key <> '' or ollama_host <> '';
update user_settings set api_key = '', ollama_host = '' where api_key <> '' or ollama_host <> '';
update agents          set data = data - 'apiConfig' where data ? 'apiConfig';
update agent_branches  set data = data - 'apiConfig' where data ? 'apiConfig';
update starter_agents  set data = data - 'apiConfig' where data ? 'apiConfig';
