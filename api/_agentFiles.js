/**
 * Turns an agent into a folder of files and back again.
 *
 * The contract this module has to keep is narrow and absolute:
 *
 *     filesToAgent(agentToFiles(a), a).agent  deep-equals  a
 *
 * Every push runs the second half of that round trip against a live agent, so
 * a field this module forgets is a field a push silently deletes. Two rules
 * keep that from happening:
 *
 *   1. Anything mapped is mapped explicitly, and `probes/roundtrip-probe.mjs`
 *      checks the equality above against real agents.
 *   2. Anything NOT recognised is carried through verbatim — agent-level keys
 *      in config.json's `extras`, skill and tool keys in their own `extras`.
 *      A field added to the platform tomorrow survives a pull/push today.
 *
 * Some fields deliberately never reach a file. They are owned by the server or
 * by the account, not by the repository, and are restored from the agent that
 * is already stored:
 *
 *   apiConfig        the account's provider and key, not per-agent any more
 *   createdAt        set once, at creation
 *   whatsapp tokens  secrets; config.json references them, never holds them
 *   crawlConfig run  status/lastCrawledAt/pagesCrawled — live crawl state
 *
 * That is why filesToAgent takes the existing agent: the files are authoritative
 * for what they carry and silent about the rest.
 */
import crypto from 'crypto';

/* Fields restored from the stored agent rather than read from the files. */
const SERVER_OWNED = ['apiConfig', 'createdAt', '_seededFrom', 'seededFrom'];

/* Agent keys this module maps by hand. Anything else lands in extras. */
const MAPPED = new Set([
  'id', 'name', 'avatar', 'openingMessage', 'basePrompt', 'skills', 'tools',
  'dlp', 'scrapeUrls', 'emailEnabled', 'whatsapp', 'crawlConfig', ...SERVER_OWNED,
]);

const SKILL_MAPPED = new Set(['id', 'name', 'description', 'prompt']);
const TOOL_MAPPED = new Set(['id', 'name', 'description', 'parameters', 'packages', 'envVars', 'code']);

/* Live crawl state, kept out of the repository so a crawl is not a commit. */
const CRAWL_RUNTIME = ['status', 'lastCrawledAt', 'pagesCrawled', 'errorMessage', 'stoppedEarly', 'thinPages'];

/* ─────────────────── helpers ─────────────────── */

/**
 * A directory name for a skill or tool.
 *
 * Underscores survive, because a tool's name is the identifier the model calls
 * (`fetch_weather`) and the directory should read as the same thing. A name
 * with no ASCII at all — a skill called `תמחור` — keeps its own characters
 * rather than becoming `item-s2`: git and every filesystem we target handle
 * UTF-8 path names, and an unreadable directory helps nobody.
 */
export function slugify(name, fallbackId) {
  const raw = String(name || '').trim();
  const ascii = raw.toLowerCase().replace(/[^a-z0-9_]+/g, '-').replace(/^-+|-+$/g, '');
  if (ascii) return ascii.slice(0, 48);
  /* Keep the name, minus what a path cannot hold. */
  const kept = raw.replace(/[\/\\:*?"<>|\u0000-\u001f]+/g, '-').replace(/^[.\-]+|[.\-]+$/g, '');
  return kept.slice(0, 48) || `item-${String(fallbackId || '').slice(0, 8) || 'unnamed'}`;
}

/** Unique directory names: a collision takes a suffix from its own id. */
function uniqueSlugs(items) {
  const taken = new Map();
  const out = new Map();
  for (const item of items) {
    let slug = slugify(item.name, item.id);
    if (taken.has(slug)) slug = `${slug}-${String(item.id || taken.get(slug)).slice(0, 6)}`;
    let n = 2;
    while (taken.has(slug)) slug = `${slugify(item.name, item.id)}-${n++}`;
    taken.set(slug, item.id);
    out.set(item.id, slug);
  }
  return out;
}

/** Keys not in `mapped`, so nothing added to the platform later is lost here. */
function extrasOf(obj, mapped) {
  const extras = {};
  for (const [k, v] of Object.entries(obj || {})) if (!mapped.has(k)) extras[k] = v;
  return Object.keys(extras).length ? extras : undefined;
}

/** True when a file's package list matches the platform's string, in any order. */
function samePackages(list, str) {
  if (str === undefined) return false;
  const a = [...(list || [])].sort();
  const b = String(str || '').split(/[\s,]+/).filter(Boolean).sort();
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** JSON with sorted keys, so a version hash tracks content and not key order. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** The agent's content hash. Two agents that behave the same hash the same. */
export function agentVersion(agent) {
  return `sha256:${crypto.createHash('sha256').update(stableStringify(agent)).digest('hex').slice(0, 32)}`;
}

const json = (obj) => JSON.stringify(obj, null, 2) + '\n';

/** Drops undefined values so they never reach a file as `null`. */
function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

/* ─────────────────── agent → files ─────────────────── */

export function agentToFiles(agent) {
  const files = {};
  const skills = Array.isArray(agent.skills) ? agent.skills : [];
  const tools = Array.isArray(agent.tools) ? agent.tools : [];
  const skillSlugs = uniqueSlugs(skills);
  const toolSlugs = uniqueSlugs(tools);

  /* The base prompt is the one file a prompt change should show up in. */
  files['prompt.md'] = agent.basePrompt || '';

  skills.forEach((skill, index) => {
    const dir = `skills/${skillSlugs.get(skill.id)}`;
    files[`${dir}/prompts/skill.md`] = skill.prompt || '';
    files[`${dir}/skill.json`] = json(compact({
      id: skill.id,
      /* Directory names sort alphabetically; the agent's own order does not
         follow from them. Carrying it explicitly also lets you reorder skills
         by editing a number, which a folder layout cannot express. */
      order: index,
      name: skillSlugs.get(skill.id),
      display_name: skill.name || '',
      description: skill.description || '',
      prompts: { skill: 'prompts/skill.md' },
      extras: extrasOf(skill, SKILL_MAPPED),
    }));
  });

  tools.forEach((tool, index) => {
    const dir = `tools/${toolSlugs.get(tool.id)}`;
    files[`${dir}/run.py`] = tool.code || '';
    files[`${dir}/tool.json`] = json(compact({
      id: tool.id,
      order: index,
      name: tool.name || '',
      description: tool.description || '',
      runtime: 'python3',
      /* Stored as one string in the platform; a list reads better in a diff. */
      packages: String(tool.packages || '').split(/[\s,]+/).filter(Boolean),
      params: {
        type: 'object',
        properties: Object.fromEntries((tool.parameters || []).map(p => [
          p.name, compact({ type: p.type || 'string', description: p.description || undefined }),
        ])),
        required: (tool.parameters || []).map(p => p.name).filter(Boolean),
      },
      /* Names only. The values live in the platform, never on disk. */
      env: (tool.envVars || []).map(ev => ev.key).filter(Boolean),
      extras: extrasOf(tool, TOOL_MAPPED),
    }));
  });

  const crawl = agent.crawlConfig || {};
  const crawlExtras = Object.fromEntries(
    Object.entries(crawl).filter(([k]) => !CRAWL_RUNTIME.includes(k) && k !== 'urls' && k !== 'maxPages'));

  files['config.json'] = json(compact({
    profile: compact({
      version: '1.0',
      id: agent.id,
      name: slugify(agent.name, agent.id),
      display_name: agent.name || '',
      avatar: agent.avatar || '',
    }),
    behavior: {
      channels: {
        chat: {
          initial_message: { enabled: true, text: agent.openingMessage || '' },
          connections: {
            whatsapp: compact({
              enabled: !!(agent.whatsapp && agent.whatsapp.enabled),
              /* The number itself is a platform value; the file names it. */
              phone_number_id: agent.whatsapp && agent.whatsapp.phoneNumberId
                ? '{{global.WA_PHONE_NUMBER_ID}}' : '',
            }),
          },
        },
        email: { connections: { gmail: { enabled: !!agent.emailEnabled } } },
      },
      guardrails: {
        pii: {
          policies: [
            { name: 'Credit Card', built_in_key: 'credit_card', enabled: !!(agent.dlp && agent.dlp.creditCard) },
            { name: 'Israeli ID', built_in_key: 'israeli_id', enabled: !!(agent.dlp && agent.dlp.israeliId) },
          ],
        },
      },
    },
    knowledge: {
      crawl: compact({
        urls: Array.isArray(agent.scrapeUrls) ? agent.scrapeUrls : [],
        max_pages: crawl.maxPages,
        urls_legacy: crawl.urls,
        extras: Object.keys(crawlExtras).length ? crawlExtras : undefined,
      }),
    },
    prompts: { agent: 'prompt.md' },
    extras: extrasOf(agent, MAPPED),
  }));

  files['.gitignore'] = ['.8legs/cache/', '*.log', '.DS_Store', '__pycache__/', ''].join('\n');
  files['AGENTS.md'] = AGENTS_MD;
  files['CLAUDE.md'] = '@AGENTS.md\n';
  return files;
}

/* ─────────────────── files → agent ─────────────────── */

function parseJson(files, path, errors) {
  const raw = files[path];
  if (raw === undefined) { errors.push(`${path} is missing`); return null; }
  try { return JSON.parse(raw); }
  catch (e) { errors.push(`${path}: ${e.message}`); return null; }
}

/** Directories holding a `<name>` file, e.g. skills/*​/skill.json. */
function dirsWith(files, prefix, filename) {
  const dirs = new Set();
  for (const path of Object.keys(files)) {
    if (!path.startsWith(`${prefix}/`) || !path.endsWith(`/${filename}`)) continue;
    dirs.add(path.slice(0, -(filename.length + 1)));
  }
  return [...dirs].sort();
}

export function filesToAgent(files, existing = {}) {
  const errors = [];
  const config = parseJson(files, 'config.json', errors);
  if (!config) return { agent: null, errors };

  const profile = config.profile || {};
  const channels = (config.behavior && config.behavior.channels) || {};
  const chat = channels.chat || {};
  const wa = (chat.connections && chat.connections.whatsapp) || {};
  const policies = ((config.behavior && config.behavior.guardrails && config.behavior.guardrails.pii) || {}).policies || [];
  const policy = key => !!(policies.find(p => p.built_in_key === key) || {}).enabled;
  const crawlFile = (config.knowledge && config.knowledge.crawl) || {};

  if (!profile.id) errors.push('config.json: profile.id is required');
  if (files['prompt.md'] === undefined) errors.push('prompt.md is missing');

  const skills = [];
  const skillOrder = new Map();
  for (const dir of dirsWith(files, 'skills', 'skill.json')) {
    const sk = parseJson(files, `${dir}/skill.json`, errors);
    if (!sk) continue;
    if (!sk.id) { errors.push(`${dir}/skill.json: id is required`); continue; }
    const promptPath = `${dir}/${(sk.prompts && sk.prompts.skill) || 'prompts/skill.md'}`;
    if (files[promptPath] === undefined) { errors.push(`${promptPath} is missing`); continue; }
    skillOrder.set(sk.id, typeof sk.order === 'number' ? sk.order : Infinity);
    skills.push({
      id: sk.id,
      name: sk.display_name || '',
      description: sk.description || '',
      prompt: files[promptPath],
      ...(sk.extras || {}),
    });
  }

  const tools = [];
  const toolOrder = new Map();
  for (const dir of dirsWith(files, 'tools', 'tool.json')) {
    const tl = parseJson(files, `${dir}/tool.json`, errors);
    if (!tl) continue;
    if (!tl.id) { errors.push(`${dir}/tool.json: id is required`); continue; }
    if (files[`${dir}/run.py`] === undefined) { errors.push(`${dir}/run.py is missing`); continue; }
    const props = (tl.params && tl.params.properties) || {};
    const prior = (existing.tools || []).find(t => t.id === tl.id) || {};
    const priorEnv = new Map((prior.envVars || []).map(ev => [ev.key, ev.value]));
    toolOrder.set(tl.id, typeof tl.order === 'number' ? tl.order : Infinity);
    tools.push({
      id: tl.id,
      name: tl.name || '',
      description: tl.description || '',
      parameters: Object.entries(props).map(([name, p]) => ({
        name, type: (p && p.type) || 'string', description: (p && p.description) || '',
      })),
      /* Unchanged packages keep the platform's exact string, so a pull and
         push with no edit here leaves the field byte-for-byte as it was. */
      packages: samePackages(tl.packages, prior.packages) ? prior.packages : (tl.packages || []).join(' '),
      /* Names come from the file; values stay whatever the platform holds. */
      envVars: (tl.env || []).map(key => ({ key, value: priorEnv.get(key) || '' })),
      code: files[`${dir}/run.py`],
      ...(tl.extras || {}),
    });
  }

  if (errors.length) return { agent: null, errors };

  /* Restore the agent's own order. Anything without one keeps its position at
     the end, in directory order, so a hand-added folder is never dropped. */
  const byOrder = (map) => (a, b) => (map.get(a.id) - map.get(b.id)) || 0;
  skills.sort(byOrder(skillOrder));
  tools.sort(byOrder(toolOrder));

  const priorWa = existing.whatsapp || {};
  const priorCrawl = existing.crawlConfig || {};
  const crawlRuntime = {};
  for (const k of CRAWL_RUNTIME) if (priorCrawl[k] !== undefined) crawlRuntime[k] = priorCrawl[k];
  const crawlConfig = compact({
    urls: crawlFile.urls_legacy,
    maxPages: crawlFile.max_pages,
    ...(crawlFile.extras || {}),
    ...crawlRuntime,
  });

  const agent = compact({
    id: profile.id,
    name: profile.display_name || '',
    avatar: profile.avatar || '',
    openingMessage: (chat.initial_message || {}).text || '',
    basePrompt: files['prompt.md'],
    skills,
    tools,
    dlp: { creditCard: policy('credit_card'), israeliId: policy('israeli_id') },
    scrapeUrls: Array.isArray(crawlFile.urls) ? crawlFile.urls : [],
    emailEnabled: !!(((channels.email || {}).connections || {}).gmail || {}).enabled,
    whatsapp: {
      ...priorWa,
      enabled: !!wa.enabled,
      /* A file can turn the number off, never set one: it holds no value. */
      phoneNumberId: wa.phone_number_id ? (priorWa.phoneNumberId || '') : '',
    },
    crawlConfig: existing.crawlConfig !== undefined || Object.keys(crawlConfig).length ? crawlConfig : undefined,
    ...(config.extras || {}),
  });

  for (const key of SERVER_OWNED) if (existing[key] !== undefined) agent[key] = existing[key];
  return { agent, errors: [] };
}

const AGENTS_MD = `# 8Legs agent

This folder is one agent on [8legs.world](https://www.8legs.world). Edit the
files, then \`8legs push\` (or \`git push\`, which the platform picks up).

| What to change | Where |
|---|---|
| How the agent behaves overall | \`prompt.md\` |
| Identity, channels, guardrails | \`config.json\` |
| One capability's instructions | \`skills/<slug>/prompts/skill.md\` |
| What a skill is for, and its tools | \`skills/<slug>/skill.json\` |
| A tool's code | \`tools/<slug>/run.py\` |
| A tool's parameters and packages | \`tools/<slug>/tool.json\` |

## Rules

- **Never change an \`id\`.** It is how the platform matches this file to the
  thing it already has. Change one and you delete a skill and create another.
- **Prompts are Markdown files, never strings inside JSON.** A prompt change
  should read as a prompt change in \`git diff\`.
- **Secrets are not in this folder.** \`{{global.NAME}}\` references a value
  stored in the platform. Do not replace one with a literal.
- **Knowledge lives in the platform**, not here. Use \`8legs kb\`.
- Run \`8legs validate\` before pushing.
`;
