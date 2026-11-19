import { sql } from './_db.js';
import { loadAppById, mayOpen } from './_apps.js';
import { linkId, aiOf } from './_appFiles.js';
import { getTable, listRows, addRow, updateRow, deleteRow } from './_tables.js';
import { runAgentTurn, saveSession, claimSession, publicHistory, validSessionId, appBaseUrl } from './_agentRunner.js';
import { getUserSettings, resolveApiConfig, configUsable } from './_settings.js';
import { llmFetch, replyText, isStopped, stopMessage } from './_llm.js';
import { branchForSession, loadForConversation } from './_branches.js';
import { logError } from './_errorLog.js';
import { startRun, workRun } from './_automations.js';
import { rateLimit, clientIp } from './_throttle.js';

/* vercel.json gives this function 90 seconds. An automation it runs must be
   done, or handed over, with time left to answer. */
const MAX_DURATION_MS = 90 * 1000;
const ANSWER_MARGIN_MS = 8 * 1000;
const HARD_BUDGET_MS = 80 * 1000;    /* no step, retry or loop runs past this */
const HANDOVER_AT_MS = 50 * 1000;    /* steps hand the run over to the cron after this */

/* What one visitor may set off that costs the organization a model call. */
const AI_PER_IP_PER_MINUTE = 20;
const SEND_PER_IP_PER_MINUTE = 20;
const SEND_PER_SESSION_PER_MINUTE = 10;

async function overLimit(res, checks) {
  const ok = await Promise.all(checks);
  if (!ok.includes(false)) return false;
  res.setHeader('Retry-After', '60');
  res.status(429).json({ error: 'Too many requests. Wait a minute and try again.' });
  return true;
}

/**
 * What a running app may ask the platform for — the other end of `legs`.
 *
 * Two gates on every call. The caller must be allowed to open the app (it is
 * public, or they hold a link to it). And the thing asked for must be named in
 * the live app.json AND belong to the app's owner: a name in a file is a claim,
 * and a claim on somebody else's table opens nothing.
 *
 * There is no user here. A public app runs for whoever has the link, and acts
 * with exactly what its owner linked to it — nothing else in the account.
 */
export default async function handler(req, res) {
  const started = Date.now();
  /* App pages are sandboxed, so to the browser this is a cross-origin call. */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).end();

  const body = req.body || {};
  const { op, name } = body;

  const found = body.app ? await loadAppById(String(body.app)) : null;
  if (!found || !mayOpen(found.app, body.token)) return res.status(404).json({ error: 'No such app' });
  const { app, ownerId, orgId } = found;

  try {
    /* legs.ai — one call to a model, with no chatbot around it. Only for an
       app whose app.json switched it on: anyone who can open the app can make
       it call the model, at the organization's cost. */
    if (op === 'ai') {
      const ai = aiOf(app.ai);
      if (!ai) return res.status(403).json({ error: 'This app may not call a model: add "ai": true to its app.json, or switch AI on in its Links.' });
      if (await overLimit(res, [rateLimit(`app-ai:${app.id}:${clientIp(req)}`, AI_PER_IP_PER_MINUTE, 60)])) return;
      const msgs = [];
      if (typeof body.system === 'string' && body.system.trim()) msgs.push({ role: 'system', content: body.system.slice(0, 20000) });
      if (Array.isArray(body.messages)) {
        for (const m of body.messages.slice(-50)) {
          if (m && ['user', 'assistant', 'system'].includes(m.role) && typeof m.content === 'string') msgs.push({ role: m.role, content: m.content.slice(0, 40000) });
        }
      }
      if (typeof body.prompt === 'string' && body.prompt.trim()) msgs.push({ role: 'user', content: body.prompt.slice(0, 40000) });
      if (!msgs.some((m) => m.role === 'user')) return res.status(400).json({ error: 'legs.ai needs a prompt or messages.' });
      if (body.json) msgs.unshift({ role: 'system', content: 'Answer with a single JSON value and nothing else: no explanation, no code fence.' });
      const cfg = resolveApiConfig(await getUserSettings(ownerId), { model: ai.model });
      if (!configUsable(cfg)) return res.status(503).json({ error: 'The platform has not finished setting up models for this organization.' });
      const maxTokens = Math.min(Math.max(Number(body.maxTokens) || 1500, 16), 4000);
      try {
        const { ok, status, data } = await llmFetch({
          cfg, body: { messages: msgs, max_tokens: maxTokens },
          meta: { orgId, ownerId, source: 'app', itemType: 'app', itemId: app.id, public: true },
        });
        if (!ok) return res.status(status >= 400 ? status : 502).json({ error: (data.error && data.error.message) || 'The model did not answer.' });
        const text = replyText(data);
        if (!body.json) return res.json({ text });
        const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
        try { return res.json({ json: JSON.parse(clean), text }); }
        catch { return res.status(502).json({ error: `Asked for JSON, the model answered: ${text.slice(0, 200)}` }); }
      } catch (err) {
        if (isStopped(err)) {
          const last = [...msgs].reverse().find((m) => m.role === 'user');
          return res.status(402).json({ error: await stopMessage(last && last.content), code: err.code });
        }
        throw err;
      }
    }

    if (op === 'agent.info') {
      const agentId = linkId((app.agents || {})[name]);
      if (!agentId) return res.status(404).json({ error: `This app has no AI Chatbot linked as "${name}"` });
      const [row] = await sql`select data from agents where id = ${agentId} and org_id = ${orgId}`;
      if (!row) return res.status(404).json({ error: `The AI Chatbot linked as "${name}" no longer exists` });
      /* What a page needs to introduce the chatbot, and nothing else of it:
         not its prompt, its tools or anything its owner configured. */
      return res.json({ name: row.data.name || name, openingMessage: row.data.openingMessage || '' });
    }

    if (op === 'agent.send') {
      const agentId = linkId((app.agents || {})[name]);
      if (!agentId) return res.status(404).json({ error: `This app has no AI Chatbot linked as "${name}"` });
      const history = publicHistory(body.messages);
      if (history.error) return res.status(400).json({ error: history.error });
      const sessionId = body.sessionId || null;
      if (sessionId && !validSessionId(sessionId)) {
        return res.status(400).json({ error: 'sessionId must be up to 120 letters, digits or _ . : + -, and may not start with wa_ or wal_' });
      }
      if (await overLimit(res, [
        rateLimit(`app-send-ip:${clientIp(req)}`, SEND_PER_IP_PER_MINUTE, 60),
        sessionId ? rateLimit(`app-send-session:${agentId}:${sessionId}`, SEND_PER_SESSION_PER_MINUTE, 60) : true,
      ])) return;
      const [row] = await sql`select data, user_id from agents where id = ${agentId} and org_id = ${orgId}`;
      if (!row) return res.status(404).json({ error: `The AI Chatbot linked as "${name}" no longer exists` });

      /* A conversation id is only this chatbot's to write to (see claimSession). */
      const [claim, settings] = await Promise.all([
        claimSession(sessionId, agentId, 'app'),
        row.user_id ? getUserSettings(row.user_id) : null,
      ]);
      if (!claim.ok) return res.status(409).json({ error: 'This conversation cannot be continued here. Start a new one.' });
      const branchId = claim.exists ? claim.branchId : await branchForSession(agentId, null);
      const chosen = branchId ? await loadForConversation(agentId, branchId) : { agent: row.data, branchId: null };
      const agent = { ...chosen.agent, apiConfig: resolveApiConfig(settings, { model: chosen.agent && chosen.agent.model }) };
      try {
        const { text, safeMessages } = await runAgentTurn({ agent, agentId, messages: history.messages, baseUrl: appBaseUrl(req) });
        if (sessionId) {
          await saveSession(sessionId, agentId, [...safeMessages, { role: 'assistant', content: text }], 'app', chosen.branchId);
        }
        return res.json({ content: text });
      } catch (err) {
        // Out of money or over its limit: the visitor reads the stop message, as on the widget.
        if (isStopped(err)) {
          const last = history.messages[history.messages.length - 1];
          return res.json({ content: await stopMessage(last && last.content), stopped: true });
        }
        /* What went wrong is the owner's to read in the error log, not the visitor's. */
        await logError({ agentId, source: 'app', message: err.message, context: { appId: app.id, code: err.code || null } });
        return res.status(err.code === 'NO_API_KEY' || err.status === 503 ? 503 : 500)
          .json({ error: 'The AI Chatbot could not answer. Please try again.', ...(err.code === 'NO_API_KEY' ? { code: err.code } : {}) });
      }
    }

    if (typeof op === 'string' && op.startsWith('table.')) {
      const link = (app.tables || {})[name];
      const tableId = linkId(link);
      if (!tableId) return res.status(404).json({ error: `This app has no Table linked as "${name}"` });
      const table = await getTable(tableId, ownerId);
      if (!table) return res.status(404).json({ error: `The Table linked as "${name}" no longer exists` });
      const readonly = !!(link && typeof link === 'object' && link.readonly);
      const by = `app:${app.id}`;

      if (op === 'table.info') {
        return res.json({ name: table.name, description: table.description, columns: table.columns, readonly });
      }
      if (op === 'table.rows') {
        if (body.q !== undefined && body.q !== null && typeof body.q !== 'string') return res.status(400).json({ error: 'q must be text' });
        const { rows, total } = await listRows(tableId, { q: (body.q || '').slice(0, 500), limit: body.limit, offset: body.offset });
        return res.json({ rows, total, columns: table.columns });
      }
      if (readonly) return res.status(403).json({ error: `"${name}" is linked read-only` });
      if (op === 'table.add') return res.json(await addRow(table, body.row || {}, by));
      if (op === 'table.update') {
        if (!body.rowId) return res.status(400).json({ error: 'rowId is required' });
        const saved = await updateRow(table, body.rowId, body.row || {}, by);
        return saved.error ? res.status(404).json(saved) : res.json(saved);
      }
      if (op === 'table.remove') {
        if (!body.rowId) return res.status(400).json({ error: 'rowId is required' });
        return res.json(await deleteRow(tableId, body.rowId));
      }
    }

    if (op === 'automation.run') {
      const id = linkId((app.automations || {})[name]);
      if (!id) return res.status(404).json({ error: `This app has no automation linked as "${name}"` });
      const [auto] = await sql`select * from automations where id = ${id} and org_id = ${orgId}`;
      if (!auto) return res.status(404).json({ error: `The automation linked as "${name}" no longer exists` });
      if (!auto.published || !auto.enabled) {
        return res.status(409).json({ error: `The automation linked as "${name}" is not live — publish it and switch it on` });
      }
      const input = body.input && typeof body.input === 'object' && !Array.isArray(body.input) ? body.input : {};
      const host = new URL(appBaseUrl(req)).host;
      const runId = await startRun({ row: auto, mode: 'live', source: 'app', input, host });
      /* Nothing may run past 80 seconds, nor past what is left of this
         function's 90 less the time to answer; steps hand over at 50. */
      const left = MAX_DURATION_MS - (Date.now() - started) - ANSWER_MARGIN_MS;
      const hardBudgetMs = Math.max(10_000, Math.min(HARD_BUDGET_MS, left));
      const run = await workRun(runId, { host, budgetMs: Math.max(5000, Math.min(HANDOVER_AT_MS, hardBudgetMs - 30_000)), hardBudgetMs });
      if (run && run.status === 'failed') {
        await logError({ agentId: null, source: 'app', message: run.error, context: { appId: app.id, automationId: id } });
        /* What went wrong inside is the owner's to read in the run log, not the visitor's. */
        return res.status(500).json({ error: 'The automation failed' });
      }
      return res.json({ status: run ? run.status : 'queued', output: run && run.status === 'done' ? run.output : null });
    }

    return res.status(400).json({ error: `Unknown operation "${op}"` });
  } catch (err) {
    /* The visitor of a public app reads nothing of the platform's insides. */
    console.error(`[app-run] app=${app.id} op=${op} error:`, err.message);
    await logError({ agentId: null, source: 'app', message: `${op}: ${err.message}`, context: { appId: app.id } });
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
