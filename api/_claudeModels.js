/**
 * The Claude models 8legs offers, the one it defaults to, and what a request
 * to each of them needs. agentforge.html keeps a copy of the list and of
 * claudeRequestShape() for the calls the browser makes itself; change both.
 */

export const CLAUDE_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5-5';

/* Ids Anthropic has retired, or is about to, and what replaces each. A request
   to a retired id fails with a 404, so a stale id anywhere (an agent's own
   apiConfig, a branch snapshot, a settings row saved before the migration ran)
   runs on its replacement instead of breaking the chatbot.
   Claude Sonnet 4.5 retires on 2026-11-30. */
const REPLACED = {
  'claude-sonnet-4-5': 'claude-sonnet-5-5',
  'claude-sonnet-4-5-20250929': 'claude-sonnet-5-5',
  'claude-sonnet-4-20250514': 'claude-sonnet-5-5',
  'claude-sonnet-4-0': 'claude-sonnet-5-5',
  'claude-3-7-sonnet-20250219': 'claude-sonnet-5-5',
  'claude-3-7-sonnet-latest': 'claude-sonnet-5-5',
  'claude-3-5-sonnet-20241022': 'claude-sonnet-5-5',
  'claude-3-5-sonnet-20240620': 'claude-sonnet-5-5',
  'claude-3-5-sonnet-latest': 'claude-sonnet-5-5',
  'claude-opus-4-1-20250805': 'claude-opus-5-5',
  'claude-opus-4-1': 'claude-opus-5-5',
  'claude-opus-4-20250514': 'claude-opus-5-5',
  'claude-opus-4-0': 'claude-opus-5-5',
  'claude-3-opus-20240229': 'claude-opus-5-5',
  'claude-3-opus-latest': 'claude-opus-5-5',
  'claude-3-5-haiku-20241022': 'claude-haiku-5-5',
  'claude-3-5-haiku-latest': 'claude-haiku-5-5',
  'claude-3-haiku-20240307': 'claude-haiku-5-5',
};

/** The id to actually call: the replacement for a retired one, otherwise the id as given. */
export function currentClaudeModel(model) {
  const id = typeof model === 'string' ? model.trim() : '';
  return REPLACED[id] || id;
}

/* Claude 5 models think before answering when a request does not say
   otherwise, and that thinking counts toward max_tokens. 8legs was built on
   Claude 4.5, which did not think unless asked, and its token caps were sized
   for the reply alone: at 1,024 tokens a Claude 5 reply can be spent on
   thinking and come back with no text. So on these models a request asks for
   the least thinking (effort "low", which skips it on most simple messages)
   and gets THINKING_ROOM tokens on top of the reply's own cap. */
const THINKS_BY_DEFAULT = /^claude-(opus-5|sonnet-5|haiku-5|fable|mythos)/;
export const CLAUDE_EFFORT = 'low';
const THINKING_ROOM = 4096;

/** `max_tokens`, and `output_config` where the model needs it, for a reply of up to `replyTokens`. */
export function claudeRequestShape(model, replyTokens) {
  if (!THINKS_BY_DEFAULT.test(model || '')) return { max_tokens: replyTokens };
  return { max_tokens: replyTokens + THINKING_ROOM, output_config: { effort: CLAUDE_EFFORT } };
}

/** The reply text of a Messages API response: every text block, never thinking. */
export function claudeText(d) {
  return ((d && d.content) || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
}
