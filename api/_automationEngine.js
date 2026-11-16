/**
 * Runs an automation: walks the graph from the trigger, one step at a time.
 *
 * How the walk goes
 * -----------------
 * Every connection ends up either *fired* or *dead*. A step runs once all the
 * connections into it are settled and at least one fired; if they are all
 * dead it is dead too, and so is everything it leads to. So after an If, the
 * side not taken is skipped all the way down, and a step two branches lead
 * into waits for both to be settled before it runs — once.
 *
 * A Loop runs the steps on its "each" side once per item, each pass with a
 * fresh set of results for those steps, then goes on from "done".
 *
 * Staying alive
 * -------------
 * `state` is everything needed to carry on: which steps finished, what each
 * returned, which connections fired. It is handed to `ctx.saveState` after
 * every step outside a loop, so a run that has to stop — a Wait, or the
 * function running out of time — is picked up later from exactly there. A
 * loop is not saved mid-way: one interrupted is started again from its first
 * item.
 *
 * Nothing here knows about the database. `ctx` supplies the world:
 *
 *   secrets, baseUrl, fetch      what steps need
 *   deadline                     ms timestamp after which to stop and hand over
 *   recordStep(record)           the run log
 *   saveState(state)             durability
 *   onSample(id, value)          what the editor's field picker remembers
 *   callAutomation(id, input)    a Run automation step
 *   sleep(ms), now()             so a probe does not actually wait
 */
import {
  TRIGGER_ID, LIMITS, PARKING, edgeKey, ownerOf, portsOf, resolve, waitSeconds,
} from './_automationSpec.js';
import { fillConfig, runStep } from './_automationSteps.js';

const MASK = '••••';

/** Replaces every secret value found anywhere in `value` with dots. */
export function maskSecrets(value, secrets) {
  const values = Object.values(secrets || {}).map(String).filter(v => v.length >= 4);
  if (!values.length || value === undefined || value === null) return value;
  let text = JSON.stringify(value);
  for (const v of values) {
    const inner = JSON.stringify(v).slice(1, -1);
    text = text.split(inner).join(MASK);
  }
  try { return JSON.parse(text); } catch { return value; }
}

/** A value small enough to keep; a large one becomes a note and its start. */
export function clip(value, bytes) {
  if (value === undefined) return null;
  const text = JSON.stringify(value);
  if (text === undefined || text.length <= bytes) return value;
  return { __truncated: true, bytes: text.length, preview: text.slice(0, 2000) };
}

export function freshState() {
  return { outputs: {}, nodes: {}, edges: {}, wait: null, output: null };
}

const label = (s) => s.name || s.id;

/**
 * Carries a run forward until it finishes, fails, has to wait, or runs out of
 * time. Returns `{ status, output?, error?, failedStep?, resumeAt? }` with
 * status one of 'done', 'failed', 'waiting', 'queued'.
 */
export async function advance({ definition, input, state, ctx }) {
  const def = definition;
  const now = ctx.now || (() => Date.now());
  const sleep = ctx.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
  const owner = ownerOf(def);
  const secrets = ctx.secrets || {};
  const edges = def.edges || [];
  const base = { trigger: input === undefined ? null : input, secrets,
                 run: { id: ctx.runId || null, mode: ctx.mode || 'live' } };

  if (ctx.onSample) ctx.onSample(TRIGGER_ID, input === undefined ? null : input);

  /* The trigger has already happened: its connections are fired. */
  for (const e of edges) if (e.from === TRIGGER_ID && !state.edges[edgeKey(e)]) state.edges[edgeKey(e)] = 'fired';

  const settle = (st, step, port) => {
    for (const e of edges) {
      if (e.from !== step.id) continue;
      st.edges[edgeKey(e)] = port !== null && e.port === port ? 'fired' : 'dead';
    }
  };

  const record = async (step, rec) => {
    if (!ctx.recordStep) return;
    await ctx.recordStep({
      stepId: step.id, stepType: step.type, stepName: step.name || '',
      status: rec.status, port: rec.port ?? null, iteration: rec.iteration ?? null,
      input: clip(maskSecrets(rec.input, secrets), LIMITS.storedBytes),
      output: clip(maskSecrets(rec.output, secrets), LIMITS.storedBytes),
      error: rec.error ? String(maskSecrets(rec.error, secrets)) : null,
      ms: rec.ms || 0,
    });
  };

  /**
   * Runs the steps of one region — the automation outside any loop, or one
   * pass of one loop — as far as they will go.
   */
  async function region({ loopId, st, outer, extra, iteration }) {
    const main = loopId === null;
    for (;;) {
      let progressed = false;
      for (const step of def.steps) {
        if (owner[step.id] !== loopId || st.nodes[step.id]) continue;
        const incoming = edges.filter(e => e.to === step.id);
        if (incoming.some(e => !st.edges[edgeKey(e)])) continue;
        progressed = true;

        if (!incoming.some(e => st.edges[edgeKey(e)] === 'fired')) {
          st.nodes[step.id] = 'dead';
          settle(st, step, null);
          continue;
        }

        if (main && ctx.deadline && now() > ctx.deadline) return { status: 'queued' };

        const scope = { ...base, now: new Date(now()).toISOString(), ...outer, ...st.outputs, ...extra };
        const started = now();
        let result;

        if (step.type === 'wait') {
          const waited = await doWait({ step, st, scope, main, iteration });
          if (waited.status) return waited;
          result = waited;
        } else if (step.type === 'loop') {
          result = await attempt(step, () => doLoop({ step, st, scope, outer, extra }));
        } else if (PARKING.has(step.type)) {
          const parked = await doPark({ step, scope, main, iteration });
          if (parked.status) return parked;
          result = parked;
        } else {
          let filled;
          result = await attempt(step, async () => {
            filled = fillConfig(step, scope);
            return runStep(step, filled, ctx);
          });
          result.input = filled;
        }

        const ms = now() - started;
        if (result.failed) {
          await record(step, { status: 'failed', input: result.input, output: result.output, error: result.error, ms, iteration });
          return { status: 'failed', error: `${label(step)}: ${maskSecrets(result.error, secrets)}`, failedStep: step.id };
        }

        st.outputs[step.id] = result.output === undefined ? null : result.output;
        st.nodes[step.id] = 'done';
        settle(st, step, result.port);
        if (result.isOutput) state.output = st.outputs[step.id];
        if (ctx.onSample) ctx.onSample(step.id, st.outputs[step.id]);
        await record(step, {
          status: result.error ? 'failed' : 'done', port: result.port, input: result.input,
          output: result.printed ? { result: st.outputs[step.id], printed: result.printed } : st.outputs[step.id],
          error: result.error, ms, iteration,
        });
        if (main && ctx.saveState) await ctx.saveState(state);
      }
      if (!progressed) return { status: 'done' };
    }
  }

  /** Runs `fn` with the step's retries, and its "carry on after an error". */
  async function attempt(step, fn) {
    let error;
    let output;
    for (let tries = 0; tries <= (step.retries || 0); tries++) {
      try {
        const result = await fn();
        if (JSON.stringify(result.output === undefined ? null : result.output).length > LIMITS.outputBytes) {
          throw new Error('returned more than 1 MB, which is more than a step can hand on');
        }
        return result;
      } catch (err) {
        error = err.message || String(err);
        output = err.output;
        if (tries < (step.retries || 0)) await sleep(Math.min(8000, 1000 * 2 ** tries));
      }
    }
    /* Carrying on needs somewhere to carry on to: a step with one way out. */
    if (step.onError === 'continue' && portsOf(step).length === 1) {
      return { output: { error, ...(output && typeof output === 'object' ? output : {}) }, port: 'out', error };
    }
    return { failed: true, error, output };
  }

  async function doWait({ step, st, scope, main, iteration }) {
    const config = resolve(step.config || {}, scope);
    const seconds = waitSeconds(config);
    const resuming = main && state.wait && state.wait.stepId === step.id;
    if (resuming) {
      const until = state.wait.until;
      if (now() < until) return { status: 'waiting', resumeAt: until };
      state.wait = null;
      return { output: { waitedSeconds: seconds, until: new Date(until).toISOString() }, port: 'out', input: config };
    }
    if (seconds <= LIMITS.waitInlineSeconds || !main) {
      await sleep(Math.min(seconds, LIMITS.waitInlineSeconds) * 1000);
      return { output: { waitedSeconds: seconds, until: new Date(now()).toISOString() }, port: 'out', input: config };
    }
    const until = now() + seconds * 1000;
    state.wait = { stepId: step.id, until };
    await record(step, { status: 'waiting', input: config, output: { until: new Date(until).toISOString() }, iteration });
    if (ctx.saveState) await ctx.saveState(state);
    return { status: 'waiting', resumeAt: until };
  }

  /**
   * A step that asks something outside the run and waits for the answer.
   *
   * The first time, the step does its asking and says what it is waiting for
   * (`park`); the run is parked with that in `state.wait`. Whoever gets the
   * answer writes it into `state.wait.answer` and wakes the run; the step is
   * then called again with what was parked, and this time returns a result.
   * Woken with no answer after its time is up, it returns its timeout.
   */
  async function doPark({ step, scope, main, iteration }) {
    const resuming = main && state.wait && state.wait.stepId === step.id;
    let filled;
    try {
      if (!main) throw new Error('waits for a person, so it cannot sit inside a loop');
      filled = fillConfig(step, scope);
      const result = await runStep(step, filled, { ...ctx, parked: resuming ? state.wait : null, now });
      if (!result.park) {
        if (resuming) state.wait = null;
        return { ...result, input: filled };
      }
      if (resuming) return { status: 'waiting', resumeAt: state.wait.until };
      state.wait = { stepId: step.id, ...result.park };
      await record(step, { status: 'waiting', input: filled, output: result.waitingOutput || null, iteration });
      if (ctx.saveState) await ctx.saveState(state);
      return { status: 'waiting', resumeAt: state.wait.until };
    } catch (err) {
      return { failed: true, error: err.message || String(err), input: filled };
    }
  }

  async function doLoop({ step, st, scope, outer, extra }) {
    let items = resolve((step.config || {}).items, scope);
    if (typeof items === 'string') {
      try { items = JSON.parse(items); } catch { /* not a list written as text */ }
    }
    if (!Array.isArray(items)) throw new Error('needs a list to go over, and what it was given is not a list');
    if (items.length > LIMITS.loopItems) {
      throw new Error(`was given ${items.length} items; a loop goes over at most ${LIMITS.loopItems}`);
    }
    if (ctx.onSample && items.length) { ctx.onSample('item', items[0]); ctx.onSample('index', 0); }

    const results = [];
    for (let index = 0; index < items.length; index++) {
      if (ctx.hardDeadline && now() > ctx.hardDeadline) {
        throw new Error(`ran out of time after ${index} of ${items.length} items`);
      }
      const pass = { nodes: {}, edges: {}, outputs: {} };
      for (const e of edges) if (e.from === step.id && e.port === 'each') pass.edges[edgeKey(e)] = 'fired';
      const done = await region({
        loopId: step.id, st: pass,
        outer: { ...outer, ...st.outputs },
        extra: { ...extra, item: items[index], index },
        iteration: index,
      });
      if (done.status === 'failed') throw new Error(`item ${index + 1} of ${items.length} — ${done.error}`);
      /* What a pass "returns" is what its last step returned. */
      const ran = def.steps.filter(s => pass.nodes[s.id] === 'done');
      results.push(ran.length ? pass.outputs[ran[ran.length - 1].id] : null);
    }
    return { output: { count: items.length, results }, port: 'done', input: { items: clip(items, 20000) } };
  }

  const end = await region({ loopId: null, st: state, outer: {}, extra: {}, iteration: null });
  if (end.status === 'done') return { status: 'done', output: state.output === undefined ? null : state.output };
  return end;
}
