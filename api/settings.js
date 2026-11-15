import { checkAuth } from './_auth.js';
import { getUserSettings, saveUserSettings, emptySettings, configUsable, resolveApiConfig, currentModel } from './_settings.js';
import { member, isOrgAdmin } from './_access.js';

/**
 * The organization's model settings, and the person's own language.
 *
 * The key is returned to the browser of everyone in the organization, because
 * that is where the test chat and the assistants call the model from. Only the
 * organization's admin may change it; `canEditModel` tells the screen whether
 * to offer that. Keeping the key out of members' browsers altogether means
 * moving those calls to the server first.
 */
export default async function handler(req, res) {
  const user = checkAuth(req, res);
  if (!user) return;

  const me = await member(user);
  const canEditModel = !!me && (isOrgAdmin(me) || me.isPlatformAdmin);

  if (req.method === 'GET') {
    const row = await getUserSettings(user.userId);
    const settings = row || emptySettings();
    return res.json({
      provider: settings.provider,
      apiKey: settings.api_key,
      // A retired id shows as its replacement, so the picker has it and the next save stores it.
      model: currentModel(settings.provider, settings.model),
      ollamaHost: settings.ollama_host,
      assistantLanguage: settings.assistant_language,
      languageChosen: !!settings.language_chosen,
      usable: configUsable(resolveApiConfig(settings, null)),
      canEditModel,
    });
  }

  if (req.method === 'PUT') {
    const saved = await saveUserSettings(user.userId, req.body || {}, { canSetModel: canEditModel });
    return res.json({
      provider: saved.provider,
      apiKey: saved.api_key,
      model: saved.model,
      ollamaHost: saved.ollama_host,
      assistantLanguage: saved.assistant_language,
      languageChosen: !!saved.language_chosen,
      usable: configUsable(resolveApiConfig(saved, null)),
      canEditModel,
    });
  }

  return res.status(405).end();
}
