-- The last address that started a number's WhatsApp worker.
--
-- The worker is started over HTTP, and from inside Vercel only some addresses
-- reach production: the deployment's own URL is behind Vercel's login
-- (Deployment Protection), a bare domain often fails ("fetch failed"), and
-- the project's production URL can be a domain that does not resolve at all
-- (one added to the project before its DNS was set up). So each number keeps
-- the address that last worked, and the cron tries it when its own fails.
--
-- Safe to re-run.

alter table wa_numbers add column if not exists worker_host text;
