-- Claude Sonnet 4.5 (claude-sonnet-4-5) retires on 2026-11-30, after which a
-- request naming it fails. Accounts that saved it move to Claude Sonnet 5.5,
-- the new default, and so does the fallback config each agent keeps in its
-- JSON. Claude Opus 4.5 and Claude Haiku 4.5 are still served, so accounts
-- that chose them keep them; Settings shows them as older models.
--
-- updated_at is left alone on purpose: nobody edited these rows, and the
-- agents' updated_at orders the dashboard.
--
-- Safe to re-run: the second run finds nothing to change.

alter table user_settings alter column model set default 'claude-sonnet-5-5';

update user_settings
set model = 'claude-sonnet-5-5'
where model in ('claude-sonnet-4-5', 'claude-sonnet-4-5-20250929');

update agents
set data = jsonb_set(data, '{apiConfig,model}', '"claude-sonnet-5-5"')
where data->'apiConfig'->>'model' in ('claude-sonnet-4-5', 'claude-sonnet-4-5-20250929');
