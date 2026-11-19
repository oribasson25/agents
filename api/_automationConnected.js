/**
 * The steps that reach into the organization: its connections, its tables,
 * its AI Chatbots and its model key.
 *
 * Each is handed its settings already filled in, and `ctx` for where it is
 * running: `orgId` and `ownerId` (whose automation this is — everything is
 * looked up inside that organization, so a name or an id in a file can never
 * reach another organization's things), `automationId`, `baseUrl`.
 */
import { sql } from './_db.js';
import { useConnection } from './_connections.js';
import { enqueue, recipientOf } from './_waOutbox.js';
import { sendMail, searchMail } from './_mail.js';
import { getTable, listRows, addRow, updateRow } from './_tables.js';
import { runAgentTurn } from './_agentRunner.js';
import { getUserSettings, resolveApiConfig, resolveAgentApiConfig, configUsable } from './_settings.js';
import { llmFetch, replyText } from './_llm.js';
import { fieldsToObject, waitSeconds } from './_automationSpec.js';

const source = (ctx) => `automation:${ctx.automationId || ''}`;

/* ─────────────────── WhatsApp ─────────────────── */

async function whatsapp(config, ctx) {
  const conn = await useConnection({ orgId: ctx.orgId, name: config.connection, kinds: ['whatsapp'] });
  const sent = await enqueue({ numberId: conn.data.numberId, to: config.to, text: config.text, source: source(ctx) });
  return { output: { queued: true, to: sent.to, from: conn.account }, port: 'out' };
}

const YES = /^\s*(yes|y|ok|okay|approve|approved|כן|מאשר|מאשרת|אשר|אישור|בסדר|👍|✅)\s*[.!]*\s*$/i;
const NO = /^\s*(no|n|reject|rejected|decline|לא|דחה|דוחה|לדחות|👎|❌)\s*[.!]*\s*$/i;

/** What a reply to an approval question means: 'yes', 'no', or null when it is neither. */
export function readAnswer(text) {
  if (YES.test(String(text || ''))) return 'yes';
  if (NO.test(String(text || ''))) return 'no';
  return null;
}

/**
 * Asks one person a yes/no question on WhatsApp and waits for the answer.
 * The run is parked until they reply (see `onWhatsAppMessage`), or until
 * the time allowed runs out, when it leaves by "timeout".
 */
async function approval(config, ctx) {
  const now = ctx.now ? ctx.now() : Date.now();
  if (ctx.parked) {
    const got = ctx.parked.answer;
    if (got) return { output: { answer: got.answer, approved: got.answer === 'yes', text: got.text || '', by: ctx.parked.phone }, port: got.answer };
    if (now >= ctx.parked.until) return { output: { answer: 'timeout', approved: false, text: '', by: ctx.parked.phone }, port: 'timeout' };
    return { park: ctx.parked };
  }
  const conn = await useConnection({ orgId: ctx.orgId, name: config.connection, kinds: ['whatsapp'] });
  const phone = recipientOf(config.to);
  if (!phone || phone.includes('@')) throw new Error('an approval is asked of one person, so it needs a phone number with a country code');
  if (ctx.single) {
    return { output: { note: 'Testing this step on its own does not send the question. Run the automation to ask it.', to: phone }, port: 'yes' };
  }
  const hours = Math.max(0.1, Math.min(24 * 14, Number(config.timeoutHours) || 24));
  await enqueue({ numberId: conn.data.numberId, to: phone, source: source(ctx),
                  text: `${String(config.text || '').trim()}\n\nכן / לא · yes / no` });
  const until = now + hours * 3600 * 1000;
  return { park: { kind: 'approval', numberId: conn.data.numberId, phone, until },
           waitingOutput: { asked: phone, waitsUntil: new Date(until).toISOString() } };
}

/**
 * Waits for one person's next WhatsApp message to a connected number.
 *
 * It sends nothing itself: put a Send WhatsApp before it to ask the question.
 * The run is parked until the person writes (see `onWhatsAppMessage`), and
 * then goes on by "reply" with what they wrote — or by "timeout" when the
 * time allowed runs out first. The message that answers a waiting run is the
 * run's: it does not also start an automation or reach the number's chatbot.
 */
async function waReply(config, ctx) {
  const now = ctx.now ? ctx.now() : Date.now();
  if (ctx.parked) {
    const got = ctx.parked.answer;
    if (got) {
      return { output: { replied: true, text: got.text || '', from: ctx.parked.phone, name: got.name || '', kind: got.kind || 'text', at: got.at || null }, port: 'reply' };
    }
    if (now >= ctx.parked.until) return { output: { replied: false, text: '', from: ctx.parked.phone, name: '', kind: '', at: null }, port: 'timeout' };
    return { park: ctx.parked };
  }
  const conn = await useConnection({ orgId: ctx.orgId, name: config.connection, kinds: ['whatsapp'] });
  const phone = recipientOf(config.from);
  /* Tested on its own there is nobody to wait for, and often no earlier test
     to say who it would be: it answers with an example so the steps after it
     have something to be wired to. */
  if (ctx.single) {
    return { output: { replied: true, text: 'An example reply — run the automation to wait for a real one.', from: phone || '', name: '', kind: 'text', at: new Date(now).toISOString() }, port: 'reply' };
  }
  if (!phone || phone.includes('@')) throw new Error('waits for one person, so it needs their phone number with a country code');
  const until = now + Math.max(10, waitSeconds(config)) * 1000;
  return { park: { kind: 'reply', numberId: conn.data.numberId, phone, until },
           waitingOutput: { waitingFor: phone, until: new Date(until).toISOString() } };
}

/* ─────────────────── mail ─────────────────── */

async function email(config, ctx) {
  const conn = await useConnection({ orgId: ctx.orgId, name: config.connection, kinds: ['gmail', 'microsoft'] });
  const sent = await sendMail(conn, { to: config.to, cc: config.cc, subject: config.subject, body: config.body }, { fetchImpl: ctx.fetch });
  return { output: sent, port: 'out' };
}

async function emailSearch(config, ctx) {
  const conn = await useConnection({ orgId: ctx.orgId, name: config.connection, kinds: ['gmail', 'microsoft'] });
  const messages = await searchMail(conn, { query: config.query, limit: config.limit }, { fetchImpl: ctx.fetch });
  return { output: { count: messages.length, messages }, port: 'out' };
}

/* ─────────────────── tables ─────────────────── */

const flat = (r) => ({ id: r.id, ...(r.data || {}) });

async function table(config, ctx) {
  const t = await getTable(String(config.table || ''), ctx.ownerId);
  if (!t) throw new Error('the table no longer exists, or is not this organization\'s');
  const action = config.action || 'find';
  if (action === 'find') {
    const { rows, total } = await listRows(t.id, { q: config.q == null ? '' : String(config.q), limit: config.limit || 20 });
    return { output: { table: t.name, total, count: rows.length, rows: rows.map(flat), first: rows.length ? flat(rows[0]) : null }, port: 'out' };
  }
  const values = fieldsToObject(config.fields, {});
  if (!Object.keys(values).length) throw new Error('has no values to write');
  const saved = action === 'update'
    ? await updateRow(t, String(config.rowId || ''), values, source(ctx))
    : await addRow(t, values, source(ctx));
  if (saved.error) throw new Error(`there is no row "${config.rowId}" in ${t.name}`);
  /* A column name the table does not have, or a value it would not take, is
     a mistake the author needs to see — not a row quietly saved without it. */
  const unknown = saved.unknown || [], refused = saved.refused || [];
  if (!Object.keys(saved.data || {}).length || (action !== 'update' && (unknown.length || refused.length))) {
    const why = [unknown.length ? `${t.name} has no column called ${unknown.map(x => `"${x}"`).join(', ')}` : '',
                 refused.length ? refused.map(x => `"${x.value}" is not a ${x.type}, which is what the column "${x.column}" holds`).join('; ') : '']
      .filter(Boolean).join('; ');
    if (!Object.keys(saved.data || {}).length) throw new Error(why || 'nothing was written');
  }
  return { output: { table: t.name, row: { id: saved.id, ...saved.data }, unknown, refused }, port: 'out' };
}

/* ─────────────────── AI Chatbot and plain AI ─────────────────── */

async function agent(config, ctx) {
  const [row] = await sql`select id, data, user_id from agents where id = ${String(config.agentId || '')} and org_id = ${ctx.orgId}`;
  if (!row) throw new Error('the AI Chatbot no longer exists, or is not this organization\'s');
  const message = String(config.message ?? '').trim();
  if (!message) throw new Error('has nothing to ask');
  const bot = { ...row.data, apiConfig: await resolveAgentApiConfig(row) };
  const { text } = await runAgentTurn({ agent: bot, agentId: row.id, messages: [{ role: 'user', content: message }], baseUrl: ctx.baseUrl });
  return { output: { text, chatbot: row.data.name || '' }, port: 'out' };
}

function parseJsonReply(text) {
  const body = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(body); } catch { /* look for the object inside the words */ }
  const start = body.search(/[[{]/);
  const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
  if (start !== -1 && end > start) {
    try { return JSON.parse(body.slice(start, end + 1)); } catch { /* fall through */ }
  }
  throw new Error(`was asked for JSON and the model answered with something else: ${body.slice(0, 200)}`);
}

/** One prompt to the organization's model, answered as text or as JSON. */
async function ai(config, ctx) {
  const cfg = resolveApiConfig(await getUserSettings(ctx.ownerId), null);
  if (!configUsable(cfg)) throw new Error('the platform has not finished setting up models for this organization');
  const prompt = String(config.prompt ?? '').trim();
  if (!prompt) throw new Error('has no prompt');
  const wantsJson = !!config.json;
  const system = wantsJson
    ? 'Answer with a single JSON value and nothing else: no explanation, no code fence.'
    : 'Answer directly, with no preamble.';
  const fetchImpl = ctx.fetch || fetch;
  const meta = { orgId: ctx.orgId || cfg.orgId || null, ownerId: ctx.ownerId, source: 'automation', itemType: 'automation', itemId: ctx.automationId || null };
  const { ok, status, data: d } = await llmFetch({
    cfg, meta, fetchImpl,
    body: { max_tokens: 4000, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] },
  });
  if (!ok) throw new Error((d.error && d.error.message) || `the model answered ${status}`);
  const text = replyText(d);
  if (!text) throw new Error('the model returned no answer');
  return { output: wantsJson ? parseJsonReply(text) : { text }, port: 'out' };
}

export const CONNECTED_RUNNERS = { whatsapp, approval, wa_reply: waReply, email, email_search: emailSearch, table, agent, ai };
