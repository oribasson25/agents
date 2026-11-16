/**
 * Messages automations ask a linked WhatsApp number to send.
 *
 * Only the number's worker holds its connection to WhatsApp, so a step cannot
 * send by itself: it leaves the message here, and the worker picks it up a
 * couple of seconds later (see `sendOutbox` in _waRouter.mjs).
 *
 * A linked number is somebody's real WhatsApp account. One that starts
 * sending in bulk gets banned, and a ban takes the organization's chatbot and
 * its Jarvis down with it — so a number takes only so many an hour, and the
 * worker sends them one at a time with a pause between.
 */
import { sql } from './_db.js';
import { normalizePhone } from './_waControl.js';

export const HOURLY_LIMIT = 120;
export const SEND_GAP_MS = 1500;
const MAX_TEXT = 8000;

/** "+972 54-555 0118" → "972545550118"; a group id is kept as it is. Null when it is neither. */
export function recipientOf(to) {
  const raw = String(to || '').trim();
  if (/^[\w.-]+@g\.us$/.test(raw)) return raw;
  const digits = normalizePhone(raw.replace(/@s\.whatsapp\.net$/, ''));
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

export const jidOfRecipient = (recipient) => (recipient.includes('@') ? recipient : `${recipient}@s.whatsapp.net`);

/** Queues one message. Throws with words for the run log when it cannot. */
export async function enqueue({ numberId, to, text, source = '' }) {
  const recipient = recipientOf(to);
  if (!recipient) throw new Error(`"${to}" is not a phone number with a country code, or a group id`);
  const body = String(text ?? '').trim();
  if (!body) throw new Error('has no text to send');
  if (body.length > MAX_TEXT) throw new Error(`the text is ${body.length} characters; a message holds at most ${MAX_TEXT}`);

  const [number] = await sql`select id, enabled, phone from wa_numbers where id = ${numberId}`;
  if (!number) throw new Error('the WhatsApp number behind this connection no longer exists');
  if (!number.phone) throw new Error('the WhatsApp number behind this connection is not linked to a phone yet');
  if (!number.enabled) throw new Error('the WhatsApp number behind this connection is switched off');

  const [{ n }] = await sql`
    select count(*)::int as n from wa_outbox
    where number_id = ${numberId} and created_at > now() - interval '1 hour'
  `;
  if (n >= HOURLY_LIMIT) {
    throw new Error(`this number has already been asked to send ${HOURLY_LIMIT} messages in the last hour, which is its limit`);
  }
  const [row] = await sql`
    insert into wa_outbox (number_id, recipient, body, source)
    values (${numberId}, ${recipient}, ${body}, ${String(source).slice(0, 80)})
    returning id
  `;
  return { id: row.id, to: recipient };
}

/**
 * The next few queued messages for a number, claimed so that a worker
 * handing over to the next one cannot send any of them twice.
 */
export async function claim(numberId, limit = 5) {
  return sql`
    update wa_outbox set status = 'sending'
    where id in (
      select id from wa_outbox where number_id = ${numberId} and status = 'queued' order by id limit ${limit}
    ) and status = 'queued'
    returning id, recipient, body
  `;
}

export const markSent = (id) => sql`update wa_outbox set status = 'sent', sent_at = now() where id = ${id}`;
export const markFailed = (id, error) => sql`update wa_outbox set status = 'failed', error = ${String(error).slice(0, 300)} where id = ${id}`;

/** A message a worker claimed and then died holding goes back in the queue once. */
export async function requeueStuck(numberId) {
  await sql`
    update wa_outbox set status = 'queued'
    where number_id = ${numberId} and status = 'sending' and created_at < now() - interval '3 minutes'
      and created_at > now() - interval '1 hour'
  `;
}

export async function pruneOutbox() {
  await sql`delete from wa_outbox where created_at < now() - interval '14 days'`;
}
