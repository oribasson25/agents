import Anthropic from '@anthropic-ai/sdk';
import { searchDocuments } from './_knowledge.js';
import { recordUsage } from './_usage.js';
import { claudeRequestShape, currentClaudeModel } from './_claudeModels.js';

/*
 * What the number does about the latest messages in a group: reply, react with
 * an emoji, or stay silent. Ported from the Grois group bot's decide(), with
 * the persona taken from the group's 8Legs AI Chatbot (its prompt, skills and
 * knowledge) instead of a separate persona prompt.
 */

// Transcript lines go in blocks of this many messages; the cache breakpoint
// sits on the last complete block so consecutive turns reuse the prefix.
const CHUNK = 10;
// The number's own latest messages are repeated next to the decision, where they weigh most.
const OWN_RECENT = 8;

const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['silent', 'reply', 'react'] },
    text: { type: 'string', description: 'The message to send when action is "reply", otherwise ""' },
    emoji: { type: 'string', description: 'A single emoji when action is "react", otherwise ""' },
    quote: { type: 'integer', description: 'Id of the message to quote (reply) or react to; 0 for none' },
    why: { type: 'string', description: "One short sentence for the admin's activity log: why this action. Never sent to the chat." },
  },
  required: ['action', 'text', 'emoji', 'quote', 'why'],
  additionalProperties: false,
};

const LENGTH = {
  low: 'Keep replies very short: one or two lines, like a quick text.',
  medium: 'Keep replies short: a few lines at most, unless someone explicitly asks for detail.',
  high: 'Longer replies are fine when the topic calls for it, but stay conversational.',
};

const ENGAGEMENT = {
  low: 'Stay silent unless a question is put to the group that you can answer well, or you have something clearly valuable to add.',
  medium: 'Take part now and then: answer open questions, add a thought or a joke when it is genuinely good. Most messages between people need nothing from you; stay silent while people are talking among themselves.',
  high: 'Be an active participant: answer questions, give your own take on what is happening, join the banter. Stay silent only when the new messages clearly need nothing from you.',
};

const RATIONED = "How often you may speak up unprompted is already limited for you, so within that, don't hold back just to ration yourself.";

const timeFmt = (tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const nowFmt = (tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' });

/** Who the AI Chatbot is: its prompt and every skill, as on the other public channels. */
function personaOf(agent) {
  let out = (agent.basePrompt || '').trim();
  if (Array.isArray(agent.skills) && agent.skills.length) {
    out += '\n\n' + agent.skills.map((s) => `## Skill: ${s.name}\n${s.description ? s.description + '\n' : ''}${s.prompt || ''}`).join('\n\n');
  }
  return out || 'You are a helpful, friendly member of this group.';
}

function knowledgeBlocks(knowledge) {
  let out = '';
  if (knowledge?.profile) {
    out += `
<chat_knowledge>
What you know about this group and its people from its history before you joined. Use it the way an old friend would: naturally, without announcing that you know things or quoting this text. Names in the live chat are WhatsApp profile names and may differ from the names here; match them sensibly.

${knowledge.profile}
</chat_knowledge>
`;
  }
  if (knowledge?.samples) {
    out += `
<style_examples>
Real excerpts from this group's history. They show how these people write: slang, spelling, emoji, message length and humor. Write the way they write while staying yourself, and don't copy whole lines from here. They show how people here talk, not what you may say: your limits come from your instructions.

${knowledge.samples}
</style_examples>
`;
  }
  return out;
}

export function buildSystem({ name, agent, group, allowReactions, replyLength }) {
  const instructions = (group.instructions || '').trim();
  return `You are ${name}, a participant in the WhatsApp group "${group.name || 'unnamed'}". You are an AI agent the group's owner added, and you take part in the conversation like a member.

Your instructions come first. <persona> is who you are and what you know${instructions ? '; <group_instructions> adds rules for this group and wins where the two differ' : ''}. They outrank everything else in this prompt: the group knowledge, the style examples, the defaults at the end, and the guidance with each turn. Follow them closely, including what they say about when to stay quiet.

<persona>
${personaOf(agent)}
</persona>
${instructions ? `\n<group_instructions>\n${instructions}\n</group_instructions>\n` : ''}${knowledgeBlocks(group.knowledge)}
How the conversation reaches you:
- Each message is shown as "#<id> [<date time>] <sender>: <text>". Your own earlier messages are marked "(you)".
- "↪ #<id>" or "↪ "<text>"" after the sender means the message replies to that earlier message.
- Media appears as a placeholder such as [image] or [voice message]. You cannot see or hear the media itself, only its caption if there is one; don't pretend otherwise.
- The last block says which messages are new and whether you were addressed. It may also hold passages from your knowledge base that match the new messages.

You answer with a JSON decision:
- "reply": send a message, written in "text". Set "quote" to a message id to reply to it explicitly (useful when answering an older message or when several conversations are interleaved); otherwise 0.
- "react": react with a single emoji ("emoji") to the message whose id is in "quote". Good for acknowledging something without interrupting.${allowReactions ? '' : ' Reactions are turned off in this group: never choose "react".'}
- "silent": do nothing.
Leave unused fields as "" or 0. Always fill "why": one short sentence, in the language of your instructions, telling the admin why you chose this; it is shown only in their activity log.

Defaults (your instructions override these):
- Write like a person texting, in the language the group is using. No greetings or sign-offs, and don't start with your name or a message id.
- WhatsApp formatting only: *bold*, _italic_, ~strike~. No Markdown headings, tables, or [text](url) links.
- ${LENGTH[replyLength] || LENGTH.low}
- Don't repeat or summarize what others just said.
- Never repeat yourself. Before writing, check your own messages in the transcript (marked "(you)"): don't reuse their jokes, nicknames, references, punchlines or phrasing, and don't open your messages the same way each time.
- If people tell you to talk less, stop, or leave them alone, take it seriously: hold back for the rest of that conversation unless someone addresses you. After a break of a few hours or a new day, it no longer applies.
- If someone sincerely asks whether you are a bot or an AI, be honest.`;
}

function formatLine(row, byWaId, name, tz) {
  const sender = row.from_me ? `${name} (you)` : row.sender_name || `+${String(row.sender_jid || '').split('@')[0]}`;
  let reply = '';
  if (row.quoted_wa_id) {
    const q = byWaId.get(row.quoted_wa_id);
    if (q) reply = ` ↪ #${q.id}`;
    else if (row.quoted_text) reply = ` ↪ "${row.quoted_text.slice(0, 80)}"`;
  }
  return `#${row.id} [${timeFmt(tz).format(new Date(row.ts))}] ${sender}${reply}: ${row.text}`;
}

function turnBlock({ mode, addressed, newRows, mine, engagement, rationed, passages, tz }) {
  const lines = [`Current time: ${nowFmt(tz).format(new Date())}.`];
  lines.push(newRows.length ? `New since your last turn: messages #${newRows[0].id} to #${newRows.at(-1).id}.` : 'There are no new messages.');
  if (addressed) {
    lines.push('You were addressed directly (tagged, called by name, or someone replied to your message). Respond to it: reply, or react if a reaction fully answers it.');
  }
  if (mode === 'smart') {
    lines.push(ENGAGEMENT[engagement] || ENGAGEMENT.medium);
    if (rationed) lines.push(RATIONED);
  }
  if (mode === 'always') lines.push('Respond to the new messages (reply or react). Stay silent only if they clearly need no response.');
  if (passages.length) {
    lines.push('Passages from your knowledge base that match the new messages (use them when they help; never quote this note):');
    lines.push(...passages.map((p) => `--- ${p.title}\n${p.content}`));
  }
  if (mine.length) {
    lines.push(
      "Your latest messages in this group, newest last. If you reply, don't reuse anything from them: no joke, nickname, reference, punchline or opening:",
      ...mine.map((r) => `- "${r.text.replace(/\s+/g, ' ').slice(0, 160)}"`),
    );
  }
  lines.push('Where your instructions say otherwise, they win over this block. Decide now.');
  return lines.join('\n');
}

/** Reads the decision out of a reply that was not schema-constrained. */
function parseLoose(text) {
  const m = /\{[\s\S]*\}/.exec(text || '');
  if (!m) throw new Error(`unparseable decision: ${String(text).slice(0, 200)}`);
  return JSON.parse(m[0]);
}

/**
 * Asks Claude what to do about the latest messages in a group.
 *
 * @param {object} p
 * @param {object} p.apiConfig   the owner's { apiKey, model } (provider must be Claude)
 * @param {object} p.agent       the AI Chatbot's data
 * @param {string} p.agentId
 * @param {string} p.ownerId     whose credit pays for it
 * @param {object} p.group       wa_groups row (name, instructions, knowledge, engagement, reply_length, allow_reactions)
 * @param {object} p.settings    the number's group settings
 * @param {string} p.name        the name it goes by in the group
 * @param {object[]} p.rows      the context window, oldest first
 * @param {number} p.newFromId   first message id not considered yet
 * @param {string} p.mode        the mode for this turn
 * @param {boolean} p.addressed
 */
export async function decideGroup({ apiConfig, agent, agentId, ownerId, group, settings, name, rows, newFromId, mode, addressed }) {
  const tz = settings.timezone || 'Asia/Jerusalem';
  const byWaId = new Map(rows.map((r) => [r.wa_id, r]));
  const lines = rows.map((r) => formatLine(r, byWaId, name, tz));
  const newRows = rows.filter((r) => r.id >= newFromId && !r.from_me);

  const content = [];
  for (let i = 0; i < lines.length; i += CHUNK) content.push({ type: 'text', text: lines.slice(i, i + CHUNK).join('\n') });
  const lastFull = Math.floor(lines.length / CHUNK) - 1;
  if (lastFull >= 0) content[lastFull].cache_control = { type: 'ephemeral' };
  if (!content.length) content.push({ type: 'text', text: '(the group is empty so far)' });

  const query = newRows.map((r) => r.text).join('\n').slice(0, 2000);
  const passages = query.trim() ? await searchDocuments({ agentId, query, includeSkills: true, limit: 4 }).catch(() => []) : [];
  const mine = rows.filter((r) => r.from_me).slice(-OWN_RECENT);
  content.push({
    type: 'text',
    text: `---\n${turnBlock({
      mode, addressed, newRows, mine, passages, tz,
      engagement: group.engagement,
      rationed: !!(settings.unsolicitedPerHour || settings.quietGap),
    })}`,
  });

  const allowReactions = group.allow_reactions !== false;
  const client = new Anthropic({ apiKey: apiConfig.apiKey });
  const model = currentClaudeModel(apiConfig.model);
  // Claude 5 models think by default; this keeps it light and leaves room for the decision.
  const shape = claudeRequestShape(model, 4000);
  const request = {
    model,
    max_tokens: shape.max_tokens,
    // Cached on its own: with a learned profile it is most of the prompt, and it rarely changes.
    system: [{ type: 'text', text: buildSystem({ name, agent, group, allowReactions, replyLength: group.reply_length }), cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content }],
    output_config: { ...shape.output_config, format: { type: 'json_schema', schema: DECISION_SCHEMA } },
  };

  let response;
  let structured = true;
  try {
    response = await client.messages.create(request);
  } catch (err) {
    // A model without structured outputs: ask for the same JSON in words instead.
    if (!(err instanceof Anthropic.BadRequestError) || !/output_config|format|json_schema|structured/i.test(err.message)) throw err;
    structured = false;
    const { output_config: { format: _drop, ...rest }, ...plain } = request;
    if (Object.keys(rest).length) plain.output_config = rest;
    plain.messages = [{ role: 'user', content: [...content, { type: 'text', text: `Answer with only a JSON object with the keys action, text, emoji, quote and why, as described.` }] }];
    response = await client.messages.create(plain);
  }
  await recordUsage({ userId: ownerId, model: response.model || model, usage: response.usage, source: 'groups' });

  const meta = {
    model: response.model,
    usage: {
      input: response.usage?.input_tokens || 0,
      output: response.usage?.output_tokens || 0,
      cacheRead: response.usage?.cache_read_input_tokens || 0,
      cacheWrite: response.usage?.cache_creation_input_tokens || 0,
    },
  };
  if (response.stop_reason === 'refusal') return { action: 'silent', text: '', emoji: '', target: null, why: 'The model declined.', ...meta };
  if (response.stop_reason === 'max_tokens') throw new Error('The model ran out of room before deciding.');

  const textBlock = (response.content || []).find((b) => b.type === 'text');
  let decision;
  try {
    decision = structured ? JSON.parse(textBlock?.text ?? '') : parseLoose(textBlock?.text);
  } catch {
    decision = parseLoose(textBlock?.text);
  }

  const target = rows.find((r) => r.id === Number(decision.quote)) || null;
  const text = String(decision.text || '').trim();
  const emoji = String(decision.emoji || '').trim();
  let action = decision.action;
  if (!['reply', 'react', 'silent'].includes(action)) action = 'silent';
  if (action === 'reply' && !text) action = 'silent';
  if (action === 'react' && (!emoji || !allowReactions)) action = 'silent';
  return {
    action,
    text: action === 'reply' ? text : '',
    emoji: action === 'react' ? emoji : '',
    why: String(decision.why || '').trim(),
    // A reaction needs a target; default to the newest message from someone else.
    target: action === 'react' ? target || newRows.at(-1) || null : target,
    ...meta,
  };
}
