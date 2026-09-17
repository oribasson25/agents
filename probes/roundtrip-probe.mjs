/**
 * The contract: filesToAgent(agentToFiles(a), a) must give back `a`.
 * A field this loses is a field a push deletes from a live agent.
 */
import { agentToFiles, filesToAgent, agentVersion } from '../api/_agentFiles.js';

/* Walks both shapes and reports what was lost, changed, or invented. */
function compare(src, out, path = '', found = { lost: [], changed: [], added: [] }) {
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  if (Array.isArray(src) && Array.isArray(out)) {
    if (src.length !== out.length) found.changed.push(`${path}: length ${src.length} -> ${out.length}`);
    else src.forEach((v, i) => compare(v, out[i], `${path}[${i}]`, found));
  } else if (isObj(src) && isObj(out)) {
    for (const k of Object.keys(src)) {
      if (!(k in out)) found.lost.push(`${path}.${k}`);
      else compare(src[k], out[k], `${path}.${k}`, found);
    }
    for (const k of Object.keys(out)) if (!(k in src)) found.added.push(`${path}.${k} = ${JSON.stringify(out[k])}`);
  } else if (JSON.stringify(src) !== JSON.stringify(out)) {
    found.changed.push(`${path}: ${JSON.stringify(src)} -> ${JSON.stringify(out)}`);
  }
  return found;
}

const minimal = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'New Agent', avatar: '🤖', openingMessage: 'Hello!', basePrompt: '',
  skills: [], tools: [],
  apiConfig: { provider: 'claude', apiKey: 'sk-ant-secret', model: 'claude-sonnet-4-5', ollamaHost: '' },
  dlp: { creditCard: false, israeliId: false },
  scrapeUrls: [], emailEnabled: false,
  whatsapp: { enabled: false, phoneNumberId: '', accessToken: '', appSecret: '', verifyToken: '' },
  createdAt: '2026-01-01T00:00:00.000Z',
};

const full = {
  ...minimal,
  id: '804fe690-c8b6-4e3a-bb8f-1305bd1721d7',
  name: 'ביטוח רכב',
  avatar: '🚗',
  openingMessage: 'שלום! האם אתה מבוטח ברכב?',
  basePrompt: '## Role\nYou are an insurance agent.\n\n## Rules\n- Be brief.\n',
  skills: [
    { id: 's1', name: 'Gematria Lookup', description: 'value of a word', prompt: '# Gematria\nAsk for the word.\n' },
    { id: 's2', name: 'תמחור', description: 'quotes', prompt: '# Pricing\nהסבר מחיר.\n' },
    { id: 's3', name: 'תמחור', description: 'duplicate display name', prompt: 'second\n' },
    { id: 's4', name: '', description: 'no name at all', prompt: '' },
  ],
  tools: [
    { id: 't1', name: 'fetch_weather', description: 'Forecast', parameters: [
        { name: 'city', type: 'string', description: 'City name' },
        { name: 'days', type: 'integer', description: '' }],
      packages: 'requests\nbeautifulsoup4', envVars: [{ key: 'WEATHER_KEY', value: 'super-secret' }],
      code: 'import requests\n\ndef run(**kwargs):\n    return {"ok": True}\n' },
    { id: 't2', name: 'fetch_weather', description: 'same name, different tool', parameters: [],
      packages: '', envVars: [], code: 'def run(**kwargs):\n    pass\n' },
  ],
  dlp: { creditCard: true, israeliId: true },
  scrapeUrls: ['https://example.com', 'https://example.com/faq'],
  emailEnabled: true,
  whatsapp: { enabled: true, phoneNumberId: '123456789012345', accessToken: 'EAAG-secret',
              appSecret: 'app-secret', verifyToken: 'verify-secret' },
  crawlConfig: { urls: ['https://example.com'], maxPages: 40, status: 'done',
                 lastCrawledAt: '2026-09-01T10:00:00.000Z', pagesCrawled: 37,
                 errorMessage: null, stoppedEarly: false, thinPages: 2 },
};

/* Fields the platform does not have today but might add tomorrow, plus a
   legacy singular field the server still reads in six places. */
const withUnknowns = {
  ...full,
  scrapeUrl: 'https://legacy-single-url.example.com',
  _seededFrom: 'admin@8legs.world',
  voiceConfig: { provider: 'elevenlabs', voiceId: 'abc123', speed: 1.1 },
  futureFlag: true,
  skills: full.skills.map((s, i) => i === 0 ? { ...s, newSkillField: ['a', 'b'] } : s),
  tools: full.tools.map((t, i) => i === 0 ? { ...t, timeoutMs: 9000 } : t),
};

const cases = [
  ['minimal (a freshly created agent)', minimal],
  ['full (Hebrew, duplicate names, secrets, crawl state)', full],
  ['with unknown + legacy fields', withUnknowns],
  ['no crawlConfig, no whatsapp block', { ...minimal, whatsapp: undefined, crawlConfig: undefined }],
  ['empty skills/tools arrays absent entirely', { id: 'x1', name: 'bare', basePrompt: 'hi' }],
];

let failed = 0;
for (const [label, source] of cases) {
  const agent = JSON.parse(JSON.stringify(source));   // drop undefined, like JSONB does
  const files = agentToFiles(agent);
  const { agent: back, errors } = filesToAgent(files, agent);

  if (errors.length) { console.log(`✗ ${label}\n    validation: ${errors.join('; ')}`); failed++; continue; }
  const { lost, changed, added } = compare(agent, back);

  if (lost.length || changed.length) {
    failed++;
    console.log(`✗ ${label}`);
    lost.forEach(p => console.log(`    LOST     ${p}`));
    changed.forEach(p => console.log(`    CHANGED  ${p}`));
    added.forEach(p => console.log(`    added    ${p}`));
  } else {
    console.log(`✓ ${label}${added.length ? `   (${added.length} default(s) filled in: ${added.join(', ')})` : ''}`);
  }
}

/* Secrets must not appear anywhere in the files. */
const files = agentToFiles(JSON.parse(JSON.stringify(withUnknowns)));
const blob = Object.values(files).join('\n');
const leaked = ['sk-ant-secret', 'super-secret', 'EAAG-secret', 'app-secret', 'verify-secret', '123456789012345']
  .filter(s => blob.includes(s));
if (leaked.length) { console.log(`✗ secrets leaked into files: ${leaked.join(', ')}`); failed++; }
else console.log('✓ no secret reaches a file');

/* The version hash must track content, not key order. */
const reordered = Object.fromEntries(Object.entries(full).reverse());
if (agentVersion(full) !== agentVersion(reordered)) { console.log('✗ version hash depends on key order'); failed++; }
else if (agentVersion(full) === agentVersion({ ...full, basePrompt: 'changed' })) {
  console.log('✗ version hash ignores a prompt change'); failed++;
} else console.log('✓ version hash tracks content');

console.log(`\n${failed ? `${failed} FAILURE(S)` : 'all green'}`);
console.log('\nfiles produced for the full agent:');
Object.keys(agentToFiles(full)).sort().forEach(p => console.log('  ' + p));
process.exit(failed ? 1 : 0);
