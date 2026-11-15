import { sql } from './_db.js';
import { DEFAULT_CLAUDE_MODEL, currentClaudeModel } from './_claudeModels.js';

/**
 * Model settings belong to the organization: one key, provider and model drive
 * every agent, every channel and the assistants of everyone in it
 * (org_settings). The interface language is each person's own (user_settings).
 * An agent's own apiConfig is only a fallback while the organization has none.
 *
 * user_settings still has the old per-account key columns. They are read only
 * as a fallback for an organization that has no org_settings row yet.
 */

export const DEFAULT_MODELS = {
  claude: DEFAULT_CLAUDE_MODEL,
  openai: 'gpt-4o',
  ollama: 'gemma4:12b',
};

/* The interface and the assistants speak English unless the account picks
   Hebrew in Settings. */
export const ASSISTANT_LANGUAGES = ['en', 'he'];

export function emptySettings() {
  return {
    provider: 'claude', api_key: '', model: DEFAULT_MODELS.claude, ollama_host: '',
    assistant_language: 'en',
    /* An account with no settings row has never answered the language
       question, so it is still worth asking. */
    language_chosen: false,
  };
}

export async function getUserSettings(userId) {
  if (!userId) return null;
  const [row] = await sql`
    select coalesce(o.provider, s.provider)       as provider,
           coalesce(o.api_key, s.api_key)         as api_key,
           coalesce(o.model, s.model)             as model,
           coalesce(o.ollama_host, s.ollama_host) as ollama_host,
           coalesce(s.assistant_language, 'en')   as assistant_language,
           coalesce(s.language_chosen, false)     as language_chosen,
           (o.org_id is not null or s.user_id is not null) as found
    from users u
    left join user_settings s on s.user_id = u.id
    left join org_settings  o on o.org_id = u.org_id
    where u.id = ${userId}
  `;
  if (!row || !row.found) return null;
  const { found, ...settings } = row;
  return settings;
}

/**
 * Saves what this person may change. The language is always theirs; the
 * model settings are the organization's, and only `canSetModel` (its admin)
 * writes them — every screen sends the whole object back, so a member saving
 * a language must not be refused over fields they never touched.
 */
export async function saveUserSettings(userId, patch, { canSetModel = true } = {}) {
  const provider = ['claude', 'openai', 'ollama'].includes(patch.provider) ? patch.provider : 'claude';
  const language = ASSISTANT_LANGUAGES.includes(patch.assistantLanguage) ? patch.assistantLanguage : 'en';
  const apiKey = typeof patch.apiKey === 'string' ? patch.apiKey.trim() : '';
  const model = currentModel(provider, (typeof patch.model === 'string' && patch.model.trim()) || DEFAULT_MODELS[provider]);
  const ollamaHost = typeof patch.ollamaHost === 'string' ? patch.ollamaHost.trim().replace(/\/$/, '') : '';
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
  if (canSetModel) {
    await sql`
      insert into org_settings (org_id, provider, api_key, model, ollama_host, updated_at)
      select u.org_id, ${provider}, ${apiKey}, ${model}, ${ollamaHost}, now()
      from users u where u.id = ${userId} and u.org_id is not null
      on conflict (org_id) do update set
        provider    = excluded.provider,
        api_key     = excluded.api_key,
        model       = excluded.model,
        ollama_host = excluded.ollama_host,
        updated_at  = now()
    `;
  }
  return getUserSettings(userId);
}

/** The model to call: a retired Claude id becomes its replacement; other providers' ids are left alone. */
export function currentModel(provider, model) {
  return (provider || 'claude') === 'claude' ? currentClaudeModel(model) : model;
}

/** Is this config able to reach a model at all? */
export function configUsable(cfg) {
  if (!cfg) return false;
  return cfg.provider === 'ollama' ? !!cfg.ollamaHost : !!cfg.apiKey;
}

/**
 * The account's settings win as a whole — never half of one config and half of
 * another, which would pair a Claude key with an OpenAI model. Falls back to
 * the agent's own stored config only while the account has none.
 */
export function resolveApiConfig(settings, agent) {
  const account = settings
    ? {
        provider: settings.provider || 'claude',
        apiKey: settings.api_key || '',
        model: currentModel(settings.provider, settings.model || DEFAULT_MODELS[settings.provider || 'claude']),
        ollamaHost: settings.ollama_host || '',
      }
    : null;
  if (configUsable(account)) return account;

  const own = (agent && agent.apiConfig) || {};
  return {
    provider: own.provider || 'claude',
    apiKey: own.apiKey || '',
    model: currentModel(own.provider, own.model || DEFAULT_MODELS[own.provider || 'claude']),
    ollamaHost: (own.ollamaHost || '').replace(/\/$/, ''),
  };
}

/**
 * The config an agent should actually run with, given who owns it. Used by the
 * public channels, which have no session to read settings from.
 */
export async function resolveAgentApiConfig(agentRow) {
  const settings = agentRow?.user_id ? await getUserSettings(agentRow.user_id) : null;
  return resolveApiConfig(settings, agentRow?.data);
}
