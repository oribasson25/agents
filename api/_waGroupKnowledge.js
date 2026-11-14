import Anthropic from '@anthropic-ai/sdk';
import { sql } from './_db.js';
import { recordUsage } from './_usage.js';
import { describeClaudeError, logGroupEvent } from './_waGroups.js';

/*
 * Turns a WhatsApp chat export into knowledge the number carries into a group
 * (ported from the Grois group bot). The browser parses the export and sends
 * it in parts; Haiku reads each part and writes notes (cheap, one request per
 * part), then Opus merges all the notes plus the most recent messages into one
 * profile of the group. The profile and a few real excerpts go into the
 * prompt on every turn in that group (see buildSystem in _waGroupBrain.js).
 *
 * Runs on the number owner's Claude key, and is counted in their credit.
 */

const DIGEST_MODEL = 'claude-haiku-5-5';
const PROFILE_MODEL = 'claude-opus-5-5';
const STALE_JOB_MS = 15 * 60_000;

const DIGEST_SYSTEM = `You are helping an AI agent get to know a WhatsApp group before it joins them. You'll read one part of the group's chat history and write notes that a later step merges, together with the notes from the other parts, into a profile of the group. With that profile the agent should be able to talk like someone who has been in the group for years: know the people, get the references, and speak their language.

Write the notes in the language the group writes in, keeping names, slang and quotes exactly as they appear in the chat. Cover what this part actually shows:
- People: for each participant who says something meaningful, what we learn about them (work, studies, family and partners, where they live, hobbies, teams they support, habits, plans), their personality and role in the group, and how they write (message length, slang, spelling quirks, emoji, catchphrases), with short verbatim examples.
- Inside jokes, nicknames, running gags and recurring stories, with a short verbatim example and what each refers to.
- The group's language: slang, recurring phrases, typical tone and humor, with verbatim examples.
- Events: things that happened or were planned (trips, parties, weddings, moves, fights), with approximate dates.
- Dynamics: who teases whom, who organizes, what gets the group going, and topics that are sensitive.

Only write what the chat supports; when you infer something, say so. Skip routine logistics that won't matter later. Keep the notes under about 1,500 words, and favor details specific to these people over generic observations.`;

const PROFILE_SYSTEM = `You are writing the knowledge an AI agent will carry into a WhatsApp group. The agent is a new member, but it should talk like someone who has known these people for years. You have notes written from the group's chat history, oldest part first, and the most recent messages verbatim.

Write the profile in the language the group writes in. It goes into the agent's prompt as is, so write it as reference material for the agent, in plain text with short headings (no Markdown tables). Sections:

1. The group in a few sentences: who they are, how they know each other, what the group is about.
2. People: one entry per participant, under the name used in the chat (list other names and nicknames). Facts about their life, their personality and role in the group, and how they write, with a couple of short verbatim quotes.
3. Inside jokes, nicknames and running stories: what each refers to and how it comes up.
4. The group's language: slang, recurring phrases, emoji, message length, the kind of humor that lands, with short verbatim examples.
5. Timeline: notable events and plans, with approximate dates.
6. How to talk with this group: practical guidance for the agent, such as the tone that fits, what gets laughs, who enjoys being teased and who doesn't, and sensitive topics to stay away from.

When notes conflict, prefer the newer information (people change jobs, partners and cities) and mention the change when it matters. Leave out what you're not fairly sure about rather than guessing. Aim for 1,500 to 3,000 words, dense with specifics and without filler.`;

const textOf = (message) => (message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();

/** Notes on one part of the export. A part the model declines to read yields no notes. */
export async function digestPart({ apiKey, ownerId, chatName, part, parts, from, to, text }) {
  const client = new Anthropic({ apiKey });
  const message = await client.messages
    .stream({
      model: DIGEST_MODEL,
      max_tokens: 8000,
      system: DIGEST_SYSTEM,
      messages: [{ role: 'user', content: `Group: "${chatName || 'unnamed'}"\nPart ${part} of ${parts}, ${from} to ${to}.\n\n<chat>\n${text}\n</chat>` }],
      output_config: { effort: 'low' },
    })
    .finalMessage();
  await recordUsage({ userId: ownerId, model: message.model || DIGEST_MODEL, usage: message.usage, source: 'group-learning' });
  if (message.stop_reason === 'refusal') return { notes: '', skipped: true };
  return { notes: textOf(message) }; // notes cut off at max_tokens are still useful
}

async function writeProfile({ apiKey, ownerId, chatName, notes, recent }) {
  const sections = notes
    .filter((n) => n.notes)
    .map((n) => `<notes part="${n.part}" from="${n.from}" to="${n.to}">\n${n.notes}\n</notes>`)
    .join('\n\n');
  const client = new Anthropic({ apiKey });
  const message = await client.messages
    .stream({
      model: PROFILE_MODEL,
      max_tokens: 32000,
      system: PROFILE_SYSTEM,
      messages: [{ role: 'user', content: `Group: "${chatName || 'unnamed'}"\n\n${sections}\n\n<recent_messages>\n${recent}\n</recent_messages>\n\nWrite the profile now.` }],
      output_config: { effort: 'medium' },
    })
    .finalMessage();
  await recordUsage({ userId: ownerId, model: message.model || PROFILE_MODEL, usage: message.usage, source: 'group-learning' });
  if (message.stop_reason === 'refusal') throw new Error('The model declined to read this chat.');
  if (message.stop_reason === 'max_tokens') throw new Error('The profile came out too long; try again.');
  return textOf(message);
}

async function setKnowledge(numberId, jid, knowledge) {
  await sql`
    update wa_groups set knowledge = ${knowledge ? JSON.stringify(knowledge) : null}, updated_at = now()
    where number_id = ${numberId} and jid = ${jid}
  `;
}

/**
 * Writes the profile and stores it with the style samples. Progress is kept in
 * `job` on the group's knowledge, which the admin screen polls; the previous
 * profile stays in use until the new one is ready.
 */
export async function buildKnowledge({ apiKey, ownerId, numberId, group, notes, recent, samples, stats }) {
  const previous = group.knowledge || {};
  await setKnowledge(numberId, group.jid, { ...previous, job: { status: 'building', startedAt: Date.now() } });
  try {
    const profile = await writeProfile({ apiKey, ownerId, chatName: group.name, notes, recent });
    await setKnowledge(numberId, group.jid, { profile, samples, stats, importedAt: Date.now(), job: null });
    await logGroupEvent(numberId, group.jid, 'knowledge', { messages: stats?.messages || null });
  } catch (err) {
    console.error(`[groups] profile for ${group.jid} failed:`, err.message);
    await setKnowledge(numberId, group.jid, { ...previous, job: { status: 'error', error: describeClaudeError(err) } });
  }
}

/** A job that never finished (the function was cut off) shows as failed instead of hanging. */
export function jobState(knowledge) {
  const job = knowledge?.job;
  if (job?.status === 'building' && Date.now() - job.startedAt > STALE_JOB_MS) {
    return { status: 'error', error: 'The import was cut off halfway; import the chat again.' };
  }
  return job || null;
}

export { setKnowledge };
