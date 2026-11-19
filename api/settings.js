import { checkAuth } from './_auth.js';
import { getUserSettings, saveUserSettings, emptySettings, configUsable, resolveApiConfig } from './_settings.js';

/**
 * A person's settings: their interface language, and which model their
 * organization runs on.
 *
 * Models come only from the platform (OpenRouter, through api/_llm.js), so
 * there is no key here to read or to set: `model` is what the platform admin
 * chose for the organization, and `usable` says whether the platform has
 * finished setting it up. A save changes the language and nothing else.
 */
export default async function handler(req, res) {
  const user = checkAuth(req, res);
  if (!user) return;

  if (req.method === 'GET') {
    const row = await getUserSettings(user.userId);
    return res.json(view(row || emptySettings()));
  }

  if (req.method === 'PUT') {
    const saved = await saveUserSettings(user.userId, req.body || {});
    return res.json(view(saved || emptySettings()));
  }

  return res.status(405).end();
}

function view(settings) {
  return {
    provider: 'openrouter',
    model: settings.model,
    assistantLanguage: settings.assistant_language,
    languageChosen: !!settings.language_chosen,
    usable: configUsable(resolveApiConfig(settings)),
    managed: true,
    canEditModel: false,
  };
}
