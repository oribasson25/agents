import crypto from 'crypto';
import { sql } from './_db.js';

/**
 * Every new account starts with a copy of each starter agent — the agents named
 * in TEMPLATE_AGENT_NAMES owned by an admin. The copies are live: editing one
 * of those agents changes what the next sign-up receives.
 *
 * Nothing that belongs to the template's owner comes along: no LLM API key, no
 * WhatsApp credentials or number (a number may only be claimed by one agent),
 * no Gmail connection, and no tool secret values — their keys are kept so the
 * new owner can see what to fill in.
 */
export const TEMPLATE_AGENT_NAMES = ['weather', 'bobi'];

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

/**
 * One template per name: the newest admin-owned agent called exactly that.
 * Requiring an admin owner matters — otherwise any user could name an agent
 * "weather" and have their prompt and tools handed to every new account.
 */
export async function findTemplateAgents() {
  return sql`
    select distinct on (lower(trim(coalesce(a.data->>'name', ''))))
           lower(trim(coalesce(a.data->>'name', ''))) as template_name,
           a.id, a.data, u.username
    from agents a
    join users u on u.id = a.user_id
    where lower(trim(coalesce(a.data->>'name', ''))) = any(${TEMPLATE_AGENT_NAMES})
      and u.is_admin
    order by lower(trim(coalesce(a.data->>'name', ''))), a.updated_at desc
  `;
}

async function copyTemplate(userId, row) {
  const agent = buildStarterAgent(row.data);
  delete agent._seededFrom;

  await sql`
    insert into agents (id, data, user_id)
    values (${agent.id}, ${JSON.stringify(agent)}::jsonb, ${userId})
  `;

  // Knowledge documents are separate rows. skill_id points at a skill inside
  // the agent JSON, which is copied verbatim, so those ids stay valid.
  const docs = await sql`
    select skill_id, title, content, source_type, source_url
    from documents
    where agent_id = ${row.id}
    limit 200
  `;
  for (const doc of docs) {
    await sql`
      insert into documents (id, agent_id, skill_id, title, content, source_type, source_url)
      values (${crypto.randomUUID()}, ${agent.id}, ${doc.skill_id}, ${doc.title}, ${doc.content},
              ${doc.source_type || 'manual'}, ${doc.source_url})
    `;
  }

  console.log(`[seed] user=${userId} got a copy of "${row.template_name}" (${docs.length} documents)`);
  return agent.id;
}

/**
 * Copies every starter agent (and its knowledge documents) to a new user.
 * Returns the created agent ids. Never throws, and one template failing does
 * not stop the others: a sign-up must not fail over this.
 */
export async function seedDefaultAgents(userId) {
  let templates = [];
  try {
    templates = await findTemplateAgents();
  } catch (err) {
    console.error('[seed] could not look up the starter agents:', err.message);
    return [];
  }

  const found = templates.map(t => t.template_name);
  const missing = TEMPLATE_AGENT_NAMES.filter(n => !found.includes(n));
  if (missing.length > 0) {
    console.warn(`[seed] no admin-owned template agent named ${missing.map(n => `"${n}"`).join(', ')}`);
  }

  const created = [];
  for (const row of templates) {
    try {
      created.push(await copyTemplate(userId, row));
    } catch (err) {
      console.error(`[seed] could not copy "${row.template_name}":`, err.message);
    }
  }
  return created;
}
