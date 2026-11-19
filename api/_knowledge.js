import { sql } from './_db.js';
import { logError } from './_errorLog.js';
import { llmFetch, replyText } from './_llm.js';
import { configUsable } from './_settings.js';

/**
 * The knowledge base: how a document is prepared when it arrives, and how it
 * is found again at answer time.
 *
 * Both halves were broken. Search asked Postgres for raw words while the index
 * held English stems, so nothing matched — a CV containing "experience" could
 * not be found by searching "experience". And a document was stored whole, so
 * when something did match, the agent was handed the entire file.
 *
 * A document now becomes: one parent row, which is what the user sees and
 * edits, plus chunk rows, which are what search reads. Before chunking, the
 * text goes through the account's model once to be rewritten into something an
 * agent can actually retrieve from — see normalizeDocument.
 */

export const CHUNK_TARGET = 900;    // characters — a couple of paragraphs
export const CHUNK_OVERLAP = 150;   // so a fact split across a boundary survives
export const MAX_NORMALIZE_CHARS = 120000;

/* ─────────────────── chunking ─────────────────── */

/** Sentence-ish split, for a paragraph too long to keep whole. */
function splitLongParagraph(text, limit) {
  const out = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    // Prefer a sentence end, then any space; otherwise cut at the limit.
    const cut = Math.max(
      window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '),
      window.lastIndexOf('\n'), window.lastIndexOf('־'), window.lastIndexOf(' '),
    );
    const at = cut > limit * 0.5 ? cut + 1 : limit;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Splits text into retrieval-sized pieces on paragraph boundaries, keeping the
 * most recent heading with the text under it so a chunk still says what it is
 * about. Consecutive chunks overlap slightly.
 */
export function chunkText(text, { target = CHUNK_TARGET, overlap = CHUNK_OVERLAP } = {}) {
  const clean = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  if (clean.length <= target) return [clean];

  const blocks = clean.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  const pieces = [];
  for (const b of blocks) {
    if (b.length > target * 1.6) pieces.push(...splitLongParagraph(b, target));
    else pieces.push(b);
  }

  const chunks = [];
  let current = '';
  let heading = '';
  for (const piece of pieces) {
    const isHeading = /^(#{1,6}\s|\*\*[^*]+\*\*$)/.test(piece) || (piece.length < 80 && /^[^.!?\n]+:?$/.test(piece));
    if (isHeading) heading = piece.replace(/^#{1,6}\s*/, '').replace(/\*\*/g, '').trim();

    const candidate = current ? `${current}\n\n${piece}` : piece;
    if (candidate.length > target && current) {
      chunks.push(current);
      // Carry the tail of the last chunk plus the heading it lived under. The
      // tail starts at a word boundary: a fragment cut mid-word helps nobody
      // and reads as damage in the middle of a retrieved passage.
      let tail = '';
      if (current.length > overlap) {
        const raw = current.slice(-overlap);
        const at = raw.search(/\s/);
        tail = (at > -1 ? raw.slice(at + 1) : raw).trim();
      }
      const lead = heading && !piece.startsWith(heading) ? `${heading}\n` : '';
      current = `${lead}${tail ? tail + '\n' : ''}${piece}`.trim();
    } else {
      current = candidate;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(c => c.trim().length > 0);
}

/* ─────────────────── the model pass ─────────────────── */

async function callModel(apiConfig, { system, user, maxTokens = 4000, agentId = null }) {
  const { ok, data: d } = await llmFetch({
    cfg: apiConfig,
    meta: { orgId: apiConfig.orgId || null, source: 'knowledge', itemType: agentId ? 'agent' : null, itemId: agentId },
    body: { max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] },
  });
  if (!ok) throw new Error(d.error?.message || JSON.stringify(d));
  // A refusal comes back as no text; the caller keeps the original rather than store nothing.
  return replyText(d);
}

const NORMALIZE_SYSTEM = [
  'You rewrite source material into a knowledge base an AI agent retrieves from with keyword search.',
  '',
  'The search is lexical, not semantic: a passage is only found when the words in it overlap the words',
  'in the question. Your whole job is to make that overlap likely, without inventing anything.',
  '',
  'Rules:',
  '1. Keep every fact. Never add a fact that is not in the source, never guess, never fill a gap. If',
  '   something is unclear, keep the original wording rather than smoothing it into something wrong.',
  '2. Break the text into short sections under `## ` headings, each about ONE subject. A section should',
  '   stand on its own: someone reading only that section must understand it.',
  '3. Resolve references. Replace "he", "it", "the company", "this service", "there" with the actual name.',
  '   Repeating the subject in every section is correct here, not redundant.',
  '4. One fact per line where the material is a list of facts (hours, prices, rules, specs, dates).',
  '   Keep prose as prose where it is genuinely prose.',
  '5. Spell things out the way a person would ask for them. Expand abbreviations on first use in each',
  '   section — "CV (curriculum vitae, resume)" — and keep common synonyms next to the term.',
  '6. End EVERY section with a line in this exact form:',
  '   **Keywords:** word, word, word | מילים: מילה, מילה, מילה',
  '   The English half lists the words an English question would use. The Hebrew half lists the words a',
  '   Hebrew question would use for the SAME content — translate the terms, transliterate names',
  '   ("Ori Basson — אורי בסון"). This is what lets a Hebrew speaker find an English document.',
  '7. Write the section bodies in the language of the source. Do not translate the material itself.',
  '8. Output only the rewritten document. No preamble, no explanation, no code fences.',
].join('\n');

/** Splits on paragraph boundaries into slices the model can take in one pass. */
function sliceForModel(text, limit = 9000) {
  if (text.length <= limit) return [text];
  const paras = text.split(/\n\s*\n/);
  const slices = [];
  let cur = '';
  for (const p of paras) {
    if (cur && (cur.length + p.length + 2) > limit) { slices.push(cur); cur = p; }
    else cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur.trim()) slices.push(cur);
  return slices;
}

/**
 * Runs the source text through the account's model so it comes out in a shape
 * keyword search can actually reach — short titled sections, references
 * resolved, and a bilingual keyword line per section.
 *
 * Best effort by design: if there is no usable key, or the model errors, or it
 * comes back suspiciously short, the original text is kept. Losing a document
 * would be a far worse failure than storing it unimproved.
 */
export const NORMALIZE_CONCURRENCY = 4;
export const NORMALIZE_BUDGET_MS = 200 * 1000;   /* of the 300 s the upload function has */

/** Rejects when `ms` runs out first; the work itself is not cancelled. */
function within(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('ran out of time')), Math.max(1, ms)); }),
  ]).finally(() => clearTimeout(timer));
}

export async function normalizeDocument({ title, content, apiConfig, agentId, budgetMs = NORMALIZE_BUDGET_MS, call = callModel }) {
  const source = String(content || '');
  const usable = configUsable(apiConfig);
  if (!usable || !source.trim()) return { text: source, normalized: false, reason: 'no model configured' };
  if (source.length > MAX_NORMALIZE_CHARS) {
    return { text: source, normalized: false, reason: `too large (${source.length} chars)` };
  }

  try {
    /* The slices go to the model a few at a time, not one after the other: a
       document of 14 slices at up to a minute and a half each used to outlast
       the function, which was then killed before anything was stored. They
       come back in their own order, and the whole pass has a time budget —
       past it the original text is kept. */
    const slices = sliceForModel(source);
    const deadline = Date.now() + budgetMs;
    const out = new Array(slices.length);
    let next = 0;
    let late = false;
    const worker = async () => {
      while (next < slices.length && !late) {
        const i = next++;
        const left = deadline - Date.now();
        if (left <= 0) { late = true; return; }
        const part = slices.length > 1 ? ` (part ${i + 1} of ${slices.length})` : '';
        out[i] = await within(call(apiConfig, {
          system: NORMALIZE_SYSTEM,
          user: `Document title: ${title || '(untitled)'}${part}\n\n---\n${slices[i]}\n---`,
          maxTokens: 8000,
          agentId,
        }), left);
      }
    };
    await Promise.all(Array.from({ length: Math.min(NORMALIZE_CONCURRENCY, slices.length) }, worker));
    if (late || out.some(x => x === undefined)) {
      return { text: source, normalized: false, reason: 'ran out of time, kept the original' };
    }
    const joined = out.filter(Boolean).join('\n\n').trim();

    // A model that returns a summary instead of a rewrite would quietly delete
    // most of the knowledge base. Anything that short is treated as a failure.
    if (joined.length < Math.min(200, source.length * 0.4)) {
      return { text: source, normalized: false, reason: 'model returned too little, kept the original' };
    }
    return { text: joined, normalized: true, reason: '' };
  } catch (err) {
    await logError({ agentId, source: 'knowledge', message: err.message, context: { step: 'normalize', title } });
    return { text: source, normalized: false, reason: err.message };
  }
}

/* ─────────────────── storing ─────────────────── */

/**
 * Replaces a document's chunk rows with ones built from `content`.
 *
 * One statement: the old chunks go and the new ones arrive together (a
 * function killed half-way used to leave a document half chunked, and hidden
 * from search because it had children), and all of them in one insert rather
 * than a round trip each. `fresh` says the document was just created and has
 * no chunks to delete.
 */
export async function rechunk(docId, agentId, skillId, title, content, { fresh = false } = {}) {
  const chunks = chunkText(content);
  if (chunks.length <= 1) {   // short enough to be its own chunk
    if (!fresh) await sql`delete from documents where parent_id = ${docId}`;
    return 0;
  }
  if (fresh) {
    await sql`
      insert into documents (id, agent_id, skill_id, parent_id, chunk_index, title, content, source_type)
      select ${docId}::text || '#' || (t.n - 1)::text, ${agentId}, ${skillId || null}, ${docId}, (t.n - 1)::int,
             ${title}, t.c, 'chunk'
      from unnest(${chunks}::text[]) with ordinality as t(c, n)
    `;
  } else {
    /* Reading `gone` makes the delete run first, so the new rows (which reuse
       the old ids) never meet the old ones. */
    await sql`
      with gone as (delete from documents where parent_id = ${docId} returning 1)
      insert into documents (id, agent_id, skill_id, parent_id, chunk_index, title, content, source_type)
      select ${docId}::text || '#' || (t.n - 1)::text, ${agentId}, ${skillId || null}, ${docId}, (t.n - 1)::int,
             ${title}, t.c, 'chunk'
      from unnest(${chunks}::text[]) with ordinality as t(c, n)
      where (select count(*) from gone) >= 0
    `;
  }
  return chunks.length;
}

/**
 * The one way a document enters the knowledge base: store the parent as it
 * came, normalise, then chunk it for search. The original text is kept in
 * raw_content so a disappointing rewrite can always be undone.
 *
 * The original is stored before the model pass, so a function that runs out
 * of time mid-rewrite leaves the document there unimproved rather than gone.
 *
 * A document id is the caller's, so it is only ever this agent's: an id that
 * already belongs to another agent's document is refused (code DOC_CONFLICT),
 * never overwritten.
 */
export async function storeDocument({ docId, agentId, skillId, title, content, sourceType = 'manual', sourceUrl = null, apiConfig, budgetMs }) {
  const [row] = await sql`
    insert into documents (id, agent_id, skill_id, title, content, raw_content, normalized, source_type, source_url)
    values (${docId}, ${agentId}, ${skillId || null}, ${title}, ${content}, null, false, ${sourceType}, ${sourceUrl})
    on conflict (id) do update set
      title = excluded.title, content = excluded.content, raw_content = null,
      normalized = false, updated_at = now()
    where documents.agent_id = excluded.agent_id and documents.parent_id is null
    returning id, agent_id, skill_id, title, content, normalized, created_at, (xmax = 0) as inserted
  `;
  if (!row) {
    throw Object.assign(new Error('A document with this id already exists elsewhere.'), { code: 'DOC_CONFLICT' });
  }
  const fresh = row.inserted === true;
  delete row.inserted;

  const { text, normalized, reason } = await normalizeDocument({ title, content, apiConfig, agentId, budgetMs });
  if (normalized) {
    await sql`
      update documents set content = ${text}, raw_content = ${content}, normalized = true, updated_at = now()
      where id = ${docId} and agent_id = ${agentId}
    `;
  }
  const chunks = await rechunk(docId, agentId, skillId, title, text, { fresh });
  return { ...row, content: text, normalized, chunks, normalizeSkipped: normalized ? '' : reason };
}

/* ─────────────────── searching ─────────────────── */

/**
 * Finds passages for a question.
 *
 * Two things make this work where the old query did not. The terms are OR-ed,
 * so a whole sentence does not demand that every one of its words appear —
 * plainto_tsquery AND-ed them, which meant a real question almost never
 * matched. And the question is turned into lexemes under BOTH configurations,
 * matching a vector that carries both, so Hebrew matches as written and
 * English matches through its stems.
 *
 * Only searchable units are considered: a document's chunks, or the document
 * itself when it was short enough not to be chunked.
 */
export async function searchDocuments({ agentId, query, skillIds = [], includeSkills = false, limit = 6 }) {
  const q = String(query || '').trim();
  if (!agentId || !q) return [];

  const skills = includeSkills ? null : (skillIds || []).filter(Boolean);

  try {
    return await sql`
      with terms as (
        select
          (select string_agg(l, ' | ') from unnest(tsvector_to_array(to_tsvector('simple',  ${q}))) l) as simple_q,
          (select string_agg(l, ' | ') from unnest(tsvector_to_array(to_tsvector('english', ${q}))) l) as english_q
      )
      select d.title, d.content, coalesce(d.parent_id, d.id) as document_id,
             greatest(
               coalesce(ts_rank(d.tsv, nullif(terms.simple_q, '')::tsquery), 0),
               coalesce(ts_rank(d.tsv, nullif(terms.english_q, '')::tsquery), 0)
             ) as rank
      from documents d, terms
      where d.agent_id = ${agentId}
        and (
          ${includeSkills}::boolean
          or d.skill_id is null
          or d.skill_id = any(${skills === null ? [] : skills}::text[])
        )
        and (d.parent_id is not null
             or not exists (select 1 from documents c where c.parent_id = d.id))
        and (
          coalesce(d.tsv @@ nullif(terms.simple_q, '')::tsquery, false)
          or coalesce(d.tsv @@ nullif(terms.english_q, '')::tsquery, false)
        )
      order by rank desc
      limit ${Math.min(Math.max(parseInt(limit, 10) || 6, 1), 20)}
    `;
  } catch (err) {
    await logError({ agentId, source: 'knowledge', message: err.message, context: { step: 'search', query: q.slice(0, 200) } });
    return [];
  }
}
