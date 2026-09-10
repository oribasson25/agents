/**
 * Applies the SQL files in this directory, in filename order, once each.
 *
 *   npm run migrate            # apply everything still pending
 *   npm run migrate -- --dry   # just say what would run
 *
 * DATABASE_URL comes from the environment or from a local .env file. Applied
 * files are recorded in schema_migrations, so re-running is a no-op. Every
 * migration here is also written to be idempotent on its own (`if not exists`,
 * guarded do-blocks), so a run that fails halfway can simply be re-run once the
 * cause is fixed — and the first run on a database whose early migrations were
 * applied by hand re-applies them harmlessly.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { neon } from '@neondatabase/serverless';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes('--dry');

function loadEnvFile() {
  const envPath = path.join(HERE, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    if (!process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

/**
 * Splits a file into single statements. Postgres over HTTP takes one statement
 * per call, so the split has to respect what a naive split on ';' would break:
 * dollar-quoted blocks (do $$ … $$), strings, and comments.
 */
export function splitStatements(sql) {
  const out = [];
  let buf = '';
  let i = 0;
  while (i < sql.length) {
    const rest = sql.slice(i);

    if (rest.startsWith('--')) {                       // line comment
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? sql.length : nl;
      buf += sql.slice(i, end);
      i = end;
      continue;
    }
    if (rest.startsWith('/*')) {                       // block comment
      const close = sql.indexOf('*/', i + 2);
      const end = close === -1 ? sql.length : close + 2;
      buf += sql.slice(i, end);
      i = end;
      continue;
    }
    if (sql[i] === "'" || sql[i] === '"') {             // quoted literal / identifier
      const quote = sql[i];
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) { j += 2; continue; }   // escaped by doubling
          j++;
          break;
        }
        j++;
      }
      buf += sql.slice(i, j);
      i = j;
      continue;
    }
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
    if (dollar) {                                      // dollar-quoted block
      const tag = dollar[0];
      const close = sql.indexOf(tag, i + tag.length);
      const end = close === -1 ? sql.length : close + tag.length;
      buf += sql.slice(i, end);
      i = end;
      continue;
    }
    if (sql[i] === ';') {
      out.push(buf);
      buf = '';
      i++;
      continue;
    }
    buf += sql[i];
    i++;
  }
  out.push(buf);

  // Drop anything that is only whitespace and comments.
  return out
    .map(st => st.trim())
    .filter(st => st && st.split('\n').some(line => line.trim() && !line.trim().startsWith('--')));
}

async function main() {
  loadEnvFile();
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Put it in .env (it is gitignored) or pass it inline:');
    console.error('  DATABASE_URL=postgres://… npm run migrate');
    process.exit(1);
  }

  const sql = neon(process.env.DATABASE_URL);
  const files = fs.readdirSync(HERE).filter(f => f.endsWith('.sql')).sort();

  await sql`
    create table if not exists schema_migrations (
      filename   text        primary key,
      applied_at timestamptz not null default now()
    )
  `;
  const applied = new Set((await sql`select filename from schema_migrations`).map(r => r.filename));

  const pending = files.filter(f => !applied.has(f));
  if (pending.length === 0) {
    console.log(`Nothing to do — all ${files.length} migrations are already recorded as applied.`);
    return;
  }

  console.log(`${applied.size} applied, ${pending.length} pending:\n${pending.map(f => '  · ' + f).join('\n')}\n`);
  if (DRY) return;

  for (const file of pending) {
    const statements = splitStatements(fs.readFileSync(path.join(HERE, file), 'utf8'));
    process.stdout.write(`${file} — ${statements.length} statement${statements.length !== 1 ? 's' : ''}\n`);
    for (const [idx, statement] of statements.entries()) {
      const label = statement.replace(/\s+/g, ' ').slice(0, 76);
      try {
        await sql(statement);
        console.log(`  ✓ ${label}`);
      } catch (err) {
        console.error(`  ✗ statement ${idx + 1} failed: ${err.message}`);
        console.error(`\n${statement}\n`);
        console.error(`Stopped at ${file}. Fix the cause and run again — nothing after this point ran,`);
        console.error('and the statements that did are all idempotent.');
        process.exit(1);
      }
    }
    await sql`insert into schema_migrations (filename) values (${file}) on conflict do nothing`;
    console.log(`  recorded ${file}\n`);
  }

  console.log('Done.');
}

// Allow importing splitStatements from a test without connecting to anything.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(err => { console.error(err); process.exit(1); });
}
