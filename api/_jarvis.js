import { sql } from './_db.js';
import { nowBlock, PLATFORM_TZ } from './_now.js';
import { getUserSettings, resolveApiConfig, configUsable } from './_settings.js';
import { llmFetch, replyText, webSearch, isStopped, stopMessage } from './_llm.js';

/*
 * Jarvis: a private personal assistant for one person on a linked WhatsApp
 * number.
 *
 * Privacy is the shape of this file. Everything a Jarvis knows about its
 * person — the conversation, the memory, the reminders — is read and written
 * here, keyed by that person's id, and never by anything else. Nothing here
 * goes to chat_sessions, so none of it shows up in Interactions or in an
 * admin's chat history. One person's Jarvis cannot see another's.
 *
 * The model is the one the platform chose for the number owner's
 * organization, reached through the platform's OpenRouter key like every
 * other channel in 8Legs. Jarvis relies on tool use, so that model must
 * support tools; web search is a tool of its own (api/_llm.js webSearch).
 */

/* What a Jarvis may do, unless an admin turned it off for this person. */
export const CAPABILITY_DEFAULTS = {
  cal: true, gmail: true, tasks: true, web: true,
  voiceIn: true, voiceOut: false, docs: true, files: true,
};
export const PROACTIVE_DEFAULTS = { remind: true, brief: true, alerts: true, follow: false };

export function capabilityOn(person, key) {
  const own = (person && person.capabilities) || {};
  return own[key] != null ? !!own[key] : !!CAPABILITY_DEFAULTS[key];
}

export function proactiveOn(person, key) {
  const own = (person && person.proactive) || {};
  return own[key] != null ? !!own[key] : !!PROACTIVE_DEFAULTS[key];
}

const HISTORY_MESSAGES = 30;
const MAX_FACTS = 200;
const MAX_ROUNDS = 8;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);


export async function recordAssistantMessage(personId, content) {
  await sql`insert into jarvis_messages (person_id, role, content) values (${personId}, 'assistant', ${content})`;
}

async function recordUserMessage(personId, content) {
  await sql`insert into jarvis_messages (person_id, role, content) values (${personId}, 'user', ${content})`;
  await sql`update jarvis_people set last_message_at = now() where id = ${personId}`;
}

async function loadContext(personId) {
  const [history, memory, reminders] = await Promise.all([
    sql`select role, content from jarvis_messages where person_id = ${personId} order by id desc limit ${HISTORY_MESSAGES}`,
    // Newest first, then back in order: past MAX_FACTS the oldest drop out of view, never the new ones.
    sql`select id, fact from jarvis_memory where person_id = ${personId} order by id desc limit ${MAX_FACTS}`,
    sql`select id, text, due_at from jarvis_reminders where person_id = ${personId} and sent_at is null order by due_at limit 50`,
  ]);
  return { history: history.reverse(), memory: memory.reverse(), reminders };
}

function localTime(date, tz) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(date));
}

function buildSystem(person, { memory, reminders }) {
  const tz = person.timezone || PLATFORM_TZ;
  const name = person.call_name || person.name || 'them';
  const can = (key) => capabilityOn(person, key);

  const abilities = [
    'Remember things about them for later, and forget them on request.',
    'Set reminders that arrive as a WhatsApp message at the time they ask for.',
    can('web') && 'Search the web for anything current: news, prices, opening hours, facts that may have changed.',
    can('docs') && 'Read the photos, screenshots and PDFs they send.',
  ].filter(Boolean);

  const notYet = [
    can('cal') && 'their calendar',
    can('gmail') && 'their email',
    can('tasks') && 'their task board',
  ].filter(Boolean);

  const lines = [
    `You are Jarvis, ${name}'s personal assistant on WhatsApp.`,
    `You only ever talk to ${name}. You never write to anyone else, and you never claim to have.`,
    'Write the way people write on WhatsApp: short, warm, plain text. No headings, tables or Markdown links; WhatsApp only shows *bold* and _italic_. Answer in the language they write in.',
    '',
    '## What you can do',
    ...abilities.map((a) => `- ${a}`),
    '',
    '## What you cannot do yet',
    notYet.length
      ? `- You are not connected to ${notYet.join(', ')} yet. If they ask, say it isn't connected yet instead of guessing.`
      : '- Nothing beyond the list above.',
    '- You cannot listen to voice messages yet. If they send one, ask them to type it.',
    !can('web') && '- You have no web access. Say so when a question needs current information.',
    '',
    '## Memory',
    'Use `remember` when they tell you something lasting about themselves (people in their life, preferences, routines, important dates) or ask you to remember something. Keep each fact short and self-contained.',
    'Use `forget` when they ask you to forget something, or a fact has become wrong (then remember the new one).',
    'Never store passwords, card numbers, ID numbers or other secrets, even if asked.',
    '',
    '## Reminders',
    `Their time zone is ${tz}. When they ask to be reminded, call \`set_reminder\` with the exact time as ISO 8601 with the UTC offset, then confirm the day and time back to them in their own words.`,
    'If the time is unclear ("later", "in the evening"), ask before setting it.',
  ].filter((l) => l !== false && l != null);

  if (person.prompt && person.prompt.trim()) {
    lines.push('', '## Instructions from their administrator', 'These win over everything else above.', person.prompt.trim());
  }

  lines.push('', '## What you remember about them');
  lines.push(memory.length ? memory.map((m) => `- [${m.id}] ${m.fact}`).join('\n') : '- Nothing yet.');

  lines.push('', '## Their open reminders');
  lines.push(reminders.length
    ? reminders.map((r) => `- [${r.id}] ${localTime(r.due_at, tz)}: ${r.text}`).join('\n')
    : '- None.');

  lines.push('', nowBlock(new Date(), tz));
  return lines.join('\n');
}

const CLIENT_TOOLS = [
  {
    name: 'remember',
    description: 'Save one lasting fact about the person so you know it in future conversations.',
    input_schema: {
      type: 'object',
      properties: { fact: { type: 'string', description: 'The fact, short and self-contained, in the language they use.' } },
      required: ['fact'],
    },
  },
  {
    name: 'forget',
    description: 'Delete a remembered fact by its id (the number in square brackets in "What you remember about them").',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'The id of the fact to delete.' } },
      required: ['id'],
    },
  },
  {
    name: 'set_reminder',
    description: 'Schedule a WhatsApp reminder to the person at an exact time.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What to remind them of, written as the reminder they will read.' },
        due_at: { type: 'string', description: 'When, as ISO 8601 with the UTC offset, e.g. 2026-11-14T09:00:00+02:00.' },
      },
      required: ['text', 'due_at'],
    },
  },
  {
    name: 'cancel_reminder',
    description: 'Cancel an open reminder by its id (the number in square brackets in "Their open reminders").',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'The id of the reminder to cancel.' } },
      required: ['id'],
    },
  },
];

/** Runs one client tool for this person only. Every query is scoped by person id. */
async function runTool(personId, name, input) {
  const args = input || {};
  if (name === 'remember') {
    const fact = String(args.fact || '').trim().slice(0, 500);
    if (!fact) return { error: 'The fact is empty.' };
    /* A fact past what fits in the prompt would be remembered and never seen
       again: say so, so they can choose what to forget first. */
    const [{ n }] = await sql`select count(*)::int as n from jarvis_memory where person_id = ${personId}`;
    if (n >= MAX_FACTS) return { error: `Memory is full (${MAX_FACTS} facts). Ask them which facts to forget first, forget those, then remember this.` };
    const [row] = await sql`insert into jarvis_memory (person_id, fact) values (${personId}, ${fact}) returning id`;
    return { ok: `Remembered as [${row.id}].` };
  }
  if (name === 'forget') {
    const id = Number(args.id);
    if (!Number.isInteger(id)) return { error: 'id must be an integer.' };
    const rows = await sql`delete from jarvis_memory where id = ${id} and person_id = ${personId} returning id`;
    return rows.length ? { ok: `Forgot [${id}].` } : { error: `There is no fact [${id}].` };
  }
  if (name === 'set_reminder') {
    const text = String(args.text || '').trim().slice(0, 1000);
    const due = new Date(String(args.due_at || ''));
    if (!text) return { error: 'The reminder text is empty.' };
    if (Number.isNaN(due.getTime())) return { error: 'due_at is not a valid ISO 8601 time.' };
    if (due.getTime() < Date.now() - 60_000) return { error: 'That time has already passed.' };
    const [row] = await sql`
      insert into jarvis_reminders (person_id, text, due_at) values (${personId}, ${text}, ${due.toISOString()}) returning id
    `;
    return { ok: `Reminder [${row.id}] set for ${due.toISOString()}.` };
  }
  if (name === 'cancel_reminder') {
    const id = Number(args.id);
    if (!Number.isInteger(id)) return { error: 'id must be an integer.' };
    const rows = await sql`
      delete from jarvis_reminders where id = ${id} and person_id = ${personId} and sent_at is null returning id
    `;
    return rows.length ? { ok: `Cancelled [${id}].` } : { error: `There is no open reminder [${id}].` };
  }
  return { error: `Unknown tool: ${name}` };
}

/** Turns must alternate and start with the person; consecutive ones are joined. */
function alternate(history) {
  const out = [];
  for (const m of history) {
    if (!out.length && m.role !== 'user') continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content = `${last.content}\n${m.content}`;
    else out.push({ role: m.role, content: m.content });
  }
  return out;
}

/** What they sent besides text, as chat-completions content parts. */
function attachmentParts(attachments) {
  const parts = [];
  for (const a of attachments || []) {
    if (IMAGE_TYPES.has(a.mime)) parts.push({ type: 'image_url', image_url: { url: `data:${a.mime};base64,${a.data}` } });
    else if (a.mime === 'application/pdf') parts.push({ type: 'file', file: { filename: a.name || 'document.pdf', file_data: `data:application/pdf;base64,${a.data}` } });
  }
  return parts;
}

const WEB_SEARCH_TOOL = {
  name: 'web_search',
  description: 'Search the web for something current: news, prices, opening hours, schedules, facts that may have changed. Returns an answer from the results and the pages it came from.',
  input_schema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'What to look up, as a full question or search phrase.' } },
    required: ['query'],
  },
};

const asFunction = (t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } });

/**
 * One turn of a person's Jarvis: stores what they wrote, asks the model (with
 * memory, reminders and web search as tools), stores and returns the reply.
 */
export async function runJarvisTurn({ person, number, texts, attachments = [] }) {
  const userText = texts.join('\n').trim() || '[attachment]';
  await recordUserMessage(person.id, userText);

  const cfg = resolveApiConfig(await getUserSettings(number.owner_user_id));
  if (!configUsable(cfg)) {
    const reply = 'Jarvis is not set up yet: the 8Legs admin has not chosen a model for this account.';
    await recordAssistantMessage(person.id, reply);
    return reply;
  }
  const meta = { orgId: cfg.orgId, ownerId: number.owner_user_id, source: 'jarvis', itemType: 'number', itemId: number.id };

  const context = await loadContext(person.id);
  const messages = [{ role: 'system', content: buildSystem(person, context) }, ...alternate(context.history)];
  // The stored history ends with what they just wrote; give that turn its attachments.
  const parts = attachmentParts(attachments);
  const last = messages[messages.length - 1];
  if (parts.length && last && last.role === 'user') {
    last.content = [{ type: 'text', text: last.content }, ...parts];
  }

  const tools = [...CLIENT_TOOLS, ...(capabilityOn(person, 'web') ? [WEB_SEARCH_TOOL] : [])].map(asFunction);

  let reply = '';
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const { ok, status, data } = await llmFetch({ cfg, meta, body: { messages, tools, max_tokens: 4000 } });
      if (!ok) {
        const code = data && data.error && data.error.code;
        if (code === 'BUDGET') reply = 'I can\'t answer right now: this month\'s budget for the assistant is used up.';
        else if (status === 429) reply = "I'm a bit overloaded right now. Try me again in a minute.";
        else {
          console.error(`[jarvis ${person.id}] the model answered ${status}:`, data && data.error && data.error.message);
          reply = 'Sorry, something went wrong on my side. Please try again in a moment.';
        }
        break;
      }
      const message = data.choices[0].message || {};
      const calls = message.tool_calls || [];
      if (!calls.length) {
        reply = replyText(data);
        break;
      }
      messages.push(message);
      for (const call of calls) {
        let input = {};
        try { input = JSON.parse(call.function.arguments || '{}'); } catch { /* an empty call */ }
        let out;
        if (call.function.name === 'web_search' && capabilityOn(person, 'web')) {
          const found = await webSearch({ cfg, query: input.query, meta });
          out = found.error
            ? { error: found.error }
            : { ok: [found.answer, ...found.sources.map((x) => `- ${x.title ? `${x.title}: ` : ''}${x.url}`)].join('\n') };
        } else {
          out = await runTool(person.id, call.function.name, input).catch((err) => ({ error: err.message }));
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: out.error ? `Error: ${out.error}` : out.ok });
      }
    }
    if (!reply) reply = 'Sorry, I got stuck on that one. Could you ask again?';
  } catch (err) {
    console.error(`[jarvis ${person.id}] turn failed:`, err.message);
    // Out of money (the organization's balance, or the platform's month): the platform's stop message.
    reply = isStopped(err)
      ? await stopMessage((texts || []).join(' '))
      : 'Sorry, something went wrong on my side. Please try again in a moment.';
  }

  await recordAssistantMessage(person.id, reply);
  return reply;
}
