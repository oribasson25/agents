import crypto from 'crypto';
import { sql } from './_db.js';
import { checkAuthOrToken } from './_auth.js';
import { redactAgentSecrets } from './_agentFiles.js';
import { findPhoneNumberConflict, PHONE_CONFLICT_MESSAGE } from './_whatsappClaim.js';
import { member, visible, canCreate } from './_access.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  /* The CLI lists agents here to find an id, and `8legs login` calls it to
     check the token it was just given — so this has to take one. */
  const user = await checkAuthOrToken(req, res);
  if (!user) return;

  const me = await member(user);
  if (!me) return res.status(401).json({ error: 'unauthorized' });

  if (req.method === 'GET') {
    /* An agent with an open draft is shown as its draft, because that is what
       the person editing last left behind — main is what customers see, and
       returning main here would make every unpublished edit look lost. */
    const rows = await sql`
      select a.id, a.org_id, a.data,
             (select b.data from agent_branches b
               where b.agent_id = a.id and b.kind = 'draft' and b.merged_at is null) as draft
      from agents a
      where a.org_id = ${me.orgId}
      order by a.created_at desc
    `;
    /* The organization's agents this person may see, each saying how far. */
    const shown = await visible(me, 'agent', rows);
    /* The id is always the row's own, whatever the stored JSON says; and
       someone who may only look does not get the chatbot's credentials. */
    const shape = (data, level) => (level === 'edit' ? data : redactAgentSecrets(data));
    return res.json(shown.map(({ row: r, level }) => (r.draft
      ? { ...shape(r.draft, level), id: r.id, _branch: 'draft', _access: level }
      : { ...shape(r.data, level), id: r.id, _branch: 'main', _access: level })));
  }

  if (req.method === 'POST') {
    if (!canCreate(me)) {
      return res.status(403).json({ error: 'Only the organization\'s admin, or a member who can edit everything, can add an AI Chatbot.', code: 'READ_ONLY' });
    }
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
    if (!body) return res.status(400).json({ error: 'An AI Chatbot is sent as a JSON object.' });
    /* The interface names a new chatbot with crypto.randomUUID(). Anything
       else is refused rather than stored: the id ends up in request paths. */
    const id = body.id === undefined || body.id === null || body.id === '' ? crypto.randomUUID() : String(body.id);
    if (!UUID.test(id)) return res.status(400).json({ error: 'An AI Chatbot\'s id must be a UUID.' });
    const agent = { ...body, id };

    if (await findPhoneNumberConflict(agent?.whatsapp?.phoneNumberId, id)) {
      return res.status(409).json({ error: PHONE_CONFLICT_MESSAGE });
    }

    const [made] = await sql`
      insert into agents (id, data, user_id)
      values (${id}, ${JSON.stringify(agent)}::jsonb, ${user.userId})
      on conflict (id) do nothing
      returning id
    `;
    if (!made) return res.status(409).json({ error: 'An AI Chatbot with this id already exists.' });
    return res.status(201).json(agent);
  }

  res.status(405).end();
}
