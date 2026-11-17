/**
 * Turns an automation into a folder of files and back again.
 *
 * The same contract `_agentFiles.js` and `_appFiles.js` keep:
 *
 *     filesToAutomation(automationToFiles(a, id), { id }).automation  deep-equals  a
 *
 * for any `a` that came out of `checkAutomation`. A push runs the second half,
 * so a field this forgets is a field a push deletes; the probe checks it.
 *
 *   automation.json   what it does: the trigger, the steps, how they connect
 *   steps/<id>.py     the code of each Code step, as a file an editor can run
 *   layout.json       where each step sits on the canvas — and nothing else
 *
 * Where a step sits is kept apart on purpose. It changes whenever someone
 * drags a box, means nothing to the logic, and would bury every real change
 * in a diff. Delete the file, or leave a new step out of it, and the platform
 * places the step itself.
 *
 * Secrets are not here, and neither is whether the automation is switched on
 * or its webhook address: those belong to the platform, not to the folder.
 */
import { json, parseJson } from './_agentFiles.js';
import { checkAutomation, portsOf, TRIGGER_ID, STEPS, TRIGGERS } from './_automationSpec.js';

/* Files the platform writes into the folder; an automation cannot have its own. */
const GENERATED = new Set(['AGENTS.md', 'CLAUDE.md', '.gitignore']);
const CODE = /^steps\/([a-z][a-z0-9_]{0,39})\.py$/;

/* ─────────────────── automation → files ─────────────────── */

export function automationToFiles(def, id) {
  const files = {};
  const layout = { [TRIGGER_ID]: def.trigger.position };
  const steps = [];
  for (const s of def.steps || []) {
    layout[s.id] = s.position;
    const { code, ...config } = s.config || {};
    const step = { id: s.id, type: s.type, name: s.name || '' };
    if (s.type === 'code') {
      files[`steps/${s.id}.py`] = String(code || '');
      step.config = config;
    } else {
      step.config = s.config || {};
    }
    if (s.onError === 'continue') step.onError = 'continue';
    if (s.retries) step.retries = s.retries;
    steps.push(step);
  }
  files['automation.json'] = json({
    version: '1.0',
    id,
    name: def.name || '',
    description: def.description || '',
    trigger: { type: def.trigger.type, config: def.trigger.config || {} },
    steps,
    /* "out" is the port almost every connection leaves by; it goes unsaid. */
    edges: (def.edges || []).map(e => (e.port && e.port !== 'out' ? { from: e.from, port: e.port, to: e.to } : { from: e.from, to: e.to })),
  });
  files['layout.json'] = json(layout);
  files['.gitignore'] = ['.8legs/', '__pycache__/', '*.log', '.DS_Store', ''].join('\n');
  files['AGENTS.md'] = AGENTS_MD;
  files['CLAUDE.md'] = '@AGENTS.md\n';
  return files;
}

/* ─────────────────── files → automation ─────────────────── */

/**
 * The automation a folder describes, or everything wrong with the folder.
 *
 * Stricter than the canvas: the canvas quietly drops a connection to a step
 * that was just deleted, because that is what deleting a step means. In a
 * file, a connection to a step that is not there is a typo, and saying
 * nothing would make the push do something other than what was written.
 */
export function filesToAutomation(files, existing = {}) {
  const errors = [];
  const config = parseJson(files, 'automation.json', errors);
  if (!config) return { automation: null, errors };
  if (typeof config !== 'object' || Array.isArray(config)) {
    return { automation: null, errors: ['automation.json must be an object'] };
  }
  if (existing.id && config.id && config.id !== existing.id) {
    errors.push('automation.json: id does not match this automation — it must not be changed');
  }

  let layout = {};
  if (files['layout.json'] !== undefined) {
    const parsed = parseJson(files, 'layout.json', errors);
    if (parsed && (typeof parsed !== 'object' || Array.isArray(parsed))) errors.push('layout.json must be an object of step id → { x, y }');
    else if (parsed) layout = parsed;
  }

  const trigger = config.trigger && typeof config.trigger === 'object' ? config.trigger : {};
  if (!TRIGGERS[trigger.type]) errors.push(`automation.json: trigger.type must be one of ${Object.keys(TRIGGERS).join(', ')}`);

  if (config.steps !== undefined && !Array.isArray(config.steps)) errors.push('automation.json: steps must be a list');
  const list = Array.isArray(config.steps) ? config.steps : [];
  const steps = [];
  const byId = new Map();
  list.forEach((s, i) => {
    if (!s || typeof s !== 'object') { errors.push(`automation.json: steps[${i}] must be an object`); return; }
    const step = {
      id: s.id, type: s.type, name: s.name || '',
      config: s.config && typeof s.config === 'object' ? { ...s.config } : {},
      position: layout[s.id],
      onError: s.onError, retries: s.retries,
    };
    if (s.type === 'code') {
      const path = `steps/${s.id}.py`;
      if (files[path] === undefined) errors.push(`${path} is missing (the code of the step "${s.id}")`);
      else if (typeof files[path] !== 'string') errors.push(`${path} is not text`);
      else step.config = { ...step.config, code: files[path] };
    }
    steps.push(step);
    if (typeof s.id === 'string') byId.set(s.id, step);
  });

  for (const path of Object.keys(files)) {
    if (GENERATED.has(path) || path === 'automation.json' || path === 'layout.json') continue;
    if (path.startsWith('.8legs/') || path.startsWith('.git/')) continue;
    const m = CODE.exec(path);
    if (m && byId.has(m[1]) && byId.get(m[1]).type === 'code') continue;
    if (m) errors.push(`${path} has no Code step called "${m[1]}" in automation.json`);
    else errors.push(`${path} is not part of an automation — it holds automation.json, layout.json and steps/<id>.py`);
  }

  if (config.edges !== undefined && !Array.isArray(config.edges)) errors.push('automation.json: edges must be a list');
  const edges = [];
  (Array.isArray(config.edges) ? config.edges : []).forEach((e, i) => {
    const edge = { from: String((e && e.from) || ''), port: String((e && e.port) || 'out'), to: String((e && e.to) || '') };
    const from = edge.from === TRIGGER_ID ? { id: TRIGGER_ID } : byId.get(edge.from);
    if (!from) { errors.push(`automation.json: edges[${i}] leaves "${edge.from}", which is not a step`); return; }
    if (!byId.has(edge.to)) { errors.push(`automation.json: edges[${i}] leads to "${edge.to}", which is not a step`); return; }
    if (STEPS[from.type] || from.id === TRIGGER_ID) {
      const ports = portsOf(from);
      if (!ports.includes(edge.port)) {
        errors.push(`automation.json: edges[${i}] leaves "${edge.from}" by "${edge.port}"; it has ${ports.length ? ports.map(p => `"${p}"`).join(', ') : 'no way out'}`);
        return;
      }
    }
    edges.push(edge);
  });

  const { automation, structural } = checkAutomation({
    name: config.name || existing.name || '',
    description: config.description || '',
    trigger: { type: trigger.type, config: trigger.config, position: layout[TRIGGER_ID] },
    steps, edges,
  });
  for (const problem of structural) if (!errors.includes(problem)) errors.push(problem);
  if (errors.length) return { automation: null, errors };
  return { automation, errors: [] };
}

const AGENTS_MD = `# 8Legs automation

This folder is one automation on [8legs.world](https://www.8legs.world): a
trigger, then steps that run in order. Edit the files, then \`8legs push\`.

| What to change | Where |
|---|---|
| The trigger, the steps, how they connect | \`automation.json\` |
| The Python of a Code step | \`steps/<step id>.py\` |
| Where the boxes sit on the canvas | \`layout.json\` (optional — leave a step out and the platform places it) |

## Draft, test, publish

\`8legs push\` saves the **draft**. Nothing live changes.
\`8legs run\` runs the draft once, for real, and prints what every step returned.
\`8legs publish\` (or \`8legs push --publish\`) makes the draft what the trigger fires.
\`8legs versions\` lists what was published; \`8legs rollback <n>\` puts one back.

With git: \`main\` is what is published. A \`git push\` to main that validates
is published at once; one that does not is marked failed and changes nothing.

## automation.json

\`\`\`json
{
  "id": "…never change this…",
  "name": "New lead follow-up",
  "trigger": { "type": "webhook", "config": { "respond": "now" } },
  "steps": [
    { "id": "score", "type": "code", "name": "Score the lead",
      "config": { "inputs": [{ "key": "lead", "value": "{{trigger.body}}" }] } },
    { "id": "hot", "type": "if", "name": "Hot?",
      "config": { "match": "all", "conditions": [{ "left": "{{score.score}}", "op": "gte", "right": 80 }] } },
    { "id": "crm", "type": "http", "name": "Add to CRM",
      "config": { "method": "POST", "url": "https://api.example.com/leads",
                  "auth": { "type": "bearer", "token": "{{secrets.CRM_TOKEN}}" },
                  "bodyType": "json", "body": "{\\"name\\": \\"{{trigger.body.name}}\\"}" } }
  ],
  "edges": [
    { "from": "trigger", "to": "score" },
    { "from": "score", "to": "hot" },
    { "from": "hot", "port": "yes", "to": "crm" }
  ]
}
\`\`\`

A step \`id\` is lowercase letters, digits and \`_\`. Other steps refer to the
step by it, so renaming one means updating every \`{{id.…}}\` that reads it.

### Triggers

| type | config | what steps read |
|---|---|---|
| \`manual\` | \`fields: [{ key, value }]\` — the inputs, with example values | \`{{trigger.<key>}}\` |
| \`webhook\` | \`respond\`: \`"now"\` or \`"wait"\` (answer with the Output); \`secret\`: a secret's name to require in \`X-Hook-Secret\` | \`{{trigger.body}}\`, \`.query\`, \`.headers\`, \`.method\` |
| \`schedule\` | \`mode: "every"\` + \`every\`, \`unit\` (minutes/hours/days) · \`mode: "daily"\` + \`time\` ("09:00"), \`days\` (0=Sunday) · \`mode: "cron"\` + \`cron\`. Israel time. | \`{{trigger.scheduledFor}}\` |
| \`whatsapp\` | \`connection\`: a WhatsApp connection's name; \`match\`: \`"any"\`, \`"contains"\` or \`"starts"\` + \`text\`; \`from\`: phone numbers to listen to (empty = everyone); \`alsoChatbot\`: true to let the number's chatbot answer too | \`{{trigger.from}}\`, \`.name\`, \`.text\` |
| \`email\` | \`connection\`: a Gmail or Microsoft 365 connection's name; \`query\`: only mail matching this search | \`{{trigger.from}}\`, \`.subject\`, \`.text\`, \`.id\` |
| \`table\` | \`table\`: a Table's id — fires for each row added to it | \`{{trigger.row.<column>}}\`, \`{{trigger.rowId}}\` |

### Steps

| type | config | ways out | returns |
|---|---|---|---|
| \`code\` | \`inputs: [{ key, value }]\`, \`packages\` (pip, comma separated) — the code is \`steps/<id>.py\` | out | whatever \`run\` returns |
| \`http\` | \`method\`, \`url\`, \`params\`, \`headers\` (\`[{ key, value, on }]\`), \`auth\` (\`none\`/\`bearer\`/\`basic\`/\`apikey\`), \`bodyType\` (\`none\`/\`json\`/\`form\`/\`text\`), \`body\`, \`form\`, \`timeout\`, \`failOnStatus\` | out | \`status\`, \`ok\`, \`headers\`, \`body\` |
| \`if\` | \`match\` (\`all\`/\`any\`), \`conditions: [{ left, op, right }]\` — op: eq, neq, contains, not_contains, starts, ends, gt, gte, lt, lte, empty, not_empty | yes, no | \`result\` |
| \`switch\` | \`value\`, \`cases: [{ id, value }]\` | each case id, default | \`case\` |
| \`loop\` | \`items\` — a list | each, done | \`count\`, \`results\` |
| \`wait\` | \`amount\`, \`unit\` (seconds/minutes/hours/days) | out | |
| \`set\` | \`fields: [{ key, value }]\` | out | the fields |
| \`call\` | \`automationId\`, \`fields\` — runs another published automation | out | its Output |
| \`output\` | \`fields\` — what the automation returns | (none) | the fields |
| \`whatsapp\` | \`connection\`, \`to\` (a phone number with country code, or a group id), \`text\` | out | \`queued\`, \`to\` |
| \`approval\` | \`connection\`, \`to\`, \`text\`, \`timeoutHours\` — asks a person on WhatsApp and waits for yes or no | yes, no, timeout | \`answer\`, \`text\` |
| \`wa_reply\` | \`connection\`, \`from\` (the person's phone number), \`amount\`, \`unit\` (minutes/hours/days) — waits for that person's next WhatsApp message. It sends nothing: put a \`whatsapp\` step before it to ask. | reply, timeout | \`text\`, \`replied\`, \`from\`, \`name\` |
| \`email\` | \`connection\`, \`to\`, \`subject\`, \`body\`, \`cc\` | out | \`id\` |
| \`email_search\` | \`connection\`, \`query\`, \`limit\` | out | \`messages\` (from, subject, text, id) |
| \`table\` | \`table\` (id), \`action\`: \`find\` (\`q\`, \`limit\`), \`add\` (\`fields\`), \`update\` (\`rowId\`, \`fields\`) | out | \`rows\` / \`row\` |
| \`agent\` | \`agentId\`, \`message\` — asks one of your AI Chatbots | out | \`text\` |
| \`ai\` | \`prompt\`, \`json\` (true to get an object back), \`model\` (optional) | out | \`text\`, or the object |

Any step may also carry \`"onError": "continue"\` (the next step reads the
failure as \`{{id.error}}\`) and \`"retries": 1..3\`.

### References

A value reads an earlier step as \`{{step_id.field.deeper[0]}}\`, the trigger
as \`{{trigger.…}}\`, a secret as \`{{secrets.NAME}}\`, and inside a loop
\`{{item}}\` and \`{{index}}\`. A value that is nothing but one reference keeps
its type (a number stays a number, a list a list); inside longer text it is
written in as text.

A loop's body is every step reached from its \`each\` port. Nothing outside
the loop may connect into it.

## A Code step

\`\`\`python
import os

def run(**inputs):
    lead = inputs["lead"]            # the step's inputs, by key
    token = os.environ["CRM_TOKEN"]  # the automation's secrets
    return {"score": 90}             # a dict, list, number or text
\`\`\`

\`{{ }}\` is never filled in inside the code — pass values in through \`inputs\`.

## Rules

- **Never change \`id\`** in automation.json. It is how the platform matches this folder to the automation.
- **Secrets never land here.** Set them in the platform (Settings, on the automation) and refer to them by name.
- A \`connection\` is named, not copied: the account behind it is connected in the platform, under Connections.
- Only \`automation.json\`, \`layout.json\` and \`steps/<id>.py\` are carried; any other file is refused.
- Run \`8legs validate\` before pushing.
`;
