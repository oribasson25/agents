import { sql } from './_db.js';
import { nowBlock } from './_now.js';
import { searchDocuments } from './_knowledge.js';
import { sendGmail } from './_gmail.js';
import { logError } from './_errorLog.js';
import { TABLE_TOOLS, runAgentTableTool } from './_tables.js';
import { AUTOMATION_TOOLS, runAgentAutomationTool } from './_automationTools.js';
import { internalSecret } from './_auth.js';
import { llmFetch, replyText } from './_llm.js';
import { configUsable } from './_settings.js';
import { runToolCode } from './_toolRunner.js';

/* This runs server-side with no logged-in user, so it proves it is the
   platform to the scraper with the internal secret instead of a session
   token (and to the tool runner through api/_toolRunner.js). */
const INTERNAL_HEADERS = { 'Content-Type': 'application/json', 'x-internal-secret': internalSecret() };

/**
 * Where this deployment answers, for the calls it makes to itself (the
 * scraper, the tool runner, automation code steps). APP_URL when it is set,
 * so the address never depends on headers a caller could shape; otherwise the
 * address this request came in on.
 */
export function appBaseUrl(req) {
  const fixed = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (fixed) return fixed;
  const proto = String((req && req.headers && req.headers['x-forwarded-proto']) || 'https').split(',')[0].trim() === 'http' ? 'http' : 'https';
  return `${proto}://${req && req.headers ? req.headers.host : ''}`;
}

/* ─────────────────── what a stranger may send ─────────────────── */

/* The widget, apps and WhatsApp are open to anyone, and every turn is paid
   for by the chatbot's organization. A turn reads the last PUBLIC_TURNS
   messages; a person's message may be up to PUBLIC_USER_CHARS long, and the
   chatbot's own earlier answers are cut at PUBLIC_ASSISTANT_CHARS. */
export const PUBLIC_TURNS = 20;
export const PUBLIC_USER_CHARS = 4000;
export const PUBLIC_ASSISTANT_CHARS = 8000;
const MAX_INCOMING = 500;

/**
 * The history a stranger sent, as a turn may use it: only `user` and
 * `assistant` messages with text, the last PUBLIC_TURNS of them, starting
 * with the person. Returns `{ messages }` or `{ error }` (for a 400).
 *
 * A `system` or `tool` message, or an `assistant` one carrying tool calls,
 * is the platform's to write, never the visitor's: they are dropped.
 */
export function publicHistory(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return { error: 'messages array required' };
  if (messages.length > MAX_INCOMING) return { error: 'Too many messages in one request' };
  const kept = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') return { error: 'Every message must be an object with a role and text content' };
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (typeof m.content !== 'string') return { error: 'Message content must be text' };
    if (m.role === 'user' && m.content.length > PUBLIC_USER_CHARS) {
      return { error: `A message can be at most ${PUBLIC_USER_CHARS} characters long` };
    }
    kept.push({ role: m.role, content: m.role === 'assistant' ? m.content.slice(0, PUBLIC_ASSISTANT_CHARS) : m.content });
  }
  let recent = kept.slice(-PUBLIC_TURNS);
  const first = recent.findIndex((m) => m.role === 'user');
  recent = first === -1 ? [] : recent.slice(first);
  if (!recent.length || recent[recent.length - 1].role !== 'user' || !recent[recent.length - 1].content.trim()) {
    return { error: 'The last message must be the person\'s, with some text' };
  }
  return { messages: recent };
}

/* What any channel hands a turn: text turns of a person and the chatbot, nothing else. */
function turnHistory(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content }))
    .slice(-60);
}

/* Conversation ids WhatsApp stores under (wa_<agent>_<phone>, wal_…). A
   widget or app visitor must not be able to create one first: that row would
   then belong to the widget, and the phone's real history could no longer be
   stored. */
export const RESERVED_SESSION_PREFIX = /^wal?_/i;

/** A conversation id a client may choose: short, plain characters only, and not WhatsApp's. */
export function validSessionId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 120 && /^[A-Za-z0-9_.:+-]+$/.test(id)
    && !RESERVED_SESSION_PREFIX.test(id);
}

function applyDlp(text, dlp) {
  if (!dlp || typeof text !== 'string') return text;
  let out = text;
  if (dlp.creditCard) out = out.replace(/\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, '[MASKED]');
  if (dlp.israeliId)  out = out.replace(/\b\d{9}\b/g, '[MASKED]');
  return out;
}

export function dlpMessages(messages, dlp) {
  if (!dlp) return messages;
  return messages.map(m => {
    if (m.role !== 'user' || typeof m.content !== 'string') return m;
    return { ...m, content: applyDlp(m.content, dlp) };
  });
}

/*
 * Ordered from what never changes to what changes every turn, so a provider's
 * prompt cache can keep the long, fixed start (the prompt and the skills)
 * from one turn and one tool round to the next. Every chatbot is told the
 * date, whatever else it is told — last, because it changes every minute.
 */
export function buildSystemPrompt(agent, ragChunks = [], at = new Date()) {
  let system = String(agent.basePrompt || '');
  if (agent.skills && agent.skills.length > 0) {
    system += '\n\n' + agent.skills.map(s =>
      `## Skill: ${s.name}\n${s.description ? s.description + '\n' : ''}${s.prompt}`
    ).join('\n\n');
  }
  const dlp = agent.dlp || {};
  if (dlp.creditCard || dlp.israeliId) {
    system += '\n\n[SECURITY NOTICE] Never process, repeat, or store personal identifiable information (PII). If the user provides sensitive data such as credit card numbers or ID numbers, refuse to repeat it and treat it as [MASKED].';
  }
  if (ragChunks.length > 0) {
    system += '\n\n## Relevant Context\n' + ragChunks.map(c => `--- ${c.title}\n${c.content}`).join('\n\n');
  }
  system += `\n\n${nowBlock(at)}`;
  return system.trim();
}

/**
 * Whether a conversation id may be used by this chatbot on this channel:
 * free, or already this chatbot's conversation on this channel. Also says
 * which branch an existing conversation is on, so the caller need not ask
 * again. `{ ok, exists, branchId }`.
 */
export async function claimSession(sessionId, agentId, source) {
  if (!sessionId) return { ok: true, exists: false, branchId: null };
  const [row] = await sql`select agent_id, source, branch_id from chat_sessions where id = ${sessionId}`;
  if (!row) return { ok: true, exists: false, branchId: null };
  return { ok: row.agent_id === agentId && row.source === source, exists: true, branchId: row.branch_id || null };
}

/**
 * Stores a conversation under its id. A conversation already stored under
 * that id is replaced only when it is this chatbot's, on this channel:
 * conversation ids are chosen by the client (and a WhatsApp one can be
 * guessed), so without that anyone could overwrite anyone's conversation —
 * the history a chatbot reads back on its next answer. Returns false when the
 * id belongs to someone else, or nothing could be written.
 */
export async function saveSession(sessionId, agentId, allMessages, source = 'widget', branchId = null) {
  if (!sessionId) return false;
  if (!validSessionId(sessionId)) return false;
  try {
    const rows = await sql`
      insert into chat_sessions (id, agent_id, source, messages, branch_id, started_at, updated_at)
      values (${sessionId}, ${agentId}, ${source}, ${JSON.stringify(allMessages)}, ${branchId}, now(), now())
      on conflict (id) do update
        set messages   = excluded.messages,
            updated_at = now()
        where chat_sessions.agent_id = excluded.agent_id
          and chat_sessions.source = excluded.source
      returning id
    `;
    return rows.length > 0;
  } catch (err) {
    console.warn('[chat session] could not store a conversation:', err.message);
    return false;
  }
}

/**
 * Knowledge for the public channels (widget, WhatsApp).
 *
 * includeSkills is true here on purpose: buildSystemPrompt below appends every
 * skill's prompt unconditionally, so on these channels all skills are active
 * at once. Restricting retrieval to global documents — which is what this did —
 * meant a document attached to a skill was reachable from the test chat and
 * from nowhere else.
 */
async function retrieveRagChunks(agentId, query) {
  return searchDocuments({ agentId, query, includeSkills: true, limit: 5 });
}

const EMAIL_TOOL = {
  description: 'Send an email via the connected Gmail account. Use when explicitly instructed to send an email.',
  parameters: {
    to:      'Recipient email address',
    subject: 'Email subject line',
    body:    'Email body text',
  },
};

/* Only channels that keep a conversation open across messages (linked
   WhatsApp numbers) turn this on, with agent.canEndConversation. The channel
   reads `ended` from runAgentTurn and starts a fresh session next time. */
const END_CONVERSATION_TOOL = {
  name: 'end_conversation',
  description: 'End this conversation. Call it when the person asks to end, stop or close the conversation, or says goodbye with nothing left open. Then reply with a short goodbye: their next message starts a new conversation that does not remember this one.',
};

function buildOpenAITools(agent) {
  const toolDefs = (agent.tools || []).filter(t => t.name !== 'switch_skill' && !(agent.canEndConversation && t.name === END_CONVERSATION_TOOL.name));
  const tools = toolDefs.map(t => {
    const predefinedUrls = (agent.scrapeUrls || (agent.scrapeUrl ? [agent.scrapeUrl] : [])).map(u => u.trim()).filter(Boolean);
    const hasPredefinedUrl = t.name === 'scrape_website' && predefinedUrls.length > 0;
    const params = hasPredefinedUrl ? (t.parameters || []).filter(p => p.name !== 'url') : (t.parameters || []);
    return {
      type: 'function',
      function: {
        name: t.name,
        description: t.description + (hasPredefinedUrl ? ' (URL is preconfigured; call with no arguments.)' : ''),
        parameters: {
          type: 'object',
          properties: Object.fromEntries(params.map(p => [p.name, { type: p.type || 'string', description: p.description || '' }])),
          required: params.map(p => p.name),
        },
      },
    };
  });

  if (agent.emailEnabled) {
    tools.push({
      type: 'function',
      function: {
        name: 'send_email',
        description: EMAIL_TOOL.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            Object.entries(EMAIL_TOOL.parameters).map(([name, description]) => [name, { type: 'string', description }])
          ),
          required: Object.keys(EMAIL_TOOL.parameters),
        },
      },
    });
  }

  if ((agent.tables || []).length > 0) {
    for (const t of TABLE_TOOLS) {
      tools.push({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } });
    }
  }
  if ((agent.automations || []).length > 0) {
    for (const t of AUTOMATION_TOOLS) {
      tools.push({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } });
    }
  }
  if (agent.canEndConversation) {
    tools.push({ type: 'function', function: { ...END_CONVERSATION_TOOL, parameters: { type: 'object', properties: {} } } });
  }
  return tools;
}

/* One address, nothing around it. */
const ADDRESS = /^[^\s@<>(),;:"\\]+@[^\s@<>(),;:"\\]+\.[^\s@<>(),;:"\\]+$/;

/** "a@x.com, b@y.org" → the same, checked; null if any part is not a plain address. */
export function emailRecipients(value) {
  if (typeof value !== 'string' || /[\r\n]/.test(value)) return null;
  const list = value.split(/[,;]/).map((x) => x.trim()).filter(Boolean);
  if (!list.length || list.length > 20 || !list.every((x) => x.length <= 254 && ADDRESS.test(x))) return null;
  return list.join(', ');
}

async function executeTool(toolName, inputs, agent, baseUrl, agentId) {
  if (toolName === 'switch_skill') return 'OK';

  if (toolName.startsWith('table_')) {
    try {
      const [owner] = await sql`select user_id from agents where id = ${agentId}`;
      return await runAgentTableTool({
        toolName, inputs, agent, ownerId: owner && owner.user_id, writtenBy: agentId,
      });
    } catch (err) {
      await logError({ agentId, source: 'tool', message: `${toolName}: ${err.message}`, context: { tool: toolName } });
      return `The table tool failed: ${err.message}`;
    }
  }

  if (toolName === 'automation_list' || toolName === 'automation_run') {
    try {
      const [owner] = await sql`select user_id from agents where id = ${agentId}`;
      let host = null;
      try { host = new URL(baseUrl).host; } catch { /* no address to run code steps from */ }
      return await runAgentAutomationTool({ toolName, inputs, agent, ownerId: owner && owner.user_id, agentId, host });
    } catch (err) {
      await logError({ agentId, source: 'tool', message: `${toolName}: ${err.message}`, context: { tool: toolName } });
      return `The automation tool failed: ${err.message}`;
    }
  }

  if (toolName === 'send_email') {
    if (!agent.emailEnabled) return 'The send_email tool is disabled for this agent.';
    /* The address comes from the model, which a stranger talks to: a line
       break in it would add headers (Bcc:) to the message. */
    const to = emailRecipients(inputs.to);
    if (!to) return 'Error: "to" must be one or more plain email addresses, separated by commas.';
    try {
      const { message } = await sendGmail({
        agentId,
        to,
        subject: String(inputs.subject ?? '').replace(/[\r\n]+/g, ' '),
        body: inputs.body,
      });
      return message;
    } catch (err) {
      console.error(`[send_email] agentId=${agentId} ${err.code || 'ERROR'}:`, err.message);
      await logError({ agentId, source: 'tool', message: `send_email: ${err.message}`, context: { tool: 'send_email', code: err.code || null, to: inputs.to || null } });
      return `Error: ${err.message}`;
    }
  }

  const predefinedUrls = (agent.scrapeUrls || (agent.scrapeUrl ? [agent.scrapeUrl] : [])).map(u => u.trim()).filter(Boolean);

  if (toolName === 'scrape_website') {
    const urls = predefinedUrls.length > 0
      ? predefinedUrls
      : (inputs.url ? [inputs.url] : []);

    if (urls.length === 0) return 'No URL provided';

    const results = await Promise.allSettled(
      urls.map(url =>
        fetch(`${baseUrl}/api/scrape-browser`, {
          method: 'POST',
          headers: INTERNAL_HEADERS,
          body: JSON.stringify({ url }),
        }).then(r => r.json())
      )
    );

    return results.map((r, i) => {
      const d = r.status === 'fulfilled' ? r.value : { error: r.reason?.message };
      return `=== ${urls[i]} ===\n${d.error ? 'Error: ' + d.error : (d.title ? 'Title: ' + d.title + '\n' : '') + (d.text || '')}`;
    }).join('\n\n');
  }

  const tool = (agent.tools || []).find(t => t.name === toolName);
  if (!tool) return `Unknown tool: ${toolName}`;

  const packages = (tool.packages || '').split(',').map(s => s.trim()).filter(Boolean);
  const envVars = Object.fromEntries((tool.envVars || []).filter(e => e.key).map(e => [e.key, e.value]));

  let data;
  try {
    data = await runToolCode({ code: tool.code || '', inputs, packages, envVars, baseUrl });
  } catch (err) {
    data = { error: err.message };
  }

  // A tool that fails mid-conversation is the failure an assistant most needs
  // to see, and nobody is watching the logs when it happens.
  if (data.error) {
    await logError({ agentId, source: 'tool', message: String(data.error), context: { tool: toolName, inputs } });
    return String(data.error);
  }
  return String(data.result ?? 'No output');
}

/**
 * Runs one full agent turn (with RAG + DLP + tool-calling loop) against
 * whichever provider the agent is configured for. Returns
 * `{ text, safeMessages }` — `safeMessages` is the DLP-masked input history,
 * for callers that persist `[...safeMessages, {role:'assistant', content:text}]`.
 * Throws on failure; throws with `err.code === 'NO_API_KEY'` when the agent
 * has no key configured (and isn't using Ollama).
 */
export async function runAgentTurn({ agent, agentId, messages, baseUrl, audience = 'public' }) {
  /* Whatever a channel passes, a turn reads only the person's and the
     chatbot's own text: a `system` or `tool` message in a stored or sent
     history would be the platform speaking, and it is not. */
  const history = turnHistory(messages);
  const lastUserMsg = [...history].reverse().find(m => m.role === 'user')?.content || '';
  const cfg = agent.apiConfig || {};
  const dlp = agent.dlp || {};
  const safeMessages = dlpMessages(history, dlp);

  if (!configUsable(cfg)) {
    const err = new Error('The platform has not set up a model for this AI Chatbot\'s organization yet.');
    err.code = 'NO_API_KEY';
    throw err;
  }
  const ragChunks = lastUserMsg.trim() ? await retrieveRagChunks(agentId, lastUserMsg) : [];
  const systemPrompt = buildSystemPrompt(agent, ragChunks);
  /* `public`: a stranger set this off (widget, app, WhatsApp), so it counts
     against the organization's share of the platform's budget too. */
  const meta = { orgId: cfg.orgId || null, source: 'agents', itemType: 'agent', itemId: agentId, public: audience !== 'internal' };

  let ended = false;
  const runTool = async (name, inputs) => {
    if (name === END_CONVERSATION_TOOL.name && agent.canEndConversation) {
      ended = true;
      return 'Done. Now say a short goodbye.';
    }
    return executeTool(name, inputs, agent, baseUrl, agentId);
  };

  let msgs = [{ role: 'system', content: systemPrompt }, ...safeMessages];

  for (let round = 0; round < 10; round++) {
    const body = { messages: msgs, max_tokens: 2048 };
    const openAITools = buildOpenAITools(agent);
    if (openAITools.length > 0) body.tools = openAITools;

    const { ok, data: d } = await llmFetch({ cfg, body, meta });
    if (!ok) throw new Error(d.error?.message || JSON.stringify(d));

    const choice = d.choices[0];
    const calls = (choice.message && choice.message.tool_calls) || [];
    if (!calls.length) {
      // A refusal or an empty answer: the callers turn '' into their own apology.
      return { text: replyText(d), safeMessages, ended };
    }

    const toolResultMsgs = await Promise.all(calls.map(async tc => {
      let inputs = {};
      try { inputs = JSON.parse(tc.function.arguments || '{}'); } catch { /* a model that wrote broken JSON gets an empty call */ }
      const result = await runTool(tc.function.name, inputs);
      return { role: 'tool', tool_call_id: tc.id, content: String(result) };
    }));

    msgs = [...msgs, choice.message, ...toolResultMsgs];
  }
  throw new Error('Too many tool call rounds (max 10)');
}
