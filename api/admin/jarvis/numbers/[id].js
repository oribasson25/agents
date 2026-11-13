import { sql } from '../../../_db.js';
import { checkAdmin } from '../../../_auth.js';
import { getNumber, kickWorker, leaseHeld, markQrWanted, setCommand, workerSetupProblem } from '../../../_waControl.js';

/**
 * One linked number. Admins only.
 *
 *   GET            → the number, its Jarvis list and the AI Chatbots it may answer with
 *   GET ?qr=1      → the same, and keeps the worker showing a QR while the admin looks
 *   PATCH          → { label, mode, agentId, enabled } or { action: 'unlink' }
 *   DELETE         → removes a number that is not linked (unlink it first)
 *
 * The Jarvis list here is names, numbers and status only. What anyone said to
 * their Jarvis is never read by this endpoint.
 */
export default async function handler(req, res) {
  const admin = checkAdmin(req, res);
  if (!admin) return;

  const id = String(req.query.id || '');
  const number = await getNumber(id);
  if (!number) return res.status(404).json({ error: 'No such number.' });

  if (req.method === 'GET') {
    // Set only when the QR screen is open and no worker holds the number: the
    // reason no code will ever show up, so the screen can say it instead of waiting.
    let problem = null;
    if (req.query.qr) {
      await markQrWanted(id);
      if (!(await leaseHeld(id))) {
        problem = workerSetupProblem();
        if (!problem && !(await kickWorker(id))) {
          problem = 'The WhatsApp worker did not start. Check the Vercel function logs for /api/wa/worker.';
        }
      }
    }
    return res.json({ ...(await detail(id, { withQr: !!req.query.qr })), problem });
  }

  if (req.method === 'PATCH') {
    const body = req.body || {};

    if (body.action === 'unlink') {
      await setCommand(id, 'logout');
      if (!(await leaseHeld(id))) await kickWorker(id);
      return res.json(await detail(id));
    }

    const label = body.label !== undefined ? String(body.label).trim().slice(0, 80) : number.label;
    const mode = body.mode !== undefined ? (body.mode === 'jarvis' ? 'jarvis' : 'agent') : number.mode;
    const enabled = body.enabled !== undefined ? !!body.enabled : number.enabled;
    let agentId = number.agent_id;
    if (body.agentId !== undefined) {
      agentId = body.agentId ? String(body.agentId) : null;
      if (agentId) {
        // Only the owner account's own AI Chatbots: their key pays for the conversation.
        const [agent] = await sql`select id from agents where id = ${agentId} and user_id = ${number.owner_user_id}`;
        if (!agent) return res.status(400).json({ error: 'That AI Chatbot does not belong to this number\'s account.' });
      }
    }
    await sql`
      update wa_numbers
         set label = ${label}, mode = ${mode}, agent_id = ${agentId}, enabled = ${enabled}, updated_at = now()
       where id = ${id}
    `;
    if (enabled && number.phone && !(await leaseHeld(id))) await kickWorker(id);
    return res.json(await detail(id));
  }

  if (req.method === 'DELETE') {
    if (number.phone) return res.status(409).json({ error: 'Unlink the number before deleting it.' });
    await sql`delete from wa_numbers where id = ${id}`;
    return res.status(204).end();
  }

  res.status(405).end();
}

async function detail(id, { withQr = false } = {}) {
  const [n] = await sql`
    select n.id, n.label, n.owner_user_id, u.username as owner_username, n.mode, n.agent_id,
           n.enabled, n.phone, n.state, n.created_at,
           (n.lease_until is not null and n.lease_until > now()) as running,
           n.command
    from wa_numbers n join users u on u.id = n.owner_user_id
    where n.id = ${id}
  `;
  const state = n.state || {};
  const people = await sql`
    select id, name, phone, active, last_message_at, created_at,
           (capabilities->>'cal') is distinct from 'false' or (capabilities->>'gmail') is distinct from 'false' as wants_google
    from jarvis_people where number_id = ${id}
    order by created_at
  `;
  const agents = await sql`
    select id, data->>'name' as name from agents where user_id = ${n.owner_user_id} order by data->>'name'
  `;
  return {
    ...n,
    state: {
      status: state.status || (n.phone ? 'unknown' : 'unlinked'),
      error: state.error || null,
      me: state.me || null,
      updatedAt: state.updatedAt || null,
      qr: withQr ? state.qr || null : undefined,
    },
    people,
    agents,
  };
}
