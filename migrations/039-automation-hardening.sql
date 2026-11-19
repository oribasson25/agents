-- Automations, hardened: runs that stop when told to, chains that cannot go
-- round forever, connections shared on purpose, and the indexes the
-- every-minute paths need.

-- Which worker holds a run. Every write a worker makes is
-- `where claim_id = <its own> and status = 'running'`, so once a person
-- presses Stop (or another worker takes the run over) nothing the first one
-- does brings the run back. See workRun in api/_automations.js.
alter table automation_runs add column if not exists claim_id text;

-- How many times a run's worker died and the run was taken up again; past a
-- few, it fails instead of being picked up forever.
alter table automation_runs add column if not exists reclaims int not null default 0;

-- How deep in a chain of automations starting each other this run is (0 for
-- one a person, a schedule, a webhook or a message started), and the run that
-- started it. Past LIMITS.callDepth a run is refused.
alter table automation_runs add column if not exists depth int not null default 0;
alter table automation_runs add column if not exists parent_run_id text;

-- Who published what runs: a live run acts for them, so it may only use the
-- connections they may use.
alter table automations add column if not exists published_by text references users(id) on delete set null;
update automations set published_by = user_id where published is not null and published_by is null;

-- A connection is somebody's mailbox or number. Those that existed before
-- this stay usable by the whole organization (nothing that ran stops); a new
-- one is usable by whoever added it and the admins until the admin shares it.
alter table connections add column if not exists shared boolean not null default true;
alter table connections alter column shared set default false;

-- A WhatsApp message looks for a run waiting on its sender: by number and
-- phone, among waiting runs only.
create index if not exists automation_runs_wait_idx
  on automation_runs ((state->'wait'->>'numberId'), (state->'wait'->>'phone'))
  where status = 'waiting';

-- The hourly clean-up deletes finished runs by age.
create index if not exists automation_runs_prune_idx
  on automation_runs (started_at)
  where status in ('done', 'failed', 'stopped');

-- Every message and every new row looks for the automations listening for it.
create index if not exists automations_trigger_type_idx
  on automations ((published->'trigger'->>'type'))
  where enabled;
