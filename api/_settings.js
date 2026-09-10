import { sql } from './_db.js';

/**
 * Account-level API settings. One key, provider and model drive everything the
 * account owns — every agent, every channel, and the assistants. An agent's own
 * apiConfig is only a fallback for accounts whose settings are still empty.
 */

export const DEFAULT_MODELS = {
  claude: 'claude-sonnet-4-5',
  openai: 'gpt-4o',
  ollama: 'gemma4:12b',
};

export const ASSISTANT_LANGUAGES = ['he', 'en'];

export function emptySettings() {
  return { provider: 'claude', api_key: '', model: DEFAULT_MODELS.claude, ollama_host: '', assistant_language: 'he' };
}

export async function getUserSettings(userId) {
  if (!userId) return null;
  const [row] = await sql`
    select provider, api_key, model, ollama_host, assistant_language
    from user_settings where user_id = ${userId}
  `;
  return row || null;
}

export async function saveUserSettings(userId, patch) {
  const provider = ['claude', 'openai', 'ollama'].includes(patch.provider) ? patch.provider : 'claude';
  const language = ASSISTANT_LANGUAGES.includes(patch.assistantLanguage) ? patch.assistantLanguage : 'he';
  const apiKey = typeof patch.apiKey === 'string' ? patch.apiKey.trim() : '';
  const model = (typeof patch.model === 'string' && patch.model.trim()) || DEFAULT_MODELS[provider];
  const ollamaHost = typeof patch.ollamaHost === 'string' ? patch.ollamaHost.trim().replace(/\/$/, '') : '';

  const [row] = await sql`
    insert into user_settings (user_id, provider, api_key, model, ollama_host, assistant_language, updated_at)
    values (${userId}, ${provider}, ${apiKey}, ${model}, ${ollamaHost}, ${language}, now())
    on conflict (user_id) do update set
      provider           = excluded.provider,
      api_key            = excluded.api_key,
      model              = excluded.model,
      ollama_host        = excluded.ollama_host,
      assistant_language = excluded.assistant_language,
      updated_at         = now()
    returning provider, api_key, model, ollama_host, assistant_language
  `;
  return row;
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
        model: settings.model || DEFAULT_MODELS[settings.provider || 'claude'],
        ollamaHost: settings.ollama_host || '',
      }
    : null;
  if (configUsable(account)) return account;

  const own = (agent && agent.apiConfig) || {};
  return {
    provider: own.provider || 'claude',
    apiKey: own.apiKey || '',
    model: own.model || DEFAULT_MODELS[own.provider || 'claude'],
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
