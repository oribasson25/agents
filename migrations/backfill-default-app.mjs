/**
 * Hands the default Chat app to accounts made before sign-up started handing
 * it out — the same app, linked to each account's AI Chatbots as they are now.
 *
 *   node migrations/backfill-default-app.mjs --dry   # say who would get it
 *   node migrations/backfill-default-app.mjs         # hand it out
 *
 * Safe to re-run. An account that already got it, at sign-up or from an
 * earlier run, is recognised by the version the app was created with and is
 * skipped, so nobody ends up with two.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const envFile = path.join(HERE, '..', '.env');
  if (fs.existsSync(envFile)) {
    const m = fs.readFileSync(envFile, 'utf8').match(/DATABASE_URL\s*=\s*"?([^"\n]+)"?/);
    if (m) process.env.DATABASE_URL = m[1].trim();
  }
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set (put it in .env or the environment).');
  process.exit(1);
}

const { sql } = await import('../api/_db.js');
const { seedDefaultApp, SEEDED_MESSAGE } = await import('../api/_defaultApp.js');

const DRY = process.argv.includes('--dry');

const users = await sql`
  select u.id, u.username,
         (select count(*)::int from agents a where a.user_id = u.id) as agents
  from users u
  where not exists (
    select 1 from apps p join app_versions v on v.app_id = p.id
    where p.user_id = u.id and v.number = 1 and v.message = ${SEEDED_MESSAGE}
  )
  order by u.created_at
`;

console.log(`${users.length} account(s) without the default app${DRY ? ' (dry run)' : ''}\n`);

let given = 0;
let failed = 0;
for (const u of users) {
  if (DRY) { console.log(`  · ${u.username} (${u.agents} AI Chatbot(s))`); continue; }
  const id = await seedDefaultApp(u.id);
  if (id) given++; else failed++;
}

if (!DRY) console.log(`\nDone: ${given} given${failed ? `, ${failed} failed (see above; re-run to retry)` : ''}.`);
process.exit(failed ? 1 : 0);
