import { checkAuth } from './_auth.js';
import { getUserSettings, saveUserSettings, emptySettings, configUsable, resolveApiConfig } from './_settings.js';

/**
 * The account's API settings. The key is returned to the browser because that
 * is where model calls are made from in this app — the same trust model the
 * per-agent key had.
 */
export default async function handler(req, res) {
  const user = checkAuth(req, res);
  if (!user) return;

  if (req.method === 'GET') {
    const row = await getUserSettings(user.userId);
    const settings = row || emptySettings();
    return res.json({
      provider: settings.provider,
      apiKey: settings.api_key,
      model: settings.model,
      ollamaHost: settings.ollama_host,
      assistantLanguage: settings.assistant_language,
      usable: configUsable(resolveApiConfig(settings, null)),
    });
  }

  if (req.method === 'PUT') {
    const saved = await saveUserSettings(user.userId, req.body || {});
    return res.json({
      provider: saved.provider,
      apiKey: saved.api_key,
      model: saved.model,
      ollamaHost: saved.ollama_host,
      assistantLanguage: saved.assistant_language,
      usable: configUsable(resolveApiConfig(saved, null)),
    });
  }

  return res.status(405).end();
}
