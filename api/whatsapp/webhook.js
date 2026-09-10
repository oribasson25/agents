import crypto from 'crypto';
import { sql } from '../_db.js';
import { runAgentTurn, dlpMessages } from '../_agentRunner.js';

const GRAPH = 'https://graph.facebook.com/v20.0';

// A message is claimed before work starts and confirmed once the reply is out.
// This window must stay above the function's maxDuration in vercel.json (90s)
// so a claim is never stolen from an invocation that is still working.
const CLAIM_TTL = '150 seconds';

// Signature verification needs the request body as bytes. This is a plain
// Vercel Node function, not Next.js, so there is no `bodyParser: false` switch:
// the runtime may already have drained and parsed the stream before the handler
// runs. Read the stream while it is intact, and fall back to the parsed body.
async function readRawBody(req) {
  if (req.readable && !req.readableEnded) {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    if (chunks.length > 0) return { raw: Buffer.concat(chunks).toString('utf8'), exact: true };
  }

  // `await` covers runtimes whose `req.body` is a lazily-resolved promise.
  const parsed = await req.body;
  if (typeof parsed === 'string') return { raw: parsed, exact: true };
  if (Buffer.isBuffer(parsed)) return { raw: parsed.toString('utf8'), exact: true };
  if (parsed && typeof parsed === 'object') return { raw: JSON.stringify(parsed), exact: false };
  return { raw: '', exact: true };
}

// When the body had to be re-serialized we no longer have Meta's exact bytes.
// Meta sends compact JSON, so a round-trip usually matches, but it escapes
// non-ASCII text as \uXXXX while JSON.stringify emits it literally — try both
// forms rather than rejecting every Hebrew message. Both still require the app
// secret to produce a match, so this does not weaken verification.
function signatureBodies({ raw, exact }) {
  if (exact) return [raw];
  const escaped = raw.replace(/[\u007f-\uffff]/g, c =>
    '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  return escaped === raw ? [raw] : [raw, escaped];
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
  const body = await readRawBody(req);

  let payload;
  try {
    payload = JSON.parse(body.raw);
  } catch (_) {
    // Don't ack: a 200 here would drop the delivery silently and forever.
    console.error(`[whatsapp webhook] unparseable request body (${body.raw.length} bytes)`);
    return res.status(400).end();
  }

  // Meta batches: one delivery can carry several entries/changes, and they may
  // belong to different phone numbers. Collect every message, grouped by the
  // number it was sent to, instead of assuming entry[0].changes[0].
  const groups = collectMessageGroups(payload);
  if (groups.length === 0) return res.status(200).end(); // status/delivery events

  const signature = req.headers['x-hub-signature-256'] || '';
  const bodyVariants = signatureBodies(body);
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const baseUrl = `${proto}://${req.headers.host}`;

  let knownNumber = false;
  let verifiedAny = false;

  for (const group of groups) {
    const candidates = await sql`
      select id, data from agents
      where data->'whatsapp'->>'phoneNumberId' = ${group.phoneNumberId}
        and data->'whatsapp'->>'enabled' = 'true'
      order by updated_at desc
      limit 10
    `;
    if (candidates.length === 0) continue; // unknown number: ack, don't leak info
    knownNumber = true;

    // phoneNumberId is not a secret, so another tenant can configure the same
    // one. Route by proof of the app secret rather than by row recency, so no
    // one can take over — or silently kill — someone else's channel.
    const owner = candidates.find(c =>
      c.data?.whatsapp?.appSecret &&
      verifySignature(bodyVariants, signature, c.data.whatsapp.appSecret)
    );
    if (!owner) {
      console.error(
        '[whatsapp webhook] no agent with a matching appSecret for ' +
        `phoneNumberId=${group.phoneNumberId} (${candidates.length} candidate(s))`
      );
      continue;
    }
    verifiedAny = true;

    for (const msg of group.messages) {
      try {
        await handleMessage(owner.id, owner.data, owner.data.whatsapp || {}, msg, baseUrl);
      } catch (err) {
        console.error(`[whatsapp webhook] agentId=${owner.id} handleMessage error:`, err.message);
      }
    }
  }

  if (knownNumber && !verifiedAny) return res.status(401).send('Invalid signature');
  return res.status(200).end();
}

function collectMessageGroups(payload) {
  const byNumber = new Map();
  for (const entry of payload?.entry || []) {
    for (const change of entry?.changes || []) {
      const value = change?.value;
      const phoneNumberId = value?.metadata?.phone_number_id;
      const messages = value?.messages || [];
      if (!phoneNumberId || messages.length === 0) continue;
      if (!byNumber.has(phoneNumberId)) byNumber.set(phoneNumberId, { phoneNumberId, messages: [] });
      byNumber.get(phoneNumberId).messages.push(...messages);
    }
  }
  return [...byNumber.values()];
}

function verifySignature(bodyVariants, signature, appSecret) {
  const sigBuf = Buffer.from(signature);
  return bodyVariants.some(variant => {
    const expected = Buffer.from(
      'sha256=' + crypto.createHmac('sha256', appSecret).update(variant).digest('hex')
    );
    return sigBuf.length === expected.length && crypto.timingSafeEqual(sigBuf, expected);
  });
}

async function handleMessage(agentId, agent, wa, msg, baseUrl) {
  if (!msg?.id) return;

  // Two-phase idempotency: claim the message now, confirm it only once the
  // reply is out. An invocation that throws releases its claim immediately; one
  // that is killed (maxDuration) leaves a stale claim that a later Meta retry
  // takes over after CLAIM_TTL. Either way the message still gets answered.
  const [claim] = await sql`
    insert into whatsapp_messages (message_id, agent_id)
    values (${msg.id}, ${agentId})
    on conflict (message_id) do update
      set agent_id   = excluded.agent_id,
          created_at = now()
      where whatsapp_messages.processed_at is null
        and whatsapp_messages.created_at < now() - ${CLAIM_TTL}::interval
    returning message_id
  `;
  if (!claim) return; // already answered, or another invocation is still on it

  try {
    await respond(agentId, agent, wa, msg, baseUrl);
  } catch (err) {
    await sql`
      delete from whatsapp_messages
      where message_id = ${msg.id} and processed_at is null
    `;
    throw err;
  }

  await sql`update whatsapp_messages set processed_at = now() where message_id = ${msg.id}`;
}

async function respond(agentId, agent, wa, msg, baseUrl) {
  const from = msg.from;

  if (msg.type === 'reaction') return; // ack silently, nothing to reply to

  if (msg.type !== 'text') {
    await sendText(wa, from, 'Sorry, I can only read text messages right now.');
    return;
  }

  const text = typeof msg.text?.body === 'string' ? msg.text.body : '';
  if (!text.trim()) return; // nothing to answer, and providers reject empty turns

  const sessionId = `wa_${agentId}_${from}`;
  const userMsg = { role: 'user', content: text };

  const [sess] = await sql`select messages from chat_sessions where id = ${sessionId}`;
  const stored = Array.isArray(sess?.messages) ? sess.messages : [];
  const context = normalizeHistory([...stored, userMsg].slice(-20));

  let reply;
  try {
    const result = await runAgentTurn({ agent, agentId, messages: context, baseUrl });
    reply = typeof result.text === 'string' ? result.text.trim() : '';
    // Providers can legitimately return no text (OpenAI `content: null`, Claude
    // stopping on max_tokens). Never send or store an empty turn: the Graph API
    // rejects it, and it poisons the stored history for every later turn.
    if (!reply) {
      console.error(`[whatsapp webhook] agentId=${agentId} empty reply from provider`);
      reply = 'Sorry, I could not generate a reply. Please try again.';
    }
  } catch (err) {
    console.error(`[whatsapp webhook] agentId=${agentId} runAgentTurn error:`, err.message);
    reply = err.code === 'NO_API_KEY'
      ? "This agent isn't fully configured yet. Please contact the owner."
      : 'Sorry, something went wrong. Please try again in a moment.';
  }

  // Persist the DLP-masked user turn, like the widget path does, so masked PII
  // never reaches chat_sessions or the admin viewer. Append in one statement:
  // a read-modify-write would lose an exchange when the same sender has two
  // invocations in flight.
  const turn = [
    ...dlpMessages([userMsg], agent.dlp || {}),
    { role: 'assistant', content: reply },
  ];
  await sql`
    insert into chat_sessions (id, agent_id, source, messages, started_at, updated_at)
    values (${sessionId}, ${agentId}, 'whatsapp', ${JSON.stringify(turn)}, now(), now())
    on conflict (id) do update
      set messages   = chat_sessions.messages || excluded.messages,
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
  if (!text) return;
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
