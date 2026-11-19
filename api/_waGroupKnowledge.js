import { sql } from './_db.js';
import { llmFetch, replyText, modelInfo } from './_llm.js';
import { describeClaudeError, logGroupEvent } from './_waGroups.js';

/*
 * Turns a WhatsApp chat export into knowledge the number carries into a group
 * (ported from the Grois group bot). The browser parses the export and sends
 * it in parts; the model reads each part and writes notes (one request per
 * part), then merges all the notes plus the most recent messages into one
 * profile of the group. The profile and a few real excerpts go into the
 * prompt on every turn in that group (see buildSystem in _waGroupBrain.js).
 *
 * Runs on the model the platform chose for the number owner's organization,
 * through the platform's OpenRouter key.
 */
const STALE_JOB_MS = 15 * 60_000;

const DIGEST_SYSTEM = `You are helping an AI agent get to know a WhatsApp group before it joins them. You'll read one part of the group's chat history and write notes that a later step merges, together with the notes from the other parts, into a profile of the group. With that profile the agent should be able to talk like someone who has been in the group for years: know the people, get the references, and speak their language.

Write the notes in the language the group writes in, keeping names, slang and quotes exactly as they appear in the chat. Cover what this part actually shows:
- People: for each participant who says something meaningful, their personality and role in the group, broad interests (hobbies, teams they support, the kind of work or studies in general terms), and how they write (message length, slang, spelling quirks, emoji, catchphrases), with short verbatim examples.
- Inside jokes, nicknames, running gags and recurring stories, with a short verbatim example and what each refers to.
- The group's language: slang, recurring phrases, typical tone and humor, with verbatim examples.
- Events: things that happened or were planned (trips, parties, weddings, moves, fights), with approximate dates.
- Dynamics: who teases whom, who organizes, what gets the group going, and topics that are sensitive.

Only write what the chat supports; when you infer something, say so. Skip routine logistics that won't matter later. Keep the notes under about 1,500 words, and favor details specific to these people over generic observations.

Privacy: everything you write may be read by any member of the group, including people who joined later. Leave out entirely: home addresses and exact locations, phone numbers, emails and other contact details, employers and workplaces by name, partners' and children's names and relationship details, health, money and debts, legal matters, religious or political views of a named person, and anything said privately or in confidence.`;

const PROFILE_SYSTEM = `You are writing the knowledge an AI agent will carry into a WhatsApp group. The agent is a new member, but it should talk like someone who has known these people for years. You have notes written from the group's chat history, oldest part first, and the most recent messages verbatim.

Write the profile in the language the group writes in. It goes into the agent's prompt as is, so write it as reference material for the agent, in plain text with short headings (no Markdown tables). Sections:

1. The group in a few sentences: who they are, how they know each other, what the group is about.
2. People: one entry per participant, under the name used in the chat (list other names and nicknames). Their personality and role in the group, broad interests, and how they write, with a couple of short verbatim quotes. No private facts about their life (see Privacy below).
3. Inside jokes, nicknames and running stories: what each refers to and how it comes up.
4. The group's language: slang, recurring phrases, emoji, message length, the kind of humor that lands, with short verbatim examples.
5. Timeline: notable events and plans, with approximate dates.
6. How to talk with this group: practical guidance for the agent, such as the tone that fits, what gets laughs, who enjoys being teased and who doesn't, and sensitive topics to stay away from.

When notes conflict, prefer the newer information and mention the change when it matters. Leave out what you're not fairly sure about rather than guessing. Aim for 1,500 to 3,000 words, dense with specifics and without filler.

Privacy: the agent must never be a way for one member to learn private things about another, and this profile is what it would leak. Leave out entirely, even when the notes have it: home addresses and exact locations, phone numbers, emails and other contact details, employers and workplaces by name, partners' and children's names and relationship details, health, money and debts, legal matters, religious or political views of a named person, and anything said privately or in confidence.`;

/** A long answer, capped at what the model can write. */
async function capped(cfg, wanted) {
  const info = await modelInfo(cfg.model);
  return info && info.maxOutput ? Math.min(wanted, info.maxOutput) : wanted;
}

async function ask(cfg, ownerId, { system, user, maxTokens }) {
  const { ok, status, data } = await llmFetch({
    cfg,
    meta: { orgId: cfg.orgId, ownerId, source: 'group-learning' },
    body: { max_tokens: await capped(cfg, maxTokens), messages: [{ role: 'system', content: system }, { role: 'user', content: user }] },
  });
  if (!ok) throw Object.assign(new Error((data.error && data.error.message) || `the model answered ${status}`), { status });
  const choice = data.choices[0];
  return { text: replyText(data), refused: !!(choice.message && choice.message.refusal), cutOff: choice.finish_reason === 'length' };
}

/** Notes on one part of the export. A part the model declines to read yields no notes. */
export async function digestPart({ cfg, ownerId, chatName, part, parts, from, to, text }) {
  const out = await ask(cfg, ownerId, {
    system: DIGEST_SYSTEM,
    user: `Group: "${chatName || 'unnamed'}"\nPart ${part} of ${parts}, ${from} to ${to}.\n\n<chat>\n${text}\n</chat>`,
    maxTokens: 8000,
  });
  if (out.refused || !out.text) return { notes: '', skipped: true };
  return { notes: out.text }; // notes cut off at max_tokens are still useful
}

async function writeProfile({ cfg, ownerId, chatName, notes, recent }) {
  const sections = notes
    .filter((n) => n.notes)
    .map((n) => `<notes part="${n.part}" from="${n.from}" to="${n.to}">\n${n.notes}\n</notes>`)
    .join('\n\n');
  const out = await ask(cfg, ownerId, {
    system: PROFILE_SYSTEM,
    user: `Group: "${chatName || 'unnamed'}"\n\n${sections}\n\n<recent_messages>\n${recent}\n</recent_messages>\n\nWrite the profile now.`,
    maxTokens: 16000,
  });
  if (out.refused || !out.text) throw new Error('The model declined to read this chat.');
  if (out.cutOff) throw new Error('The profile came out too long; try again.');
  return out.text;
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
export async function buildKnowledge({ cfg, ownerId, numberId, group, notes, recent, samples, stats }) {
  const previous = group.knowledge || {};
  await setKnowledge(numberId, group.jid, { ...previous, job: { status: 'building', startedAt: Date.now() } });
  try {
    const profile = await writeProfile({ cfg, ownerId, chatName: group.name, notes, recent });
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
