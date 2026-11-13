-- What is left of an account's Claude credit, as near as Anthropic lets anyone
-- tell. No API returns the remaining balance; the Admin API's cost report does
-- return what the organization spent. So the account enters the balance the
-- Console shows, once, and the platform subtracts what was spent since.
--
-- Its own table, not columns on user_settings: an Admin key can manage the whole
-- Anthropic organization, so it never travels with the settings the browser
-- reads (/api/settings returns the regular key to the page). Only /api/credit
-- touches it, and it only ever sends back the last four characters.
create table if not exists claude_credit (
  user_id            text        primary key references users(id) on delete cascade,
  admin_key          text        not null,
  balance_cents      numeric,                      -- what the Console showed, in cents
  balance_at         timestamptz,                  -- when it showed that
  -- The cost report only has whole UTC days. The day's spend before
  -- balance_at is already out of the balance, so it is kept here and not
  -- subtracted a second time.
  spend_offset_cents numeric     not null default 0,
  updated_at         timestamptz not null default now()
);
