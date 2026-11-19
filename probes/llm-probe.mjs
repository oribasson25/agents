/**
 * The model gateway (api/_llm.js) and how settings resolve now that models
 * come only from the platform's OpenRouter key. No network, no database:
 * fetch is a recorder and the database is the stub in neon-stub.mjs.
 *
 *   node --import ./probes/stub-db.mjs probes/llm-probe.mjs
 */
import assert from 'node:assert/strict';
import { seal } from '../api/_connections.js';
import { chatUsage, replyText } from '../api/_llm.js';
import { resolveApiConfig, configUsable, getUserSettings } from '../api/_settings.js';

let passed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; } catch (err) { console.error(`✗ ${name}\n  ${err.stack || err.message}`); process.exitCode = 1; }
};

/* ── the database stub ── */
const writes = [];
const errors = [];
let platformRow = { openrouter_key: seal('sk-or-v1-PLATFORM'), default_model: 'anthropic/claude-sonnet-4.5', monthly_ceiling_usd: '50' };
let spent = 0;
let settingsRow = null;
let balanceRow = null;   // org_billing.balance_usd for the org under test; null: no limit
let limits = { item: null, member: null };   // usage_limits for the item and member under test
let used = { item: 0, member: 0 };           // what they were charged this month
globalThis.__db = (text, params) => {
  if (/select openrouter_key, default_model, monthly_ceiling_usd/.test(text)) return platformRow ? [platformRow] : [];
  if (/as balance,\s+\(select monthly_usd from usage_limits/.test(text)) {
    return [{ balance: balanceRow === null ? null : String(balanceRow), item_limit: limits.item, member_limit: limits.member }];
  }
  if (/select balance_usd from org_billing/.test(text)) return balanceRow === null ? [] : [{ balance_usd: String(balanceRow) }];
  if (/sum\(charged_usd\) filter/.test(text)) return [{ item: String(used.item), member: String(used.member) }];
  if (/select coalesce\(sum\(cost_usd\), 0\) as usd from llm_usage/.test(text)) return [{ usd: String(spent) }];
  if (/insert into llm_usage/.test(text)) { writes.push(params); return []; }
  if (/insert into error_log/.test(text)) { errors.push(params); return []; }
  if (/select org_id from users/.test(text)) return [{ org_id: 'org-from-user' }];
  if (/from users u\s+left join user_settings/.test(text)) return settingsRow ? [settingsRow] : [];
  return [];
};

/* Each check gets the gateway fresh, so the minute-long caches start empty. */
let n = 0;
const fresh = () => import(`../api/_llm.js?probe=${++n}`);

/* ── fetch that answers like OpenRouter and remembers what it was sent ── */
function recorder(answer) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : null });
    const { status = 200, json } = typeof answer === 'function' ? answer(url) : answer;
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(json), json: async () => json };
  };
  return { calls, fetchImpl };
}
const chatAnswer = (extra = {}) => ({ json: { id: 'gen-1', model: 'anthropic/claude-sonnet-4.5', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hi' } }],
  usage: { prompt_tokens: 1200, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 1000, cache_write_tokens: 0 }, cost: 0.00213 }, ...extra } });

const CFG = { provider: 'openrouter', apiKey: '', model: 'anthropic/claude-sonnet-4.5', ollamaHost: '', ready: true, orgId: 'org-1' };

await check('a call goes to OpenRouter with the platform key, on the organization\'s model', async () => {
  writes.length = 0;
  const { llmFetch } = await fresh();
  const { calls, fetchImpl } = recorder(chatAnswer());
  const out = await llmFetch({ cfg: CFG, body: { model: 'openai/gpt-5-pro', messages: [{ role: 'user', content: 'x' }] }, meta: { userId: 'u1', source: 'test-chat', itemType: 'agent', itemId: 'a1' }, fetchImpl });
  assert.equal(out.ok, true);
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(calls[0].headers.Authorization, 'Bearer sk-or-v1-PLATFORM');
  assert.equal(calls[0].body.model, 'anthropic/claude-sonnet-4.5', 'a member cannot pick a pricier model by editing the request');
  assert.ok(!JSON.stringify(calls[0].body).includes('sk-or'), 'the key is never in the body');
});

await check('the call is written to llm_usage with the tokens and the cost OpenRouter reported', async () => {
  const row = writes[0];
  assert.ok(row, 'a row was written');
  // The statement first reads the markup and takes the charge from the balance, then writes the row.
  const [markupOrg, chargeCost, balanceOrg, org, user, source, itemType, itemId, model, input, output, read, write, cost] = row;
  assert.deepEqual([markupOrg, chargeCost, balanceOrg], ['org-1', 0.00213, 'org-1'], 'charged to the same organization, on OpenRouter\'s cost');
  assert.deepEqual([org, user, source, itemType, itemId], ['org-1', 'u1', 'test-chat', 'agent', 'a1']);
  assert.equal(model, 'anthropic/claude-sonnet-4.5');
  assert.deepEqual([input, output, read, write], [1200, 80, 1000, 0]);
  assert.equal(cost, 0.00213);
});

await check('a 200 with an error inside is not a success and is not counted', async () => {
  writes.length = 0;
  const { llmFetch } = await fresh();
  const { fetchImpl } = recorder({ json: { error: { message: 'upstream failed', code: 502 } } });
  const out = await llmFetch({ cfg: CFG, body: { messages: [] }, fetchImpl });
  assert.equal(out.ok, false);
  assert.equal(out.status, 502);
  assert.equal(writes.length, 0);
});

await check('OpenRouter refusing the platform\'s account says so in OpenRouter\'s words, and is logged', async () => {
  const { llmFetch } = await fresh();
  for (const [status, json, words] of [[402, { error: { code: 402, message: 'Insufficient credits' } }, 'Insufficient credits'],
                                       [403, { error: { code: 403, message: 'Workspace budget limit exceeded' } }, 'Workspace budget limit exceeded']]) {
    errors.length = 0;
    const { fetchImpl } = recorder({ status, json });
    const out = await llmFetch({ cfg: CFG, body: { messages: [] }, meta: { source: 'assistant' }, fetchImpl });
    assert.equal(out.ok, false);
    assert.equal(out.status, status);
    assert.equal(out.data.error.code, 'PROVIDER_REFUSED');
    assert.ok(out.data.error.message.includes(words), out.data.error.message);
    assert.ok(errors.some((e) => e[1] === 'openrouter' && e[2].includes(words)), 'written to the error log');
  }
});

await check('at the monthly ceiling every call is refused before anything is sent', async () => {
  spent = 50.0001;
  const { llmFetch, pingConfig } = await fresh();
  const { calls, fetchImpl } = recorder(chatAnswer());
  await assert.rejects(() => llmFetch({ cfg: CFG, body: { messages: [] }, fetchImpl }), (e) => e.code === 'BUDGET' && e.status === 402);
  assert.equal(calls.length, 0);
  assert.equal((await pingConfig(CFG, { fetchImpl })).ok, false);
  spent = 49.99;
  const again = await fresh();
  assert.equal((await again.llmFetch({ cfg: CFG, body: { messages: [] }, fetchImpl })).ok, true, 'just under it, calls go through');
  spent = 0;
});

await check('an organization whose balance is used up is refused before anything is sent; with money left it goes through', async () => {
  const { calls, fetchImpl } = recorder(chatAnswer());
  for (const left of [0, -0.02]) {
    balanceRow = left;
    const { llmFetch, pingConfig } = await fresh();
    await assert.rejects(() => llmFetch({ cfg: CFG, body: { messages: [] }, fetchImpl }), (e) => e.code === 'ORG_BALANCE' && e.status === 402);
    assert.equal((await pingConfig(CFG, { fetchImpl })).ok, false);
  }
  assert.equal(calls.length, 0);
  balanceRow = 0.01;
  assert.equal((await (await fresh()).llmFetch({ cfg: CFG, body: { messages: [] }, fetchImpl })).ok, true, 'a cent left is enough to try');
  balanceRow = null;
  assert.equal((await (await fresh()).llmFetch({ cfg: CFG, body: { messages: [] }, fetchImpl })).ok, true, 'no balance: no limit of its own');
});

await check('strangers get the stop message in their language, in the admin\'s words when written', async () => {
  const { stopMessage, isStopped, STOP_MESSAGE_DEFAULT } = await fresh();
  assert.equal(await stopMessage('מתי אתם פתוחים?'), STOP_MESSAGE_DEFAULT.he);
  assert.equal(await stopMessage('when do you open?'), STOP_MESSAGE_DEFAULT.en);
  platformRow = { ...platformRow, stop_message_he: 'נחזור בקרוב', stop_message_en: '' };
  const again = await fresh();
  assert.equal(await again.stopMessage('שלום'), 'נחזור בקרוב');
  assert.equal(await again.stopMessage('hi'), STOP_MESSAGE_DEFAULT.en, 'an empty one falls back to the built-in text');
  platformRow = { ...platformRow, stop_message_he: '', stop_message_en: '' };
  assert.equal(isStopped({ code: 'ORG_BALANCE' }) && isStopped({ code: 'BUDGET' }) && !isStopped({ code: 'NO_MODEL' }), true);
});

await check('an item or a member at its monthly limit is refused; under it, the call goes through', async () => {
  const { calls, fetchImpl } = recorder(chatAnswer());
  const meta = { userId: 'u1', source: 'test-chat', itemType: 'agent', itemId: 'a1' };
  limits = { item: '2', member: null }; used = { item: 2, member: 0 };
  let gw = await fresh();
  await assert.rejects(() => gw.llmFetch({ cfg: CFG, body: { messages: [] }, meta, fetchImpl }), (e) => e.code === 'ITEM_LIMIT' && gw.isStopped(e));
  limits = { item: null, member: '0' }; used = { item: 0, member: 0 };
  gw = await fresh();
  await assert.rejects(() => gw.llmFetch({ cfg: CFG, body: { messages: [] }, meta, fetchImpl }), (e) => e.code === 'MEMBER_LIMIT' && !gw.isStopped(e),
    'a member\'s limit of 0 stops them at once, and is not the stop message for strangers');
  assert.equal(calls.length, 0);
  limits = { item: '2', member: '5' }; used = { item: 1.99, member: 4.99 };
  assert.equal((await (await fresh()).llmFetch({ cfg: CFG, body: { messages: [] }, meta, fetchImpl })).ok, true);
  limits = { item: null, member: null }; used = { item: 0, member: 0 };
});

await check('an item runs on the model it chose only while the organization\'s list has it', async () => {
  const s = { ...settingsRow, model: 'org/default', allowed_models: ['openai/gpt-4o-mini'], platform_ready: true, ready: true, org_id: 'org-9' };
  assert.equal(resolveApiConfig(s, { model: 'openai/gpt-4o-mini' }).model, 'openai/gpt-4o-mini');
  assert.equal(resolveApiConfig(s, { model: 'openai/gpt-5-pro' }).model, 'org/default', 'a model off the list falls back to the default');
  assert.equal(resolveApiConfig(s, { model: '' }).model, 'org/default');
  assert.equal(resolveApiConfig(s, { model: 'org/default' }).model, 'org/default', 'the default is always allowed');
});

await check('a ceiling of 0 means no ceiling', async () => {
  platformRow = { ...platformRow, monthly_ceiling_usd: '0' };
  spent = 999;
  const { llmFetch } = await fresh();
  const { fetchImpl } = recorder(chatAnswer());
  assert.equal((await llmFetch({ cfg: CFG, body: { messages: [] }, fetchImpl })).ok, true);
  platformRow = { ...platformRow, monthly_ceiling_usd: '50' };
  spent = 0;
});

await check('no platform key, or no model → refused before anything is sent', async () => {
  const { fetchImpl, calls } = recorder(chatAnswer());
  platformRow = { ...platformRow, openrouter_key: '' };
  let gw = await fresh();
  await assert.rejects(() => gw.llmFetch({ cfg: CFG, body: { messages: [] }, fetchImpl }), (e) => e.code === 'NO_PLATFORM_KEY');
  platformRow = { ...platformRow, openrouter_key: seal('sk-or-v1-PLATFORM') };
  gw = await fresh();
  await assert.rejects(() => gw.llmFetch({ cfg: { ...CFG, model: '' }, body: { messages: [] }, fetchImpl }), (e) => e.code === 'NO_MODEL');
  assert.equal(calls.length, 0);
});

await check('an SDK-free caller with no org in meta is counted against the owner\'s organization', async () => {
  writes.length = 0;
  const { llmFetch } = await fresh();
  const { fetchImpl } = recorder(chatAnswer());
  await llmFetch({ cfg: { ...CFG, orgId: null }, body: { messages: [] }, meta: { ownerId: 'owner-1', source: 'jarvis', itemType: 'number', itemId: 'n1' }, fetchImpl });
  assert.equal(writes[0][3], 'org-from-user');
  assert.equal(writes[0][4], null, 'the owner paid; nobody in the browser set it off');
});

await check('web search: OpenRouter\'s web plugin on the organization\'s model, with the sources back', async () => {
  const { webSearch } = await fresh();
  const { calls, fetchImpl } = recorder({ json: { model: 'x', choices: [{ finish_reason: 'stop', message: { content: 'Open 9 to 5.',
    annotations: [{ type: 'url_citation', url_citation: { url: 'https://shop.example/hours', title: 'Hours' } }] } }], usage: { cost: 0.006 } } });
  const out = await webSearch({ cfg: CFG, query: 'shop hours', fetchImpl });
  assert.deepEqual(calls[0].body.plugins, [{ id: 'web', max_results: 5 }]);
  assert.equal(calls[0].body.model, CFG.model);
  assert.equal(out.answer, 'Open 9 to 5.');
  assert.deepEqual(out.sources, [{ url: 'https://shop.example/hours', title: 'Hours' }]);
});

await check('the model list carries what the picker shows: prices, date, a plain description, the end date', async () => {
  const { openRouterModels } = await fresh();
  const { fetchImpl } = recorder({ json: { data: [{ id: 'openai/gpt-x', name: 'OpenAI: GPT X', created: 1790000000, context_length: 400000,
    description: 'The **same** model as [GPT Y](https://openrouter.ai/openai/gpt-y),\n served faster.', expiration_date: '2026-12-31',
    pricing: { prompt: '0.00000125', completion: '0.00001' }, supported_parameters: ['tools'], architecture: { input_modalities: ['text', 'image'] } },
    { id: 'openrouter/auto', name: 'Auto Router', pricing: { prompt: '-1', completion: '-1' } }] } });
  const list = await openRouterModels({ fetchImpl });
  const m = list.find((x) => x.id === 'openai/gpt-x');
  const auto = list.find((x) => x.id === 'openrouter/auto');
  assert.equal(m.about, 'The same model as GPT Y, served faster.');
  assert.deepEqual([m.created, m.expires, m.inputPerM, m.outputPerM, m.tools, m.images], [1790000000, '2026-12-31', 1.25, 10, true, true]);
  assert.deepEqual([auto.inputPerM, auto.outputPerM, auto.expires], [null, null, null], 'a router priced per request has no per-token price');
});

await check('chatUsage and replyText read OpenRouter\'s answer, and tolerate junk', async () => {
  assert.deepEqual(chatUsage({ prompt_tokens: 5, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 1 }, cost: 0.5 }),
    { input: 5, output: 2, read: 3, write: 1, cost: 0.5 });
  assert.deepEqual(chatUsage({ prompt_tokens: -4, completion_tokens: 'x' }), { input: 0, output: 0, read: 0, write: 0, cost: null });
  assert.equal(replyText({ choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }] }), 'ab');
  assert.equal(replyText({}), '');
});

/* ── settings ── */

await check('settings: everyone is on OpenRouter; the organization\'s own model wins over the default', async () => {
  settingsRow = { assistant_language: 'he', language_chosen: true, org_id: 'org-9', model: 'openai/gpt-4o-mini', platform_ready: true };
  const s = await getUserSettings('u9');
  assert.equal(s.provider, 'openrouter');
  assert.equal(s.api_key, '');
  assert.equal(s.model, 'openai/gpt-4o-mini');
  const cfg = resolveApiConfig(s, { apiConfig: { provider: 'claude', apiKey: 'sk-ant-AGENT' } });
  assert.deepEqual(cfg, { provider: 'openrouter', apiKey: '', model: 'openai/gpt-4o-mini', ollamaHost: '', ready: true, orgId: 'org-9' },
    'an agent\'s own stored key never comes back into play');
  assert.equal(configUsable(cfg), true);
});

await check('settings: no model chosen, or no platform key → not usable', async () => {
  settingsRow = { ...settingsRow, model: '' };
  assert.equal(configUsable(resolveApiConfig(await getUserSettings('u9'))), false);
  settingsRow = { ...settingsRow, model: 'x/y', platform_ready: false };
  assert.equal(configUsable(resolveApiConfig(await getUserSettings('u9'))), false);
});

await check('settings: someone with no settings at all still resolves, unusable', async () => {
  const cfg = resolveApiConfig(null);
  assert.equal(cfg.provider, 'openrouter');
  assert.equal(configUsable(cfg), false);
});

await check('pingConfig asks OpenRouter about the platform key', async () => {
  const { pingConfig } = await fresh();
  const { calls, fetchImpl } = recorder({ json: { data: { label: 'x', limit: 50, limit_remaining: 49, usage_monthly: 1 } } });
  const r = await pingConfig(CFG, { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/key');
  assert.equal(calls[0].headers.Authorization, 'Bearer sk-or-v1-PLATFORM');
});

console.log(`${process.exitCode ? '✗' : '✓'} llm-probe: ${passed} checks passed`);
