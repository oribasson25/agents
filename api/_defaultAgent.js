import crypto from 'crypto';
import { sql } from './_db.js';

/**
 * Every new account starts with a copy of the starter agent — the agent named
 * TEMPLATE_AGENT_NAME owned by an admin. The copy is live: editing that agent
 * changes what the next sign-up receives.
 *
 * Nothing that belongs to the template's owner comes along: no LLM API key, no
 * WhatsApp credentials or number (a number may only be claimed by one agent),
 * no Gmail connection, and no tool secret values — their keys are kept so the
 * new owner can see what to fill in.
 */
export const TEMPLATE_AGENT_NAME = 'weather';

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
 * The template is the newest admin-owned agent with exactly this name. Requiring
 * an admin owner matters: otherwise any user could name an agent "weather" and
 * have their prompt and tools handed to every new account.
 */
export async function findTemplateAgent() {
  const [row] = await sql`
    select a.id, a.data, u.username
    from agents a
    join users u on u.id = a.user_id
    where lower(trim(coalesce(a.data->>'name', ''))) = ${TEMPLATE_AGENT_NAME}
      and u.is_admin
    order by a.updated_at desc
    limit 1
  `;
  return row || null;
}

/**
 * Copies the starter agent (and its knowledge documents) to a new user.
 * Returns the created agent id, or null when there is nothing to copy.
 * Never throws: a missing template must not fail a sign-up.
 */
export async function seedDefaultAgent(userId) {
  try {
    const row = await findTemplateAgent();
    if (!row) {
      console.warn(`[seed] no admin-owned template agent named "${TEMPLATE_AGENT_NAME}" — new user starts empty`);
      return null;
    }

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

    console.log(`[seed] user=${userId} got a copy of "${TEMPLATE_AGENT_NAME}" (${docs.length} documents)`);
    return agent.id;
  } catch (err) {
    console.error('[seed] could not copy the starter agent:', err.message);
    return null;
  }
}
