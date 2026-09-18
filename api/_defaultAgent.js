import crypto from 'crypto';
import { sql } from './_db.js';
import { rechunk } from './_knowledge.js';

/**
 * Every new account starts with a copy of each starter agent — the rows in
 * `starter_agents`, which an admin picks by hand in the Admin tab.
 *
 * A starter is a frozen copy, taken the moment it was marked. Editing the agent
 * it was taken from does not change what the next sign-up receives until the
 * snapshot is refreshed on purpose, and a copy that has been handed to somebody
 * else can never become the template: the list holds ids, not names.
 *
 * Nothing that belongs to the template's owner comes along: no LLM API key, no
 * WhatsApp credentials or number (a number may only be claimed by one agent),
 * no Gmail connection, and no tool secret values — their keys are kept so the
 * new owner can see what to fill in.
 */

function blankSecrets(tools) {
  return (tools || []).map(tool => ({
    ...tool,
    envVars: (tool.envVars || []).map(ev => ({ ...ev, value: '' })),
  }));
}

export function buildStarterAgent(template, ownerLabel = '') {
  return {
    ...template,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    // Keep the provider and model so the agent is ready to run, drop the key.
    apiConfig: { ...(template.apiConfig || {}), apiKey: '' },
    tools: blankSecrets(template.tools),
    whatsapp: { enabled: false, phoneNumberId: '', accessToken: '', appSecret: '', verifyToken: '' },
    // Gmail tokens live per agent in their own table and are never copied.
    emailEnabled: !!template.emailEnabled,
    // Crawl the same sites, but start from a clean state rather than mid-run.
    crawlConfig: template.crawlConfig
      ? { ...template.crawlConfig, status: 'idle', lastCrawledAt: null, error: null }
      : undefined,
    _seededFrom: ownerLabel || undefined,
  };
}

/** The starters, in the order they will be handed out. */
export async function listStarters() {
  return sql`
    select s.id, s.source_agent_id, s.name, s.data, s.documents,
           s.position, s.created_at, s.updated_at,
           u.username as created_by_name,
           src.data   as source_data
    from starter_agents s
    left join users u on u.id = s.created_by
    left join agents src on src.id = s.source_agent_id
    order by s.position, s.created_at
  `;
}

/**
 * Freezes an agent as a starter — its definition and its documents, as they are
 * right now. Only an admin's own agent can be frozen: a starter is something
 * you are publishing to every future account, and it must not be possible to
 * publish somebody else's half-finished work by pointing at its id.
 */
export async function snapshotAgent({ agentId, admin, starterId = null }) {
  const [row] = await sql`
    select a.id, a.data, a.user_id, coalesce(u.is_admin, false) as owner_is_admin
    from agents a
    left join users u on u.id = a.user_id
    where a.id = ${agentId}
  `;
  if (!row) return { error: 'No such AI Chatbot.' };
  if (!row.owner_is_admin) return { error: 'Only an admin-owned AI Chatbot can be a starter.' };

  const docs = await sql`
    select skill_id, title, content, normalized, source_type, source_url
    from documents
    where agent_id = ${agentId} and parent_id is null
    limit 200
  `;
  const frozen = JSON.stringify(docs);
  const name = (row.data && row.data.name) || 'starter';

  if (starterId) {
    const [updated] = await sql`
      update starter_agents
         set source_agent_id = ${agentId},
             name = ${name},
             data = ${JSON.stringify(row.data)}::jsonb,
             documents = ${frozen}::jsonb,
             updated_at = now()
       where id = ${starterId}
      returning id
    `;
    if (!updated) return { error: 'That starter is gone.' };
    return { id: updated.id, documents: docs.length };
  }

  const [existing] = await sql`
    select id from starter_agents where source_agent_id = ${agentId} limit 1
  `;
  if (existing) return { error: 'That AI Chatbot is already a starter.' };

  const id = crypto.randomUUID();
  const [{ next }] = await sql`
    select coalesce(max(position), 0) + 1 as next from starter_agents
  `;
  await sql`
    insert into starter_agents (id, source_agent_id, name, data, documents, position, created_by)
    values (${id}, ${agentId}, ${name}, ${JSON.stringify(row.data)}::jsonb, ${frozen}::jsonb,
            ${next}, ${admin.userId})
  `;
  return { id, documents: docs.length };
}

export async function removeStarter(id) {
  await sql`delete from starter_agents where id = ${id}`;
}

async function copyStarter(userId, starter) {
  const agent = buildStarterAgent(starter.data);
  delete agent._seededFrom;

  await sql`
    insert into agents (id, data, user_id)
    values (${agent.id}, ${JSON.stringify(agent)}::jsonb, ${userId})
  `;

  /* The documents were frozen with the starter, so this copies from the
     snapshot rather than from the agent it was taken from — which may since
     have been edited, or deleted altogether. skill_id points at a skill inside
     the agent JSON, which is copied verbatim, so those ids stay valid. Chunks
     are rebuilt for the copy, so the new rows carry their own ids. */
  const docs = Array.isArray(starter.documents) ? starter.documents : [];
  for (const doc of docs) {
    const copyId = crypto.randomUUID();
    await sql`
      insert into documents (id, agent_id, skill_id, title, content, normalized, source_type, source_url)
      values (${copyId}, ${agent.id}, ${doc.skill_id || null}, ${doc.title}, ${doc.content},
              ${doc.normalized === true}, ${doc.source_type || 'manual'}, ${doc.source_url || null})
    `;
    await rechunk(copyId, agent.id, doc.skill_id, doc.title, doc.content);
  }

  console.log(`[seed] user=${userId} got a copy of "${starter.name}" (${docs.length} documents)`);
  return agent.id;
}

/**
 * Copies every starter (and its frozen documents) to a new user. Returns the
 * created agent ids. Never throws, and one starter failing does not stop the
 * others: a sign-up must not fail over this.
 */
export async function seedDefaultAgents(userId) {
  let starters = [];
  try {
    starters = await listStarters();
  } catch (err) {
    console.error('[seed] could not look up the starters:', err.message);
    return [];
  }
  if (starters.length === 0) {
    console.warn('[seed] no starter AI Chatbots are marked; the new account starts empty');
    return [];
  }

  const created = [];
  for (const starter of starters) {
    try {
      created.push(await copyStarter(userId, starter));
    } catch (err) {
      console.error(`[seed] could not copy "${starter.name}":`, err.message);
    }
  }
  return created;
}
