import { sql } from './_db.js';

export const PHONE_CONFLICT_MESSAGE =
  'This WhatsApp phone number ID is already connected to another agent.';

/**
 * A WhatsApp phone_number_id must map to at most one agent. It is not a secret,
 * so without an exclusive claim anyone could point someone else's number at
 * their own agent and take over — or silently kill — that channel.
 * Returns the id of the agent already holding the number, or null.
 */
export async function findPhoneNumberConflict(phoneNumberId, selfAgentId) {
  const pid = (phoneNumberId || '').trim();
  if (!pid) return null;

  const [taken] = await sql`
    select id from agents
    where data->'whatsapp'->>'phoneNumberId' = ${pid}
      and id <> ${selfAgentId || ''}
    limit 1
  `;
  return taken ? taken.id : null;
}
