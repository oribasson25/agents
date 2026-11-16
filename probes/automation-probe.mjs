/**
 * Automations: the rules a definition must keep, how references are filled,
 * when a schedule fires, and how the engine walks a graph.
 *
 *   node probes/automation-probe.mjs
 *
 * No database and no network: the engine is handed a fake fetch and a clock.
 */
import assert from 'node:assert/strict';
import {
  checkAutomation, resolve, resolveJsonText, compare, loopBodies, ownerOf, portsOf, blankAutomation,
} from '../api/_automationSpec.js';
import { advance, freshState, maskSecrets, clip } from '../api/_automationEngine.js';
import { buildRequest, fillConfig, assertPublicUrl } from '../api/_automationSteps.js';
import { nextRun, nextCron, parseCron } from '../api/_schedule.js';

let passed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; }
  catch (err) { console.error(`✗ ${name}\n  ${err.message}`); process.exitCode = 1; }
};

const step = (id, type, config = {}, more = {}) => ({ id, type, name: '', config, ...more });
const edge = (from, to, port = 'out') => ({ from, to, port });
const auto = (steps, edges, trigger = { type: 'manual', config: {} }) => ({ name: 'T', trigger, steps, edges });

/** Runs a definition to the end with a fake world; returns the result and the log. */
async function run(def, input = {}, world = {}) {
  const { automation, errors } = checkAutomation(def);
  assert.deepEqual(errors, [], `definition should be valid: ${errors.join('; ')}`);
  const log = [];
  let clock = world.start || 1_000_000;
  const state = world.state || freshState();
  const ctx = {
    secrets: world.secrets || {},
    baseUrl: 'https://platform.test',
    allowPrivate: true,
    fetch: world.fetch || (async () => { throw new Error('no network in this probe'); }),
    recordStep: async (r) => { log.push(r); },
    saveState: async () => {},
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    deadline: world.deadline,
    callAutomation: world.callAutomation,
    ...(world.ctx || {}),
  };
  const result = await advance({ definition: automation, input, state, ctx });
  return { result, log, state, tick: (ms) => { clock += ms; }, ctx, automation };
}

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/* ─────────────────── references ─────────────────── */

await check('a lone reference keeps its type', () => {
  const scope = { trigger: { n: 5, list: [1, 2], who: { name: 'Dana' } } };
  assert.equal(resolve('{{trigger.n}}', scope), 5);
  assert.deepEqual(resolve('{{ trigger.list }}', scope), [1, 2]);
  assert.equal(resolve('Hi {{trigger.who.name}}, {{trigger.n}} new', scope), 'Hi Dana, 5 new');
  assert.equal(resolve('{{trigger.list[1]}}', scope), 2);
  assert.equal(resolve('{{trigger.missing.deep}}', scope), null);
  assert.equal(resolve('a{{trigger.missing}}b', scope), 'ab');
  assert.deepEqual(resolve({ a: ['{{trigger.n}}'] }, scope), { a: [5] });
});

await check('a JSON body survives a value with quotes in it', () => {
  const scope = { trigger: { name: 'He said "hi"', count: 3 } };
  assert.deepEqual(resolveJsonText('{"name": "{{trigger.name}}"}', scope), { name: 'He said "hi"' });
  assert.deepEqual(resolveJsonText('{"count": {{trigger.count}}, "n": {{trigger.name}}}', scope), { count: 3, n: 'He said "hi"' });
  assert.throws(() => resolveJsonText('{"a": }', scope), /not valid JSON/);
  assert.equal(resolveJsonText('  ', scope), undefined);
});

await check('comparisons treat numbers as numbers', () => {
  assert.equal(compare('10', 'gt', 9), true);
  assert.equal(compare('10', 'gt', '9'), true);
  assert.equal(compare('abc', 'contains', 'b'), true);
  assert.equal(compare(['a', 'b'], 'contains', 'b'), true);
  assert.equal(compare('', 'empty'), true);
  assert.equal(compare([], 'empty'), true);
  assert.equal(compare(0, 'empty'), false);
  assert.equal(compare('80', 'eq', 80), true);
});

/* ─────────────────── what makes a definition valid ─────────────────── */

await check('a blank automation is valid', () => {
  assert.deepEqual(checkAutomation(blankAutomation('New')).errors, []);
});

await check('bad ids, duplicate ids and unknown types are refused', () => {
  const { errors } = checkAutomation(auto([
    step('Bad-Id', 'set'), step('a', 'set'), step('a', 'set'), step('b', 'nope'), step('secrets', 'set'),
  ], []));
  assert.equal(errors.length, 4);
});

await check('a circle is refused', () => {
  const { errors } = checkAutomation(auto(
    [step('a', 'set'), step('b', 'set')],
    [edge('trigger', 'a'), edge('a', 'b'), edge('b', 'a')]));
  assert.ok(errors.some(e => e.includes('circle')));
});

await check('edges to nowhere and from ports that do not exist are dropped', () => {
  const { automation } = checkAutomation(auto(
    [step('a', 'if', { conditions: [{ left: 1, op: 'eq', right: 1 }] }), step('b', 'set')],
    [edge('trigger', 'a'), edge('a', 'b', 'out'), edge('a', 'b', 'yes'), edge('a', 'gone', 'yes'), edge('a', 'b', 'yes')]));
  assert.deepEqual(automation.edges, [edge('trigger', 'a'), edge('a', 'b', 'yes')]);
});

await check('only a loop\'s own steps may lead into its body', () => {
  const def = auto(
    [step('l', 'loop', { items: '{{trigger.items}}' }), step('in', 'set'), step('after', 'set'), step('x', 'set')],
    [edge('trigger', 'l'), edge('l', 'in', 'each'), edge('l', 'after', 'done'), edge('trigger', 'x'), edge('x', 'in')]);
  assert.ok(checkAutomation(def).errors.some(e => e.includes('inside the loop')));
  assert.deepEqual([...loopBodies(def).l], ['in']);
  assert.equal(ownerOf(def).in, 'l');
  assert.equal(ownerOf(def).after, null);
});

await check('a switch\'s ports are its cases', () => {
  assert.deepEqual(portsOf(step('s', 'switch', { cases: [{ id: 'hot' }, { id: 'cold' }] })), ['hot', 'cold', 'default']);
});

await check('warnings: a step nothing leads to, a reference to nothing', () => {
  const { warnings, errors } = checkAutomation(auto([step('a', 'set', { fields: [{ key: 'x', value: '{{ghost.y}}' }] })], []));
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 2);
});

/* ─────────────────── schedules ─────────────────── */

await check('every N counts in whole minutes', () => {
  const after = new Date('2026-11-16T10:00:30Z');
  assert.equal(nextRun({ mode: 'every', every: 15, unit: 'minutes' }, after).toISOString(), '2026-11-16T10:15:00.000Z');
  assert.equal(nextRun({ mode: 'every', every: 2, unit: 'hours' }, after).toISOString(), '2026-11-16T12:00:00.000Z');
});

await check('a daily time is in Israel time, summer and winter', () => {
  /* Winter: Israel is UTC+2, so 09:00 is 07:00Z. */
  assert.equal(nextRun({ mode: 'daily', time: '09:00', days: [0, 1, 2, 3, 4, 5, 6] }, new Date('2026-11-16T10:00:00Z')).toISOString(),
               '2026-11-17T07:00:00.000Z');
  /* Summer: UTC+3, so 09:00 is 06:00Z. */
  assert.equal(nextRun({ mode: 'daily', time: '09:00', days: [0, 1, 2, 3, 4, 5, 6] }, new Date('2026-07-01T10:00:00Z')).toISOString(),
               '2026-07-02T06:00:00.000Z');
  /* Sundays only: 16 Nov 2026 is a Monday, the next Sunday is the 22nd. */
  assert.equal(nextRun({ mode: 'daily', time: '08:30', days: [0] }, new Date('2026-11-16T10:00:00Z')).toISOString(),
               '2026-11-22T06:30:00.000Z');
});

await check('cron: steps, lists and ranges', () => {
  assert.equal(nextCron('*/5 * * * *', new Date('2026-11-16T10:02:00Z')).toISOString(), '2026-11-16T10:05:00.000Z');
  assert.equal(nextCron('0 0 1 1 *', new Date('2026-11-16T10:02:00Z')).toISOString(), '2026-12-31T22:00:00.000Z');
  assert.deepEqual([...parseCron('0 9-11,14 * * 1-5').hours], [9, 10, 11, 14]);
  assert.throws(() => parseCron('* * *'), /five parts/);
  assert.throws(() => parseCron('61 * * * *'), /not a valid/);
});

/* ─────────────────── the walk ─────────────────── */

await check('steps run in order and read each other', async () => {
  const { result, log } = await run(auto(
    [step('a', 'set', { fields: [{ key: 'n', value: '{{trigger.n}}' }, { key: 'who', value: 'Hi {{trigger.name}}' }] }),
     step('out', 'output', { fields: [{ key: 'echo', value: '{{a.n}}' }, { key: 'text', value: '{{a.who}}' }] })],
    [edge('trigger', 'a'), edge('a', 'out')]), { n: 7, name: 'Dana' });
  assert.equal(result.status, 'done');
  assert.deepEqual(result.output, { echo: 7, text: 'Hi Dana' });
  assert.deepEqual(log.map(l => l.stepId), ['a', 'out']);
});

await check('an If runs one side and skips the other all the way down', async () => {
  const def = auto(
    [step('check', 'if', { conditions: [{ left: '{{trigger.score}}', op: 'gte', right: 80 }] }),
     step('hot', 'set', { fields: [{ key: 'v', value: 'hot' }] }),
     step('cold', 'set', { fields: [{ key: 'v', value: 'cold' }] }),
     step('cold2', 'set', { fields: [{ key: 'v', value: 'cold2' }] }),
     step('join', 'set', { fields: [{ key: 'hot', value: '{{hot.v}}' }, { key: 'cold', value: '{{cold.v}}' }] })],
    [edge('trigger', 'check'), edge('check', 'hot', 'yes'), edge('check', 'cold', 'no'), edge('cold', 'cold2'),
     edge('hot', 'join'), edge('cold2', 'join')]);
  const hot = await run(def, { score: 90 });
  assert.deepEqual(hot.log.map(l => l.stepId), ['check', 'hot', 'join']);
  assert.deepEqual(hot.state.outputs.join, { hot: 'hot', cold: null });
  assert.equal(hot.state.nodes.cold2, 'dead');
  const cold = await run(def, { score: 10 });
  assert.deepEqual(cold.log.map(l => l.stepId), ['check', 'cold', 'cold2', 'join']);
});

await check('a step two branches lead into runs once, after both', async () => {
  const { log } = await run(auto(
    [step('join', 'set', { fields: [{ key: 'a', value: '{{a.v}}' }, { key: 'b', value: '{{b.v}}' }] }),
     step('a', 'set', { fields: [{ key: 'v', value: 1 }] }),
     step('b', 'set', { fields: [{ key: 'v', value: 2 }] })],
    [edge('trigger', 'a'), edge('trigger', 'b'), edge('a', 'join'), edge('b', 'join')]));
  assert.deepEqual(log.map(l => l.stepId), ['a', 'b', 'join']);
  assert.deepEqual(log[2].output, { a: 1, b: 2 });
});

await check('a switch goes the way of the matching case', async () => {
  const def = auto(
    [step('s', 'switch', { value: '{{trigger.kind}}', cases: [{ id: 'vip', value: 'vip' }, { id: 'new', value: 'new' }] }),
     step('v', 'set'), step('n', 'set'), step('d', 'set')],
    [edge('trigger', 's'), edge('s', 'v', 'vip'), edge('s', 'n', 'new'), edge('s', 'd', 'default')]);
  assert.deepEqual((await run(def, { kind: 'new' })).log.map(l => l.stepId), ['s', 'n']);
  assert.deepEqual((await run(def, { kind: 'other' })).log.map(l => l.stepId), ['s', 'd']);
});

await check('a loop runs its body per item, then goes on', async () => {
  const { result, log, state } = await run(auto(
    [step('each', 'loop', { items: '{{trigger.people}}' }),
     step('greet', 'set', { fields: [{ key: 'text', value: '{{index}}: hi {{item.name}} from {{trigger.from}}' }] }),
     step('out', 'output', { fields: [{ key: 'count', value: '{{each.count}}' }, { key: 'all', value: '{{each.results}}' }] })],
    [edge('trigger', 'each'), edge('each', 'greet', 'each'), edge('each', 'out', 'done')]),
    { from: 'Ori', people: [{ name: 'A' }, { name: 'B' }] });
  assert.equal(result.status, 'done');
  assert.deepEqual(result.output, { count: 2, all: [{ text: '0: hi A from Ori' }, { text: '1: hi B from Ori' }] });
  assert.deepEqual(log.map(l => [l.stepId, l.iteration]), [['greet', 0], ['greet', 1], ['each', null], ['out', null]]);
  assert.equal(state.outputs.greet, undefined, 'a body step\'s result does not leak out of its pass');
});

await check('a loop inside a loop', async () => {
  const { result } = await run(auto(
    [step('rows', 'loop', { items: '{{trigger.rows}}' }),
     step('cells', 'loop', { items: '{{item}}' }),
     step('cell', 'set', { fields: [{ key: 'v', value: '{{item}}' }] }),
     step('out', 'output', { fields: [{ key: 'r', value: '{{rows.results}}' }] })],
    [edge('trigger', 'rows'), edge('rows', 'cells', 'each'), edge('cells', 'cell', 'each'), edge('rows', 'out', 'done')]),
    { rows: [[1, 2], [3]] });
  assert.deepEqual(result.output.r.map(x => x.results), [[{ v: 1 }, { v: 2 }], [{ v: 3 }]]);
});

await check('a loop refuses what is not a list, and too long a list', async () => {
  const def = auto([step('l', 'loop', { items: '{{trigger.x}}' })], [edge('trigger', 'l')]);
  assert.match((await run(def, { x: 'nope' })).result.error, /not a list/);
  assert.match((await run(def, { x: Array(501).fill(1) })).result.error, /at most 500/);
  assert.equal((await run(def, { x: '[1,2]' })).result.status, 'done', 'a list written as text is still a list');
});

/* ─────────────────── failing ─────────────────── */

await check('a failed step stops the run and says which', async () => {
  const { result, log } = await run(auto(
    [step('call', 'http', { url: 'https://api.test/x' }, { name: 'Get lead' }), step('after', 'set')],
    [edge('trigger', 'call'), edge('call', 'after')]),
    {}, { fetch: async () => jsonResponse({ message: 'nope' }, 500) });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /^Get lead: The server answered 500/);
  assert.equal(result.failedStep, 'call');
  assert.equal(log.length, 1);
  assert.equal(log[0].output.status, 500, 'the failed answer is kept for the log');
});

await check('"carry on after an error" hands the error to the next step', async () => {
  const { result, log } = await run(auto(
    [step('call', 'http', { url: 'https://api.test/x' }, { onError: 'continue' }),
     step('out', 'output', { fields: [{ key: 'e', value: '{{call.error}}' }, { key: 's', value: '{{call.status}}' }] })],
    [edge('trigger', 'call'), edge('call', 'out')]),
    {}, { fetch: async () => jsonResponse({}, 404) });
  assert.equal(result.status, 'done');
  assert.match(result.output.e, /answered 404/);
  assert.equal(result.output.s, 404);
  assert.equal(log[0].status, 'failed');
});

await check('retries try again before giving up', async () => {
  let calls = 0;
  const { result } = await run(auto(
    [step('call', 'http', { url: 'https://api.test/x' }, { retries: 2 })], [edge('trigger', 'call')]),
    {}, { fetch: async () => (++calls < 3 ? jsonResponse({}, 503) : jsonResponse({ ok: 1 })) });
  assert.equal(result.status, 'done');
  assert.equal(calls, 3);
});

/* ─────────────────── HTTP ─────────────────── */

await check('an HTTP step builds the request its settings describe', async () => {
  let sent;
  const { state } = await run(auto(
    [step('call', 'http', {
      method: 'post', url: 'api.test/leads/{{trigger.id}}',
      params: [{ key: 'q', value: '{{trigger.name}}' }, { key: 'off', value: '1', on: false }],
      headers: [{ key: 'X-Trace', value: 't-{{trigger.id}}' }],
      auth: { type: 'bearer', token: '{{secrets.API_KEY}}' },
      bodyType: 'json', body: '{"name": "{{trigger.name}}", "n": {{trigger.id}}}',
    })], [edge('trigger', 'call')]),
    { id: 42, name: 'Dana "D"' },
    { secrets: { API_KEY: 'sk-secret-123' }, fetch: async (url, init) => { sent = { url, ...init }; return jsonResponse({ id: 'L1' }); } });
  assert.equal(sent.url, 'https://api.test/leads/42?q=Dana+%22D%22');
  assert.equal(sent.method, 'POST');
  assert.equal(sent.headers.Authorization, 'Bearer sk-secret-123');
  assert.equal(sent.headers['X-Trace'], 't-42');
  assert.equal(sent.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(sent.body), { name: 'Dana "D"', n: 42 });
  assert.deepEqual(state.outputs.call.body, { id: 'L1' });
  assert.equal(state.outputs.call.status, 200);
});

await check('basic auth, api key in the query, form body', () => {
  const basic = buildRequest({ url: 'https://a.test', auth: { type: 'basic', username: 'u', password: 'p' } });
  assert.equal(basic.headers.Authorization, `Basic ${Buffer.from('u:p').toString('base64')}`);
  const key = buildRequest({ url: 'https://a.test', auth: { type: 'apikey', key: 'k', value: 'v', in: 'query' } });
  assert.equal(key.url, 'https://a.test/?k=v');
  const form = buildRequest({ method: 'POST', url: 'https://a.test', bodyType: 'form', form: [{ key: 'a', value: 'b c' }] });
  assert.equal(form.body, 'a=b+c');
  assert.equal(buildRequest({ method: 'GET', url: 'https://a.test', bodyType: 'text', body: 'x' }).body, undefined);
});

await check('addresses inside the network are refused', async () => {
  for (const url of ['http://localhost/x', 'http://127.0.0.1/', 'http://169.254.169.254/latest', 'http://10.0.0.5/',
                     'http://[::1]/', 'http://192.168.1.1/', 'ftp://example.com/', 'http://metadata.google.internal/']) {
    await assert.rejects(assertPublicUrl(url), undefined, url);
  }
});

await check('redirects are followed, and checked', async () => {
  const hops = [];
  const { state } = await run(auto([step('call', 'http', { url: 'https://a.test/1' })], [edge('trigger', 'call')]), {}, {
    fetch: async (url) => {
      hops.push(url);
      return hops.length === 1
        ? new Response(null, { status: 302, headers: { location: '/2' } })
        : jsonResponse({ done: true });
    } });
  assert.deepEqual(hops, ['https://a.test/1', 'https://a.test/2']);
  assert.deepEqual(state.outputs.call.body, { done: true });
});

/* ─────────────────── code ─────────────────── */

await check('a code step sends its inputs and secrets to the runner, and reads JSON back', async () => {
  let sent;
  const { state, log } = await run(auto(
    [step('calc', 'code', { code: 'def run(**i):\n    return {"x": f"{{literal}}"}', packages: 'requests, pandas',
                            inputs: [{ key: 'score', value: '{{trigger.score}}' }] })],
    [edge('trigger', 'calc')]), { score: 9 }, {
    secrets: { TOKEN: 'tok-12345' },
    fetch: async (url, init) => {
      sent = { url, headers: init.headers, body: JSON.parse(init.body) };
      return jsonResponse({ result: JSON.stringify({ __8legs: true, value: { double: 18 }, printed: 'hello\n' }) });
    } });
  assert.equal(sent.url, 'https://platform.test/api/run-tool');
  assert.ok(sent.headers['X-Internal-Secret']);
  assert.deepEqual(sent.body.inputs, { score: 9 });
  assert.deepEqual(sent.body.packages, ['requests', 'pandas']);
  assert.deepEqual(sent.body.env_vars, { TOKEN: 'tok-12345' });
  assert.ok(sent.body.code.includes('f"{{literal}}"'), 'the code itself is not filled in');
  assert.deepEqual(state.outputs.calc, { double: 18 });
  assert.deepEqual(log[0].output, { result: { double: 18 }, printed: 'hello\n' });
});

await check('a code error is the step\'s error', async () => {
  const { result } = await run(auto([step('c', 'code', { code: 'x' })], [edge('trigger', 'c')]), {}, {
    fetch: async () => jsonResponse({ error: 'Runtime error: boom' }) });
  assert.match(result.error, /Runtime error: boom/);
});

/* ─────────────────── secrets and size ─────────────────── */

await check('secret values never reach the log', async () => {
  const { log } = await run(auto(
    [step('call', 'http', { url: 'https://a.test', headers: [{ key: 'X-Key', value: '{{secrets.K}}' }] })],
    [edge('trigger', 'call')]), {}, {
    secrets: { K: 'super-secret-value' },
    fetch: async () => jsonResponse({ echoed: 'super-secret-value' }) });
  assert.ok(!JSON.stringify(log).includes('super-secret-value'));
  assert.equal(log[0].output.body.echoed, '••••');
  assert.deepEqual(maskSecrets({ a: 'x' }, { S: 'abc' }), { a: 'x' }, 'too short a value is not masked');
});

await check('a large result is kept as a note and its start', () => {
  const big = { text: 'x'.repeat(5000) };
  assert.equal(clip(big, 10000), big);
  const cut = clip(big, 1000);
  assert.equal(cut.__truncated, true);
  assert.equal(cut.preview.length, 2000);
});

/* ─────────────────── waiting and handing over ─────────────────── */

await check('a short wait happens in place', async () => {
  const { result, log } = await run(auto(
    [step('w', 'wait', { amount: 5, unit: 'seconds' }), step('a', 'set')], [edge('trigger', 'w'), edge('w', 'a')]));
  assert.equal(result.status, 'done');
  assert.deepEqual(log.map(l => l.stepId), ['w', 'a']);
});

await check('a long wait parks the run, and it carries on afterwards', async () => {
  const def = auto(
    [step('before', 'set', { fields: [{ key: 'v', value: 1 }] }),
     step('w', 'wait', { amount: 2, unit: 'hours' }),
     step('after', 'output', { fields: [{ key: 'v', value: '{{before.v}}' }] })],
    [edge('trigger', 'before'), edge('before', 'w'), edge('w', 'after')]);
  const first = await run(def, {}, { start: 1_000_000 });
  assert.equal(first.result.status, 'waiting');
  assert.equal(first.result.resumeAt, 1_000_000 + 2 * 3600 * 1000);
  assert.deepEqual(first.log.map(l => [l.stepId, l.status]), [['before', 'done'], ['w', 'waiting']]);

  /* The state goes through the database as JSON. */
  const stored = JSON.parse(JSON.stringify(first.state));
  const early = await run(def, {}, { state: JSON.parse(JSON.stringify(stored)), start: 1_000_000 + 60_000 });
  assert.equal(early.result.status, 'waiting', 'woken early, it goes back to waiting');
  assert.equal(early.log.length, 0);

  const later = await run(def, {}, { state: stored, start: 1_000_000 + 2 * 3600 * 1000 + 1 });
  assert.equal(later.result.status, 'done');
  assert.deepEqual(later.result.output, { v: 1 });
  assert.deepEqual(later.log.map(l => l.stepId), ['w', 'after'], 'the step before the wait is not run again');
});

await check('out of time: the run is handed over and picks up where it stopped', async () => {
  const def = auto(
    [step('a', 'set', { fields: [{ key: 'v', value: 1 }] }), step('b', 'set', { fields: [{ key: 'v', value: '{{a.v}}' }] })],
    [edge('trigger', 'a'), edge('a', 'b')]);
  let ticks = 0;
  const first = await run(def, {}, { deadline: 1_000_000, ctx: { now: () => 1_000_000 + (ticks++ > 2 ? 10 : 0) } });
  assert.equal(first.result.status, 'queued');
  assert.deepEqual(first.log.map(l => l.stepId), ['a']);
  const second = await run(def, {}, { state: JSON.parse(JSON.stringify(first.state)) });
  assert.equal(second.result.status, 'done');
  assert.deepEqual(second.log.map(l => l.stepId), ['b']);
});

await check('Run automation hands over fields and takes the answer', async () => {
  let got;
  const { state } = await run(auto(
    [step('sub', 'call', { automationId: 'other', fields: [{ key: 'n', value: '{{trigger.n}}' }] })],
    [edge('trigger', 'sub')]), { n: 3 }, {
    callAutomation: async (id, input) => { got = { id, input }; return { doubled: 6 }; } });
  assert.deepEqual(got, { id: 'other', input: { n: 3 } });
  assert.deepEqual(state.outputs.sub, { doubled: 6 });
});

await check('fillConfig leaves code alone and fills the rest', () => {
  const filled = fillConfig(step('c', 'code', { code: 'x = "{{trigger.a}}"', inputs: [{ key: 'a', value: '{{trigger.a}}' }] }), { trigger: { a: 1 } });
  assert.equal(filled.code, 'x = "{{trigger.a}}"');
  assert.deepEqual(filled.inputs, [{ key: 'a', value: 1 }]);
});

/* ─────────────────── as files ─────────────────── */

const { automationToFiles, filesToAutomation } = await import('../api/_automationFiles.js');

const everything = checkAutomation(auto([
  step('score', 'code', { code: 'def run(**i):\n    return {"s": 1}\n', packages: 'requests', inputs: [{ key: 'lead', value: '{{trigger.body}}' }] }, { name: 'Score', retries: 2 }),
  step('hot', 'if', { match: 'all', conditions: [{ left: '{{score.s}}', op: 'gte', right: 1 }] }),
  step('crm', 'http', { method: 'POST', url: 'https://api.test/leads', params: [], headers: [{ key: 'X', value: '1', on: true }], auth: { type: 'bearer', token: '{{secrets.T}}' }, bodyType: 'json', body: '{"a": 1}', form: [], timeout: 30, failOnStatus: true }, { onError: 'continue' }),
  step('kind', 'switch', { value: '{{trigger.body.kind}}', cases: [{ id: 'vip', value: 'vip' }] }),
  step('each', 'loop', { items: '{{crm.body.items}}' }),
  step('note', 'set', { fields: [{ key: 'n', value: '{{item}}' }] }),
  step('pause', 'wait', { amount: 2, unit: 'hours' }),
  step('ask', 'approval', { connection: 'Office', to: '972500000002', text: 'ok?', timeoutHours: 4 }),
  step('tell', 'whatsapp', { connection: 'Office', to: '{{trigger.from}}', text: 'hi' }),
  step('mail', 'email', { connection: 'Sales', to: 'a@b.c', cc: '', subject: 's', body: 'b' }),
  step('look', 'email_search', { connection: 'Sales', query: 'from:x', limit: 5 }),
  step('file', 'table', { table: 't1', action: 'add', q: '', limit: 20, rowId: '', fields: [{ key: 'who', value: 'x' }] }),
  step('bot', 'agent', { agentId: 'a1', message: 'hello' }),
  step('think', 'ai', { prompt: 'classify', json: true, model: '' }),
  step('sub', 'call', { automationId: 'other', fields: [] }),
  step('done', 'output', { fields: [{ key: 'ok', value: true }] }),
], [
  edge('trigger', 'score'), edge('score', 'hot'), edge('hot', 'crm', 'yes'), edge('hot', 'kind', 'no'), edge('kind', 'pause', 'vip'),
  edge('kind', 'pause', 'default'), edge('crm', 'each'), edge('each', 'note', 'each'), edge('each', 'ask', 'done'),
  edge('ask', 'tell', 'yes'), edge('ask', 'mail', 'no'), edge('ask', 'look', 'timeout'), edge('tell', 'file'), edge('file', 'bot'),
  edge('bot', 'think'), edge('think', 'sub'), edge('sub', 'done'),
], { type: 'webhook', config: { respond: 'wait', secret: 'HOOK' } }));

await check('every kind of step is a valid automation', () => {
  assert.deepEqual(everything.errors, []);
  assert.deepEqual(portsOf(everything.automation.steps.find(s => s.id === 'ask')), ['yes', 'no', 'timeout']);
});

await check('an automation survives the trip to files and back, unchanged', () => {
  const files = automationToFiles(everything.automation, 'auto-1');
  assert.deepEqual(Object.keys(files).sort(), ['.gitignore', 'AGENTS.md', 'CLAUDE.md', 'automation.json', 'layout.json', 'steps/score.py']);
  assert.equal(files['steps/score.py'], 'def run(**i):\n    return {"s": 1}\n');
  const json = JSON.parse(files['automation.json']);
  assert.equal(json.steps[0].config.code, undefined, 'the code is in its own file, not in the JSON');
  assert.deepEqual(json.edges[0], { from: 'trigger', to: 'score' }, '"out" goes unsaid');
  assert.equal(json.steps[0].position, undefined, 'where a step sits is not in the logic');
  const back = filesToAutomation(files, { id: 'auto-1' });
  assert.deepEqual(back.errors, []);
  assert.deepEqual(back.automation, everything.automation);
});

await check('a folder with no layout is placed by the platform', () => {
  const files = automationToFiles(everything.automation, 'auto-1');
  delete files['layout.json'];
  const { automation, errors } = filesToAutomation(files, { id: 'auto-1' });
  assert.deepEqual(errors, []);
  const x = (id) => automation.steps.find(s => s.id === id).position.x;
  assert.ok(x('score') > automation.trigger.position.x && x('hot') > x('score') && x('done') > x('sub'));
});

await check('what is wrong with a folder is said, and nothing comes back', () => {
  const base = automationToFiles(everything.automation, 'auto-1');
  const broken = (change) => { const f = { ...base }; change(f); return filesToAutomation(f, { id: 'auto-1' }); };
  const edit = (fn) => (f) => { const j = JSON.parse(f['automation.json']); fn(j); f['automation.json'] = JSON.stringify(j); };

  assert.match(broken(f => { f['automation.json'] = '{'; }).errors[0], /automation\.json/);
  assert.match(broken(f => { delete f['steps/score.py']; }).errors[0], /steps\/score\.py is missing/);
  assert.match(broken(f => { f['steps/ghost.py'] = 'x'; }).errors[0], /no Code step called "ghost"/);
  assert.match(broken(f => { f['notes.txt'] = 'x'; }).errors[0], /not part of an automation/);
  assert.match(broken(edit(j => { j.edges[0].to = 'scor'; })).errors[0], /leads to "scor", which is not a step/);
  assert.match(broken(edit(j => { j.edges[2].port = 'maybe'; })).errors[0], /by "maybe"; it has "yes", "no"/);
  assert.match(broken(edit(j => { j.id = 'someone-else'; })).errors[0], /must not be changed/);
  assert.match(broken(edit(j => { j.trigger.type = 'telepathy'; })).errors[0], /trigger\.type must be one of/);
  assert.match(broken(edit(j => { j.edges.push({ from: 'done', to: 'score' }); })).errors[0], /no way out/);
  assert.equal(broken(f => { f['automation.json'] = '{'; }).automation, null);
});

await check('settings not filled in do not stop a draft being pushed', () => {
  const files = automationToFiles(checkAutomation(auto([step('call', 'http', { url: '' })], [edge('trigger', 'call')])).automation, 'a');
  const { automation, errors } = filesToAutomation(files, { id: 'a' });
  assert.deepEqual(errors, []);
  assert.ok(checkAutomation(automation).errors.some(e => e.includes('needs a URL')), 'but it is still unfinished');
});

/* ─────────────────── waiting for a person ─────────────────── */

await check('an approval parks the run, and the answer decides the way out', async () => {
  const def = auto(
    [step('ask', 'approval', { connection: 'Office', to: '972500000002', text: 'Refund {{trigger.amount}}?', timeoutHours: 2 }),
     step('yes', 'set', { fields: [{ key: 'v', value: 'approved by {{ask.by}}' }] }),
     step('no', 'set', { fields: [{ key: 'v', value: 'declined' }] }),
     step('late', 'set', { fields: [{ key: 'v', value: 'nobody answered' }] })],
    [edge('trigger', 'ask'), edge('ask', 'yes', 'yes'), edge('ask', 'no', 'no'), edge('ask', 'late', 'timeout')]);
  const asked = [];
  const connected = {
    approval: async (config, ctx) => {
      const now = ctx.now();
      if (ctx.parked) {
        if (ctx.parked.answer) return { output: { answer: ctx.parked.answer.answer, by: ctx.parked.phone }, port: ctx.parked.answer.answer };
        if (now >= ctx.parked.until) return { output: { answer: 'timeout' }, port: 'timeout' };
        return { park: ctx.parked };
      }
      asked.push(config.text);
      return { park: { kind: 'approval', phone: config.to, until: now + 2 * 3600 * 1000 } };
    },
  };
  const first = await run(def, { amount: 120 }, { start: 1_000_000, ctx: { connected } });
  assert.equal(first.result.status, 'waiting');
  assert.deepEqual(asked, ['Refund 120?']);
  assert.equal(first.state.wait.phone, '972500000002');
  assert.deepEqual(first.log.map(l => [l.stepId, l.status]), [['ask', 'waiting']]);

  const parked = () => JSON.parse(JSON.stringify(first.state));
  const early = await run(def, { amount: 120 }, { state: parked(), start: 1_000_000 + 60_000, ctx: { connected } });
  assert.equal(early.result.status, 'waiting', 'woken with no answer and time left, it goes on waiting');
  assert.equal(asked.length, 1, 'and does not ask again');

  const answered = parked();
  answered.wait.answer = { answer: 'yes', text: 'כן' };
  const yes = await run(def, { amount: 120 }, { state: answered, start: 1_000_000 + 120_000, ctx: { connected } });
  assert.equal(yes.result.status, 'done');
  assert.deepEqual(yes.log.map(l => [l.stepId, l.port]), [['ask', 'yes'], ['yes', 'out']]);
  assert.deepEqual(yes.state.outputs.yes, { v: 'approved by 972500000002' });
  assert.equal(yes.state.wait, null);

  const late = await run(def, { amount: 120 }, { state: parked(), start: 1_000_000 + 3 * 3600 * 1000, ctx: { connected } });
  assert.deepEqual(late.log.map(l => l.stepId), ['ask', 'late']);
});

await check('an approval inside a loop is refused', () => {
  const { errors } = checkAutomation(auto(
    [step('l', 'loop', { items: '{{trigger.x}}' }), step('ask', 'approval', { connection: 'c', to: '1', text: 't' })],
    [edge('trigger', 'l'), edge('l', 'ask', 'each')]));
  assert.ok(errors.some(e => e.includes('cannot sit inside a loop')));
});

/* ─────────────────── connections, mail, WhatsApp ─────────────────── */

globalThis.__db = (text) => {
  if (/^\s*update connections/.test(text)) return [];
  throw new Error('unrouted: ' + String(text).trim().slice(0, 60));
};
const { seal, unseal, signState, readState } = await import('../api/_connections.js');
const { sendMail, searchMail, mailSince } = await import('../api/_mail.js');
const { recipientOf, jidOfRecipient } = await import('../api/_waOutbox.js');
const { readAnswer } = await import('../api/_automationConnected.js');

await check('tokens are sealed, and a sealed value that was touched is refused', () => {
  const sealed = seal({ access_token: 'ya29.secret', refresh_token: 'r' });
  assert.ok(!sealed.includes('ya29'));
  assert.deepEqual(unseal(sealed), { access_token: 'ya29.secret', refresh_token: 'r' });
  assert.notEqual(seal({ a: 1 }), seal({ a: 1 }), 'no two sealings look alike');
  assert.throws(() => unseal(sealed.slice(0, -2) + 'xx'), /cannot be read/);
  assert.throws(() => unseal('plain'), /cannot be read/);
});

await check('a sign-in\'s state is signed and short-lived', () => {
  const state = signState({ orgId: 'o1', provider: 'gmail', name: 'Sales' });
  assert.equal(readState(state).orgId, 'o1');
  assert.equal(readState(state.replace(/.$/, c => (c === 'a' ? 'b' : 'a'))), null);
  assert.equal(readState('nonsense'), null);
  assert.equal(readState(undefined), null);
});

const mailbox = (kind) => ({ id: 'c1', kind, name: 'Sales', account: 'sales@example.com',
                             data: { sealed: seal({ access_token: 'tok', refresh_token: 'ref', expires_at: Date.now() + 3600e3 }) } });

await check('Gmail: a Hebrew subject and body arrive whole', async () => {
  let sent;
  const out = await sendMail(mailbox('gmail'), { to: 'dana@example.com, noa@example.com', subject: 'אישור הזמנה', body: 'שלום דנה' },
    { fetchImpl: async (url, init) => { sent = { url, init }; return jsonResponse({ id: 'm1' }); } });
  assert.equal(out.id, 'm1');
  assert.deepEqual(out.to, ['dana@example.com', 'noa@example.com']);
  assert.equal(sent.init.headers.Authorization, 'Bearer tok');
  const raw = Buffer.from(JSON.parse(sent.init.body).raw, 'base64url').toString('utf8');
  assert.ok(raw.includes('To: dana@example.com, noa@example.com'));
  assert.ok(raw.includes(`Subject: =?UTF-8?B?${Buffer.from('אישור הזמנה').toString('base64')}?=`));
  assert.equal(Buffer.from(raw.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8'), 'שלום דנה');
});

await check('Microsoft 365: send goes to Graph as text', async () => {
  let sent;
  await sendMail(mailbox('microsoft'), { to: 'dana@example.com', cc: 'boss@example.com', subject: 'Hi', body: 'Body' },
    { fetchImpl: async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return new Response(null, { status: 202 }); } });
  assert.equal(sent.url, 'https://graph.microsoft.com/v1.0/me/sendMail');
  assert.deepEqual(sent.body.message.toRecipients, [{ emailAddress: { address: 'dana@example.com' } }]);
  assert.deepEqual(sent.body.message.ccRecipients, [{ emailAddress: { address: 'boss@example.com' } }]);
  assert.equal(sent.body.message.body.contentType, 'Text');
});

const gmailApi = (messages) => async (url) => {
  const u = new URL(url);
  if (u.pathname.endsWith('/messages')) return jsonResponse({ messages: messages.map(m => ({ id: m.id })) });
  const m = messages.find(x => u.pathname.endsWith(`/messages/${x.id}`));
  return jsonResponse({ id: m.id, internalDate: String(m.at), snippet: 'snip',
    payload: { headers: [{ name: 'From', value: m.from }, { name: 'Subject', value: m.subject }],
               parts: [{ mimeType: 'text/plain', body: { data: Buffer.from(m.text).toString('base64url') } }] } });
};

await check('mail is read into one shape, whichever mailbox', async () => {
  const found = await searchMail(mailbox('gmail'), { query: 'from:dana', limit: 5 },
    { fetchImpl: gmailApi([{ id: 'a', at: 1_800_000_000_000, from: 'Dana Levi <dana@example.com>', subject: 'Order', text: 'Where is it?' }]) });
  assert.deepEqual(found, [{ id: 'a', from: 'dana@example.com', fromName: 'Dana Levi', to: '', subject: 'Order', text: 'Where is it?', date: new Date(1_800_000_000_000).toISOString() }]);
  const ms = await searchMail(mailbox('microsoft'), { query: 'order' }, { fetchImpl: async () => jsonResponse({ value: [
    { id: 'g1', subject: 'Order', from: { emailAddress: { address: 'dana@example.com', name: 'Dana' } }, toRecipients: [], receivedDateTime: '2026-11-16T10:00:00Z', body: { content: 'Where?' } }] }) });
  assert.deepEqual(ms[0], { id: 'g1', from: 'dana@example.com', fromName: 'Dana', to: '', subject: 'Order', text: 'Where?', date: '2026-11-16T10:00:00Z' });
});

await check('"mail since" gives only what is newer, oldest first', async () => {
  const since = new Date(1_800_000_000_000).toISOString();
  const fresh = await mailSince(mailbox('gmail'), { since, query: '' }, { fetchImpl: gmailApi([
    { id: 'new2', at: 1_800_000_120_000, from: 'b@x.co', subject: '2', text: 't' },
    { id: 'old', at: 1_800_000_000_000, from: 'a@x.co', subject: '0', text: 't' },
    { id: 'new1', at: 1_800_000_060_000, from: 'a@x.co', subject: '1', text: 't' }]) });
  assert.deepEqual(fresh.map(m => m.id), ['new1', 'new2']);
});

await check('who a WhatsApp message goes to', () => {
  assert.equal(recipientOf('+972 54-555 0118'), '972545550118');
  assert.equal(recipientOf('054-555-0118'), '972545550118', 'a leading 0 is an Israeli number');
  assert.equal(recipientOf('120363041234567890@g.us'), '120363041234567890@g.us');
  assert.equal(recipientOf('972545550118@s.whatsapp.net'), '972545550118');
  assert.equal(recipientOf('dana'), null);
  assert.equal(recipientOf('123'), null);
  assert.equal(jidOfRecipient('972545550118'), '972545550118@s.whatsapp.net');
  assert.equal(jidOfRecipient('1203@g.us'), '1203@g.us');
});

await check('what counts as yes and as no', () => {
  for (const t of ['yes', 'Yes!', 'כן', ' מאשר ', 'ok', '👍', 'אישור']) assert.equal(readAnswer(t), 'yes', t);
  for (const t of ['no', 'לא', 'No.', 'דחה', '👎']) assert.equal(readAnswer(t), 'no', t);
  for (const t of ['yes but later', 'who is this?', '', 'כן, אבל', 'nope maybe']) assert.equal(readAnswer(t), null, t);
});

console.log(`automation-probe: ${passed} checks passed${process.exitCode ? ' — with failures above' : ''}`);
