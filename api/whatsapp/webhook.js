import crypto from 'crypto';
import { sql } from '../_db.js';
import { runAgentTurn } from '../_agentRunner.js';

// Signature verification needs the byte-exact raw request body, so the
// default JSON body parser must be disabled here.
export const config = {
  api: {
    bodyParser: false,
  },
};

const GRAPH = 'https://graph.facebook.com/v20.0';

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req, res) {
  if (req.method === 'GET') return handleVerify(req, res);
  if (req.method !== 'POST') return res.status(405).end();
  return handleInbound(req, res);
}

async function handleVerify(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode !== 'subscribe' || !token) return res.status(400).send('Bad request');

  const [hit] = await sql`
    select 1 from agents
    where data->'whatsapp'->>'verifyToken' = ${token}
      and coalesce(data->'whatsapp'->>'verifyToken', '') <> ''
    limit 1
  `;
  if (!hit) return res.status(403).send('Verification failed');
  return res.status(200).send(challenge);
}

async function handleInbound(req, res) {
  const rawBody = await readRawBody(req);

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (_) {
    return res.status(200).end();
  }

  const value = payload?.entry?.[0]?.changes?.[0]?.value;
  if (!value?.messages?.length) return res.status(200).end(); // status/delivery events

  const phoneNumberId = value.metadata?.phone_number_id;
  if (!phoneNumberId) return res.status(200).end();

  const [row] = await sql`
    select id, data from agents
    where data->'whatsapp'->>'phoneNumberId' = ${phoneNumberId}
      and data->'whatsapp'->>'enabled' = 'true'
    order by updated_at desc
    limit 1
  `;
  if (!row) return res.status(200).end(); // unknown number: ack, don't leak info

  const agent = row.data;
  const wa = agent.whatsapp || {};

  if (!wa.appSecret) {
    console.error(`[whatsapp webhook] agentId=${row.id} missing appSecret, refusing to process`);
    return res.status(200).end();
  }

  const sigHeader = req.headers['x-hub-signature-256'] || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', wa.appSecret).update(rawBody).digest('hex');
  const sigBuf = Buffer.from(sigHeader);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return res.status(401).send('Invalid signature');
  }

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const baseUrl = `${proto}://${req.headers.host}`;

  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      for (const msg of change.value?.messages || []) {
        try {
          await handleMessage(row.id, agent, wa, msg, baseUrl);
        } catch (err) {
          console.error(`[whatsapp webhook] agentId=${row.id} handleMessage error:`, err.message);
        }
      }
    }
  }

  return res.status(200).end();
}

async function handleMessage(agentId, agent, wa, msg, baseUrl) {
  const [inserted] = await sql`
    insert into whatsapp_messages (message_id, agent_id)
    values (${msg.id}, ${agentId})
    on conflict do nothing
    returning message_id
  `;
  if (!inserted) return; // duplicate delivery (Meta retry) — already handled

  const from = msg.from;

  if (msg.type === 'reaction') return; // ack silently, nothing to reply to

  if (msg.type !== 'text') {
    await sendText(wa, from, 'Sorry, I can only read text messages right now.');
    return;
  }

  const sessionId = `wa_${agentId}_${from}`;
  const [sess] = await sql`select messages from chat_sessions where id = ${sessionId}`;
  const history = sess?.messages || [];
  history.push({ role: 'user', content: msg.text.body });

  const context = normalizeHistory(history.slice(-20));

  let reply;
  try {
    const result = await runAgentTurn({ agent, agentId, messages: context, baseUrl });
    reply = result.text;
  } catch (err) {
    console.error(`[whatsapp webhook] agentId=${agentId} runAgentTurn error:`, err.message);
    reply = err.code === 'NO_API_KEY'
      ? "This agent isn't fully configured yet. Please contact the owner."
      : 'Sorry, something went wrong. Please try again in a moment.';
  }

  history.push({ role: 'assistant', content: reply });

  await sql`
    insert into chat_sessions (id, agent_id, source, messages, started_at, updated_at)
    values (${sessionId}, ${agentId}, 'whatsapp', ${JSON.stringify(history)}, now(), now())
    on conflict (id) do update
      set messages   = excluded.messages,
          updated_at = now()
  `;

  await sendText(wa, from, reply);
}

// Claude requires strict user/assistant role alternation. WhatsApp users can
// send several messages before a reply goes out, which would otherwise
// produce consecutive 'user' turns — merge them into one.
function normalizeHistory(messages) {
  const start = messages.findIndex(m => m.role === 'user');
  if (start === -1) return [];

  const merged = [];
  for (const m of messages.slice(start)) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) {
      last.content = `${last.content}\n${m.content}`;
    } else {
      merged.push({ role: m.role, content: m.content });
    }
  }
  return merged;
}

async function sendText(wa, to, text) {
  for (const chunk of splitMessage(text)) {
    try {
      const resp = await fetch(`${GRAPH}/${wa.phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${wa.accessToken}`,
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body: chunk },
        }),
      });
      if (!resp.ok) {
        const errBody = await resp.json().catch(() => ({}));
        if (errBody?.error?.code === 190) {
          console.error(`[whatsapp send] access token expired/invalid for phoneNumberId=${wa.phoneNumberId}`);
        } else {
          console.error('[whatsapp send] Graph API error:', JSON.stringify(errBody));
        }
      }
    } catch (err) {
      console.error('[whatsapp send] request failed:', err.message);
    }
  }
}

function splitMessage(text, maxLen = 4000) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > maxLen) {
    let splitAt = rest.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen * 0.5) splitAt = rest.lastIndexOf(' ', maxLen);
    if (splitAt < maxLen * 0.5) splitAt = maxLen;
    chunks.push(rest.slice(0, splitAt).trim());
    rest = rest.slice(splitAt).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
