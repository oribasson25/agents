import { sql } from './_db.js';

/**
 * Models come only from the platform. Every organization runs on the
 * platform's OpenRouter key (api/_llm.js), on the model the platform admin
 * chose for it (org_billing.default_model) or, failing that, the platform's
 * default (platform_billing.default_model). Nobody in an organization holds or
 * sets a key.
 *
 * An AI Chatbot, an app or an automation's AI step may name a model of its
 * own. It runs on that model only while the model is in the list the platform
 * admin gave the organization (org_billing.allowed_models); otherwise, and
 * when it names none, on the organization's default. The list is checked
 * here, on every call, so taking a model off it moves everything that used it
 * back to the default without touching the items.
 *
 * What a person still sets is their own interface language (user_settings).
 */

/* The interface and the assistants speak English unless the account picks
   Hebrew in Settings. */
export const ASSISTANT_LANGUAGES = ['en', 'he'];

export function emptySettings() {
  return {
    provider: 'openrouter', api_key: '', model: '', ollama_host: '', ready: false, org_id: null,
    assistant_language: 'en',
    /* An account with no settings row has never answered the language
       question, so it is still worth asking. */
    language_chosen: false,
  };
}

export async function getUserSettings(userId) {
  if (!userId) return null;
  const [row] = await sql`
    select coalesce(s.assistant_language, 'en')   as assistant_language,
           coalesce(s.language_chosen, false)     as language_chosen,
           u.org_id                               as org_id,
           coalesce(nullif(b.default_model, ''), p.default_model, '') as model,
           coalesce(b.allowed_models, '{}')        as allowed_models,
           coalesce(p.openrouter_key <> '', false) as platform_ready
    from users u
    left join user_settings    s on s.user_id = u.id
    left join org_billing      b on b.org_id = u.org_id
    left join platform_billing p on p.id = true
    where u.id = ${userId}
  `;
  if (!row) return null;
  return {
    provider: 'openrouter',
    api_key: '',
    model: row.model || '',
    allowed_models: Array.isArray(row.allowed_models) ? row.allowed_models : [],
    ollama_host: '',
    ready: !!row.platform_ready && !!row.model,
    org_id: row.org_id || null,
    assistant_language: row.assistant_language,
    language_chosen: !!row.language_chosen,
  };
}

/**
 * Saves what this person may change: their interface language. Every screen
 * sends the whole settings object back; anything else in it is ignored.
 */
export async function saveUserSettings(userId, patch) {
  const language = ASSISTANT_LANGUAGES.includes(patch.assistantLanguage) ? patch.assistantLanguage : 'en';
  /* Only ever set, never cleared — `or` in the UPDATE below. Every screen that
     saves settings sends the whole object back, including a `languageChosen`
     it read from here, so a save that is about something else cannot
     accidentally answer a question nobody asked. */
  const chosen = patch.languageChosen === true;

  await sql`
    insert into user_settings (user_id, assistant_language, language_chosen, updated_at)
    values (${userId}, ${language}, ${chosen}, now())
    on conflict (user_id) do update set
      assistant_language = excluded.assistant_language,
      language_chosen    = user_settings.language_chosen or excluded.language_chosen,
      updated_at         = now()
  `;
  return getUserSettings(userId);
}

/** Can this config reach a model: the platform has a key, and a model is chosen. */
export function configUsable(cfg) {
  return !!cfg && cfg.provider === 'openrouter' && !!cfg.ready && !!cfg.model;
}

/** The model an item asked for, if the organization may use it; otherwise its default. */
export function pickModel(settings, wanted) {
  const s = settings || emptySettings();
  const w = typeof wanted === 'string' ? wanted.trim() : '';
  if (w && (w === s.model || (Array.isArray(s.allowed_models) && s.allowed_models.includes(w)))) return w;
  return s.model || '';
}

/**
 * The config every call is made with, from a person's (or an owner's)
 * settings, and the item being run when there is one: `{ model }` is the model
 * it asked for. Nothing else an item carries is read — an agent's stored key
 * from before models moved to the platform never comes back into play.
 */
export function resolveApiConfig(settings, item) {
  const s = settings || emptySettings();
  const model = pickModel(s, item && item.model);
  return { provider: 'openrouter', apiKey: '', model, ollamaHost: '', ready: !!s.ready, orgId: s.org_id || null };
}

/**
 * The config an agent should actually run with, given who owns it. Used by the
 * public channels, which have no session to read settings from. `agent` is the
 * version that answers (a branch may run another model than main).
 */
export async function resolveAgentApiConfig(agentRow, agent = agentRow && agentRow.data) {
  const settings = agentRow?.user_id ? await getUserSettings(agentRow.user_id) : null;
  return resolveApiConfig(settings, { model: agent && agent.model });
}
