/**
 * Brings documents stored before the retrieval fix up to date: rebuilds their
 * search chunks and, where the owner has a model configured, runs the rewrite
 * that makes them findable (short sections, resolved references, a bilingual
 * keyword line per section).
 *
 *   node migrations/backfill-knowledge.mjs --dry        # say what would happen
 *   node migrations/backfill-knowledge.mjs --chunk-only # rebuild chunks, no model calls
 *   node migrations/backfill-knowledge.mjs              # rewrite + chunk
 *   node migrations/backfill-knowledge.mjs --agent <id> # just one agent
 *
 * Rewriting spends the document owner's own API credits, one call per ~9k
 * characters, so --dry first is worth it. Safe to re-run: a document that has
 * already been rewritten is rewritten again from its stored original, never
 * from the previous rewrite.
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
const { rechunk, normalizeDocument, chunkText } = await import('../api/_knowledge.js');
const { getUserSettings, resolveApiConfig } = await import('../api/_settings.js');

const DRY = process.argv.includes('--dry');
const CHUNK_ONLY = process.argv.includes('--chunk-only');
const agentArg = process.argv.indexOf('--agent');
const ONLY_AGENT = agentArg > -1 ? process.argv[agentArg + 1] : null;

const docs = await sql`
  select d.id, d.agent_id, d.skill_id, d.title, d.content, d.raw_content, d.normalized,
         d.source_type, a.user_id, a.data->>'name' as agent_name
  from documents d
  join agents a on a.id = d.agent_id
  where d.parent_id is null
    and (${ONLY_AGENT}::text is null or d.agent_id = ${ONLY_AGENT})
  order by d.created_at
`;

console.log(`${docs.length} document(s) to process${DRY ? ' (dry run)' : ''}${CHUNK_ONLY ? ' (chunks only)' : ''}\n`);

const configs = new Map();
async function configFor(userId) {
  if (!configs.has(userId)) {
    const settings = await getUserSettings(userId);
    configs.set(userId, resolveApiConfig(settings, null));
  }
  return configs.get(userId);
}

let rewritten = 0, chunked = 0, skipped = 0;

for (const doc of docs) {
  const label = `${doc.agent_name || doc.agent_id} · ${doc.title}`;
  // Crawled pages are chunked but never rewritten: a crawl is many pages, and
  // that would be many model calls on someone's key without them asking.
  const eligible = !CHUNK_ONLY && doc.source_type !== 'crawl';
  const source = doc.raw_content || doc.content;

  if (DRY) {
    const cfg = eligible ? await configFor(doc.user_id) : null;
    const canRewrite = eligible && cfg && (cfg.provider === 'ollama' ? cfg.ollamaHost : cfg.apiKey);
    console.log(`  ${label}
    ${source.length} chars -> ${chunkText(source).length} chunks${canRewrite ? `, would rewrite with ${cfg.provider} · ${cfg.model}` : ', chunks only'}`);
    continue;
  }

  let content = doc.content;
  if (eligible) {
    const cfg = await configFor(doc.user_id);
    const { text, normalized, reason } = await normalizeDocument({
      title: doc.title, content: source, apiConfig: cfg, agentId: doc.agent_id,
    });
    if (normalized) {
      content = text;
      await sql`
        update documents
        set content = ${text}, raw_content = ${source}, normalized = true, updated_at = now()
        where id = ${doc.id}
      `;
      rewritten++;
      console.log(`  ✓ rewrote  ${label}  (${source.length} -> ${text.length} chars)`);
    } else {
      skipped++;
      console.log(`  · kept     ${label}  (${reason})`);
    }
  }

  const n = await rechunk(doc.id, doc.agent_id, doc.skill_id, doc.title, content);
  chunked += n;
  console.log(`    chunks: ${n || 1}`);
}

if (!DRY) console.log(`\nrewritten ${rewritten}, kept as-is ${skipped}, chunk rows written ${chunked}`);
