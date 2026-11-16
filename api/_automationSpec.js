/**
 * What an automation is, as data: its shape, the kinds of step there are, how
 * a value refers to another step's result, and what makes a definition valid.
 *
 * Nothing here touches the database or the network, so the canvas's rules and
 * the engine's rules are the same rules, and a probe can check them directly.
 *
 *   {
 *     name, description,
 *     trigger: { type, config, position },
 *     steps:   [{ id, type, name, config, position, onError, retries }],
 *     edges:   [{ from, port, to }]
 *   }
 *
 * The trigger is the node with id "trigger". An edge leaves a node by one of
 * its ports: most steps have one ("out"); an If has "yes" and "no"; a Switch
 * has one per case and "default"; a Loop has "each" (run for every item) and
 * "done" (run once after the last).
 */

export const TRIGGER_ID = 'trigger';

export const TRIGGERS = {
  manual:   { label: 'Manual run' },
  webhook:  { label: 'Webhook' },
  schedule: { label: 'Schedule' },
  whatsapp: { label: 'WhatsApp message' },
  email:    { label: 'New email' },
  table:    { label: 'New table row' },
};

export const STEPS = {
  code:   { label: 'Code',           ports: ['out'] },
  http:   { label: 'HTTP request',   ports: ['out'] },
  if:     { label: 'If',             ports: ['yes', 'no'] },
  switch: { label: 'Switch',         ports: null /* its cases, then "default" */ },
  set:    { label: 'Set values',     ports: ['out'] },
  loop:   { label: 'Loop',           ports: ['each', 'done'] },
  wait:   { label: 'Wait',           ports: ['out'] },
  call:   { label: 'Run automation', ports: ['out'] },
  output: { label: 'Output',         ports: [] },
  whatsapp:     { label: 'Send WhatsApp',   ports: ['out'] },
  approval:     { label: 'Ask for approval', ports: ['yes', 'no', 'timeout'] },
  email:        { label: 'Send email',      ports: ['out'] },
  email_search: { label: 'Find emails',     ports: ['out'] },
  table:        { label: 'Table',           ports: ['out'] },
  agent:        { label: 'Ask AI Chatbot',  ports: ['out'] },
  ai:           { label: 'AI',              ports: ['out'] },
};

/* Steps that stop the run until something outside it happens. Like a long
   Wait, they cannot sit inside a loop. */
export const PARKING = new Set(['approval']);

export const LIMITS = {
  steps: 100,
  loopItems: 500,
  waitInlineSeconds: 15,
  waitMaxDays: 30,
  callDepth: 4,
  outputBytes: 1024 * 1024,      /* what one step may hand to the next */
  storedBytes: 200 * 1024,       /* what the run log keeps of it */
  sampleBytes: 40 * 1024,        /* what the editor's field picker keeps of it */
};

/* Step ids are part of every reference to the step, so they stay simple. */
const ID = /^[a-z][a-z0-9_]{0,39}$/;
const RESERVED = new Set([TRIGGER_ID, 'secrets', 'item', 'index', 'now', 'run']);

export function portsOf(step) {
  if (!step) return ['out'];
  if (step.id === TRIGGER_ID) return ['out'];
  if (step.type === 'switch') {
    const cases = Array.isArray(step.config && step.config.cases) ? step.config.cases : [];
    return [...cases.map(c => String(c.id)), 'default'];
  }
  return (STEPS[step.type] || {}).ports || ['out'];
}

/** A fresh automation: one trigger, nothing after it. */
export function blankAutomation(name, triggerType = 'manual') {
  return {
    name,
    description: '',
    trigger: { type: triggerType, config: defaultConfig(triggerType, true), position: { x: 80, y: 120 } },
    steps: [],
    edges: [],
  };
}

export function defaultConfig(type, isTrigger = false) {
  if (isTrigger) {
    if (type === 'manual') return { fields: [] };
    if (type === 'webhook') return { respond: 'now', secret: '' };
    if (type === 'schedule') return { mode: 'every', every: 1, unit: 'hours', time: '09:00', days: [0, 1, 2, 3, 4, 5, 6], cron: '0 9 * * *' };
    if (type === 'whatsapp') return { connection: '', match: 'any', text: '', from: '', alsoChatbot: false };
    if (type === 'email') return { connection: '', query: '' };
    if (type === 'table') return { table: '' };
    return {};
  }
  switch (type) {
    case 'code': return { code: 'def run(**inputs):\n    return {"ok": True}\n', packages: '', inputs: [] };
    case 'http': return { method: 'GET', url: '', params: [], headers: [], auth: { type: 'none' },
                          bodyType: 'none', body: '', form: [], timeout: 30, failOnStatus: true };
    case 'if': return { match: 'all', conditions: [{ left: '', op: 'eq', right: '' }] };
    case 'switch': return { value: '', cases: [{ id: 'case_1', value: '' }] };
    case 'set': return { fields: [{ key: '', value: '' }] };
    case 'loop': return { items: '' };
    case 'wait': return { amount: 5, unit: 'minutes' };
    case 'call': return { automationId: '', fields: [] };
    case 'output': return { fields: [{ key: 'result', value: '' }] };
    case 'whatsapp': return { connection: '', to: '', text: '' };
    case 'approval': return { connection: '', to: '', text: '', timeoutHours: 24 };
    case 'email': return { connection: '', to: '', cc: '', subject: '', body: '' };
    case 'email_search': return { connection: '', query: '', limit: 10 };
    case 'table': return { table: '', action: 'find', q: '', limit: 20, rowId: '', fields: [] };
    case 'agent': return { agentId: '', message: '' };
    case 'ai': return { prompt: '', json: false, model: '' };
    default: return {};
  }
}

/* ─────────────────── references: {{ step.field }} ─────────────────── */

const EXPR = /\{\{\s*([^{}]+?)\s*\}\}/g;
const WHOLE = /^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/;

/** "http_1.body.items[0].name" → ['http_1', 'body', 'items', 0, 'name'] */
export function parsePath(path) {
  const out = [];
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let m;
  while ((m = re.exec(String(path)))) out.push(m[2] !== undefined ? Number(m[2]) : m[1]);
  return out;
}

export function lookup(scope, path) {
  let at = scope;
  for (const key of parsePath(path)) {
    if (at === null || at === undefined) return undefined;
    at = at[key];
  }
  return at;
}

function asText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Fills the references in a value from `scope`.
 *
 * A string that is nothing but one reference becomes the thing it refers to,
 * with its type kept — a number stays a number, a list stays a list. A
 * reference inside a longer string is written into it as text.
 */
export function resolve(value, scope) {
  if (typeof value === 'string') {
    const whole = WHOLE.exec(value);
    if (whole) {
      const found = lookup(scope, whole[1]);
      return found === undefined ? null : found;
    }
    return value.replace(EXPR, (_, path) => asText(lookup(scope, path)));
  }
  if (Array.isArray(value)) return value.map(v => resolve(v, scope));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolve(v, scope);
    return out;
  }
  return value;
}

/** Every step a value refers to, e.g. to warn about a reference to nothing. */
export function referencesIn(value, found = new Set()) {
  if (typeof value === 'string') {
    for (const m of value.matchAll(EXPR)) {
      const [root] = parsePath(m[1]);
      if (root !== undefined) found.add(String(root));
    }
  } else if (Array.isArray(value)) {
    value.forEach(v => referencesIn(v, found));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach(v => referencesIn(v, found));
  }
  return found;
}

/**
 * A JSON body written as text, with references in it.
 *
 * A reference inside a string — `{"name": "Hi {{trigger.name}}"}` — is filled
 * after the text is parsed, so a value with a quote in it cannot break the
 * JSON. A bare one — `{"count": {{trigger.count}}}` — is not JSON as written;
 * it is read as standing for the whole value, type and all.
 */
export function resolveJsonText(text, scope) {
  const raw = String(text || '').trim();
  if (!raw) return undefined;
  let out = '';
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      out += ch;
      if (ch === '\\') { out += raw[++i] ?? ''; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '{' && raw[i + 1] === '{') {
      const close = raw.indexOf('}}', i + 2);
      if (close !== -1) {
        out += JSON.stringify(`{{${raw.slice(i + 2, close)}}}`);
        i = close + 1;
        continue;
      }
    }
    out += ch;
  }
  let parsed;
  try { parsed = JSON.parse(out); }
  catch (err) { throw new Error(`The JSON body is not valid JSON: ${err.message}`); }
  return resolve(parsed, scope);
}

/* ─────────────────── the graph ─────────────────── */

export const edgeKey = (e) => `${e.from}|${e.port || 'out'}|${e.to}`;

/**
 * Which steps belong to each loop: everything reached from its "each" port.
 * Returns `{ loopId: Set(stepIds) }`. A loop inside a loop's body is in the
 * outer set, and its own body is too.
 */
export function loopBodies(def) {
  const out = {};
  const edges = def.edges || [];
  for (const step of def.steps || []) {
    if (step.type !== 'loop') continue;
    const body = new Set();
    const queue = edges.filter(e => e.from === step.id && e.port === 'each').map(e => e.to);
    while (queue.length) {
      const id = queue.shift();
      if (body.has(id) || id === step.id) continue;
      body.add(id);
      for (const e of edges) if (e.from === id) queue.push(e.to);
    }
    out[step.id] = body;
  }
  return out;
}

/** The innermost loop each step sits in, or null: `{ stepId: loopId | null }`. */
export function ownerOf(def) {
  const bodies = loopBodies(def);
  const owner = {};
  for (const step of def.steps || []) {
    let best = null;
    for (const [loopId, body] of Object.entries(bodies)) {
      if (!body.has(step.id)) continue;
      if (best === null || bodies[best].has(loopId)) best = loopId;   /* the deeper one wins */
    }
    owner[step.id] = best;
  }
  return owner;
}

function hasCycle(ids, edges) {
  const out = new Map(ids.map(id => [id, []]));
  for (const e of edges) if (out.has(e.from) && out.has(e.to)) out.get(e.from).push(e.to);
  const state = new Map();
  const visit = (id) => {
    if (state.get(id) === 2) return false;
    if (state.get(id) === 1) return true;
    state.set(id, 1);
    for (const next of out.get(id)) if (visit(next)) return true;
    state.set(id, 2);
    return false;
  };
  return ids.some(visit);
}

/**
 * Tidies a definition into the stored shape and says what is wrong with it.
 *
 * `errors` stop a publish and a run. `warnings` are things worth a look that
 * do not: a step nothing leads to, a reference to a step that does not exist.
 */
export function checkAutomation(input) {
  const errors = [];
  const incomplete = [];
  const warnings = [];
  const src = input && typeof input === 'object' ? input : {};

  const name = String(src.name || '').trim().slice(0, 80);
  if (!name) errors.push('The automation needs a name');

  const t = src.trigger && typeof src.trigger === 'object' ? src.trigger : {};
  if (!TRIGGERS[t.type]) errors.push(`Unknown trigger "${t.type || ''}" — use manual, webhook or schedule`);
  const trigger = {
    type: TRIGGERS[t.type] ? t.type : 'manual',
    config: t.config && typeof t.config === 'object' ? t.config : {},
    position: position(t.position, 80, 120),
  };

  const steps = [];
  const seen = new Set();
  const list = Array.isArray(src.steps) ? src.steps : [];
  if (list.length > LIMITS.steps) errors.push(`An automation holds at most ${LIMITS.steps} steps`);
  list.slice(0, LIMITS.steps).forEach((s, i) => {
    const id = String((s && s.id) || '');
    if (!ID.test(id)) { errors.push(`Step ${i + 1}: the id "${id}" must be lowercase letters, digits and _`); return; }
    if (RESERVED.has(id)) { errors.push(`Step ${i + 1}: "${id}" is a reserved name`); return; }
    if (seen.has(id)) { errors.push(`Two steps are called "${id}"`); return; }
    if (!STEPS[s.type]) { errors.push(`${id}: unknown step type "${s.type || ''}"`); return; }
    seen.add(id);
    steps.push({
      id, type: s.type,
      name: String(s.name || '').slice(0, 80),
      config: s.config && typeof s.config === 'object' ? s.config : {},
      position: position(s.position, 320 + i * 40, 120 + i * 40),
      onError: s.onError === 'continue' ? 'continue' : 'stop',
      retries: Math.max(0, Math.min(3, Number(s.retries) || 0)),
    });
  });

  const byId = new Map(steps.map(s => [s.id, s]));
  const edges = [];
  const edgeSeen = new Set();
  for (const e of Array.isArray(src.edges) ? src.edges : []) {
    const edge = { from: String((e && e.from) || ''), port: String((e && e.port) || 'out'), to: String((e && e.to) || '') };
    const from = edge.from === TRIGGER_ID ? { id: TRIGGER_ID } : byId.get(edge.from);
    if (!from || !byId.has(edge.to)) continue;                       /* an edge to a deleted step */
    if (!portsOf(from).includes(edge.port)) continue;                /* an edge from a deleted case */
    if (edge.from === edge.to || edgeSeen.has(edgeKey(edge))) continue;
    edgeSeen.add(edgeKey(edge));
    edges.push(edge);
  }

  const def = { name, description: String(src.description || '').slice(0, 400), trigger, steps, edges };

  /* Steps written by hand or by a program come without a place on the canvas. */
  const unplaced = new Set(list.filter(s => s && !validPosition(s.position)).map(s => String(s.id)));
  if (unplaced.size) {
    const placed = layout(def);
    for (const s of steps) if (unplaced.has(s.id) && placed[s.id]) s.position = placed[s.id];
  }

  if (hasCycle([TRIGGER_ID, ...steps.map(s => s.id)], edges)) {
    errors.push('The steps connect in a circle. To repeat steps, use a Loop.');
    return { automation: def, errors, warnings, structural: errors };
  }

  /* A loop's body is its own: nothing outside may lead into it. */
  const bodies = loopBodies(def);
  for (const [loopId, body] of Object.entries(bodies)) {
    for (const e of edges) {
      if (!body.has(e.to)) continue;
      const fromInside = body.has(e.from) || (e.from === loopId && e.port === 'each');
      if (!fromInside) {
        errors.push(`"${label(byId.get(e.to))}" runs inside the loop "${label(byId.get(loopId))}", so only steps in that loop can lead to it`);
      }
    }
    for (const id of body) {
      if (byId.get(id).type === 'wait' && waitSeconds(byId.get(id).config) > LIMITS.waitInlineSeconds) {
        errors.push(`"${label(byId.get(id))}" waits inside a loop. A wait in a loop can be at most ${LIMITS.waitInlineSeconds} seconds.`);
      }
      if (PARKING.has(byId.get(id).type)) {
        errors.push(`"${label(byId.get(id))}" waits for a person, so it cannot sit inside a loop.`);
      }
      if (byId.get(id).type === 'output') {
        errors.push(`"${label(byId.get(id))}" is an Output inside a loop. Put it after the loop's "done".`);
      }
    }
  }

  const reached = new Set(edges.map(e => e.to));
  for (const s of steps) {
    if (!reached.has(s.id)) warnings.push(`Nothing leads to "${label(s)}", so it never runs`);
    for (const ref of referencesIn(s.config)) {
      if (!RESERVED.has(ref) && !byId.has(ref)) warnings.push(`"${label(s)}" refers to "${ref}", which is not a step`);
    }
    for (const problem of configProblems(s)) incomplete.push(`${label(s)}: ${problem}`);
  }
  for (const problem of triggerProblems(trigger)) incomplete.push(`Trigger: ${problem}`);

  /* `structural` is what is wrong with the shape; the rest of `errors` is
     settings not filled in yet. A draft may be saved with the second kind. */
  return { automation: def, errors: [...errors, ...incomplete], warnings, structural: errors };
}

const label = (s) => (s && (s.name || s.id)) || '';

const validPosition = (p) => !!p && typeof p === 'object' && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y));

function position(p, x, y) {
  return validPosition(p) ? { x: Math.round(Number(p.x)), y: Math.round(Number(p.y)) } : { x, y };
}

/**
 * A place for every step, in columns that read left to right from the
 * trigger: a step sits one column after the furthest step that leads to it.
 * Returns `{ stepId: { x, y } }`. Steps nothing leads to go in a last column.
 */
export function layout(def, { colWidth = 326, rowHeight = 118 } = {}) {
  const origin = def.trigger.position || { x: 80, y: 120 };
  const steps = def.steps || [];
  const edges = def.edges || [];
  const depth = { [TRIGGER_ID]: 0 };
  /* Longest path from the trigger; the graph has no circles, so this settles. */
  for (let pass = 0; pass <= steps.length; pass++) {
    let moved = false;
    for (const e of edges) {
      if (depth[e.from] === undefined) continue;
      if (depth[e.to] === undefined || depth[e.to] < depth[e.from] + 1) { depth[e.to] = depth[e.from] + 1; moved = true; }
    }
    if (!moved) break;
  }
  const last = Math.max(0, ...Object.values(depth));
  const columns = {};
  /* Within a column, a step follows the order of the connection that reaches it. */
  const rank = (id) => {
    const i = edges.findIndex(e => e.to === id);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  for (const s of steps) {
    const col = depth[s.id] === undefined ? last + 1 : depth[s.id];
    (columns[col] = columns[col] || []).push(s.id);
  }
  const out = {};
  for (const [col, ids] of Object.entries(columns)) {
    ids.sort((a, b) => rank(a) - rank(b));
    ids.forEach((id, row) => {
      out[id] = { x: origin.x + Number(col) * colWidth, y: Math.round(origin.y + (row - (ids.length - 1) / 2) * rowHeight) };
    });
  }
  return out;
}

export function waitSeconds(config) {
  const n = Number(config && config.amount);
  if (!Number.isFinite(n) || n < 0) return 0;
  const unit = { seconds: 1, minutes: 60, hours: 3600, days: 86400 }[config.unit] || 60;
  return Math.round(n * unit);
}

function triggerProblems(trigger) {
  const c = trigger.config || {};
  if (trigger.type === 'schedule') {
    if (c.mode === 'cron') {
      if (String(c.cron || '').trim().split(/\s+/).length !== 5) return ['a cron schedule has five parts, like "0 9 * * *"'];
    } else if (c.mode === 'daily') {
      if (!/^\d{1,2}:\d{2}$/.test(String(c.time || ''))) return ['pick the time of day, like 09:00'];
      if (!Array.isArray(c.days) || !c.days.length) return ['pick at least one day'];
    } else if (!(Number(c.every) >= 1)) {
      return ['"every" must be 1 or more'];
    }
  }
  if (trigger.type === 'whatsapp' || trigger.type === 'email') {
    if (!String(c.connection || '').trim()) return ['pick the connection to listen on'];
    if (trigger.type === 'whatsapp' && c.match && c.match !== 'any' && !String(c.text || '').trim()) return ['say which text to look for'];
  }
  if (trigger.type === 'table' && !c.table) return ['pick the table to watch'];
  return [];
}

function configProblems(step) {
  const c = step.config || {};
  switch (step.type) {
    case 'code':
      return String(c.code || '').trim() ? [] : ['has no code'];
    case 'http':
      return String(c.url || '').trim() ? [] : ['needs a URL'];
    case 'if':
      return Array.isArray(c.conditions) && c.conditions.length ? [] : ['needs at least one condition'];
    case 'switch': {
      const cases = Array.isArray(c.cases) ? c.cases : [];
      const ids = cases.map(x => String(x.id));
      if (ids.some(id => !ID.test(id) || id === 'default')) return ['every case needs a simple id'];
      return new Set(ids).size === ids.length ? [] : ['two cases share an id'];
    }
    case 'loop':
      return String(c.items || '').trim() ? [] : ['needs the list to go over'];
    case 'wait':
      return waitSeconds(c) <= LIMITS.waitMaxDays * 86400 ? [] : [`can wait at most ${LIMITS.waitMaxDays} days`];
    case 'call':
      return c.automationId ? [] : ['pick the automation to run'];
    case 'whatsapp':
    case 'approval': {
      const out = [];
      if (!String(c.connection || '').trim()) out.push('pick the WhatsApp connection to send from');
      if (!String(c.to || '').trim()) out.push('needs who to send to');
      if (!String(c.text || '').trim()) out.push(step.type === 'approval' ? 'needs the question to ask' : 'needs the text to send');
      return out;
    }
    case 'email': {
      const out = [];
      if (!String(c.connection || '').trim()) out.push('pick the mailbox to send from');
      if (!String(c.to || '').trim()) out.push('needs who to send to');
      return out;
    }
    case 'email_search':
      return String(c.connection || '').trim() ? [] : ['pick the mailbox to look in'];
    case 'table': {
      if (!c.table) return ['pick the table'];
      if (!['find', 'add', 'update'].includes(c.action || 'find')) return ['the action is find, add or update'];
      if (c.action === 'update' && !String(c.rowId || '').trim()) return ['needs the row to update'];
      return [];
    }
    case 'agent': {
      const out = [];
      if (!c.agentId) out.push('pick the AI Chatbot to ask');
      if (!String(c.message || '').trim()) out.push('needs what to ask');
      return out;
    }
    case 'ai':
      return String(c.prompt || '').trim() ? [] : ['needs a prompt'];
    default:
      return [];
  }
}

/** A step id nothing uses yet: http_1, http_2… */
export function freshId(def, type) {
  const used = new Set((def.steps || []).map(s => s.id));
  for (let n = 1; ; n++) {
    const id = `${type}_${n}`;
    if (!used.has(id)) return id;
  }
}

/* ─────────────────── conditions ─────────────────── */

export const OPS = ['eq', 'neq', 'contains', 'not_contains', 'starts', 'ends', 'gt', 'gte', 'lt', 'lte', 'empty', 'not_empty'];

const isBlank = (v) => v === null || v === undefined || v === '' ||
  (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);

const num = (v) => (typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : null));

/** One comparison. Two things that both read as numbers compare as numbers. */
export function compare(left, op, right) {
  if (op === 'empty') return isBlank(left);
  if (op === 'not_empty') return !isBlank(left);
  const ln = num(left), rn = num(right);
  const both = ln !== null && rn !== null;
  const ls = asText(left), rs = asText(right);
  switch (op) {
    case 'eq': return both ? ln === rn : ls === rs;
    case 'neq': return both ? ln !== rn : ls !== rs;
    case 'contains': return Array.isArray(left) ? left.some(x => asText(x) === rs) : ls.includes(rs);
    case 'not_contains': return Array.isArray(left) ? !left.some(x => asText(x) === rs) : !ls.includes(rs);
    case 'starts': return ls.startsWith(rs);
    case 'ends': return ls.endsWith(rs);
    case 'gt': return both ? ln > rn : ls > rs;
    case 'gte': return both ? ln >= rn : ls >= rs;
    case 'lt': return both ? ln < rn : ls < rs;
    case 'lte': return both ? ln <= rn : ls <= rs;
    default: throw new Error(`Unknown comparison "${op}"`);
  }
}

/** `[{ key, value }]` → an object, skipping rows with no key. */
export function fieldsToObject(fields, scope) {
  const out = {};
  for (const f of Array.isArray(fields) ? fields : []) {
    const key = String((f && f.key) || '').trim();
    if (key) out[key] = resolve(f.value, scope);
  }
  return out;
}
