import Anthropic from '@anthropic-ai/sdk';
import { sql } from './_db.js';
import { nowBlock, PLATFORM_TZ } from './_now.js';
import { getUserSettings, resolveApiConfig } from './_settings.js';

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
 * The model and key are the number owner's account settings, like every other
 * channel in 8Legs. Jarvis needs Claude: it relies on tool use and web search.
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

// Models that take the dynamic-filtering web search; older ones keep the basic tool.
const NEW_SEARCH = /^claude-(fable|mythos|opus-5|sonnet-5|opus-4-[678]|sonnet-4-6)/;
// Models that may decline on safety grounds and take a server-side fallback.
const FALLBACK_MODELS = /^claude-(fable-5-[12]|opus-5-5|opus-5$|sonnet-5-5)/;

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
    sql`select id, fact from jarvis_memory where person_id = ${personId} order by id limit ${MAX_FACTS}`,
    sql`select id, text, due_at from jarvis_reminders where person_id = ${personId} and sent_at is null order by due_at limit 50`,
  ]);
  return { history: history.reverse(), memory, reminders };
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

/** Claude needs user/assistant turns to alternate and to start with the user. */
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

function attachmentBlocks(attachments) {
  const blocks = [];
  for (const a of attachments || []) {
    if (IMAGE_TYPES.has(a.mime)) blocks.push({ type: 'image', source: { type: 'base64', media_type: a.mime, data: a.data } });
    else if (a.mime === 'application/pdf') blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.data } });
  }
  return blocks;
}

/**
 * One turn of a person's Jarvis: stores what they wrote, asks Claude (with
 * memory, reminders and web search as tools), stores and returns the reply.
 */
export async function runJarvisTurn({ person, number, texts, attachments = [] }) {
  const userText = texts.join('\n').trim() || '[attachment]';
  await recordUserMessage(person.id, userText);

  const cfg = resolveApiConfig(await getUserSettings(number.owner_user_id), null);
  if (cfg.provider !== 'claude' || !cfg.apiKey) {
    const reply = 'Jarvis needs a Claude API key in the 8Legs account settings before it can answer.';
    await recordAssistantMessage(person.id, reply);
    return reply;
  }

  const context = await loadContext(person.id);
  const messages = alternate(context.history);
  // The stored history ends with what they just wrote; give that turn its attachments.
  const blocks = attachmentBlocks(attachments);
  if (blocks.length && messages.length && messages[messages.length - 1].role === 'user') {
    const last = messages[messages.length - 1];
    last.content = [...blocks, { type: 'text', text: last.content }];
  }

  const model = cfg.model;
  const tools = [...CLIENT_TOOLS];
  if (capabilityOn(person, 'web')) {
    tools.push({ type: NEW_SEARCH.test(model) ? 'web_search_20260209' : 'web_search_20250305', name: 'web_search', max_uses: 5 });
  }
  const fallback = FALLBACK_MODELS.test(model)
    ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }
    : {};

  const client = new Anthropic({ apiKey: cfg.apiKey });
  const system = buildSystem(person, context);

  let reply = '';
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const response = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        system,
        tools,
        messages,
        ...fallback,
      });

      if (response.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: response.content });
        continue;
      }
      if (response.stop_reason === 'tool_use') {
        messages.push({ role: 'assistant', content: response.content });
        const results = [];
        for (const block of response.content) {
          if (block.type !== 'tool_use') continue;
          const out = await runTool(person.id, block.name, block.input).catch((err) => ({ error: err.message }));
          results.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: out.error || out.ok,
            ...(out.error && { is_error: true }),
          });
        }
        messages.push({ role: 'user', content: results });
        continue;
      }
      if (response.stop_reason === 'refusal') {
        reply = "Sorry, I can't help with that one.";
        break;
      }
      reply = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      break;
    }
    if (!reply) reply = 'Sorry, I got stuck on that one. Could you ask again?';
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      reply = 'The Claude API key in the 8Legs account settings was rejected, so I cannot answer right now.';
    } else if (err instanceof Anthropic.RateLimitError) {
      reply = "I'm a bit overloaded right now. Try me again in a minute.";
    } else {
      console.error(`[jarvis ${person.id}] turn failed:`, err instanceof Anthropic.APIError ? `${err.status} ${err.message}` : err.message);
      reply = 'Sorry, something went wrong on my side. Please try again in a moment.';
    }
  }

  await recordAssistantMessage(person.id, reply);
  return reply;
}
