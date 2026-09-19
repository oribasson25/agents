/**
 * Autopilot — the rules the wizard rests on.
 *
 * The parts worth holding still are the ones that decide what a later screen
 * shows: every vertical offers a job that needs a table and a job that needs
 * email (or screens 4 and 5 have nothing to branch on), every column a table
 * is proposed with has a type the table API accepts, and the brief handed to
 * the model carries every answer — because anything missing from it is an
 * answer the person gave for nothing.
 */
import fs from 'fs';

let failed = 0;
const ok = (cond, label, detail = '') => {
  if (cond) console.log(`✓ ${label}`);
  else { console.log(`✗ ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
};

const src = fs.readFileSync(new URL('../agentforge.html', import.meta.url), 'utf8');

/* The catalog and the brief are lifted out of the page and run for real: the
   app is one file with no exports, so a probe either reads it or tests
   nothing. */
function lift(startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker, a);
  if (a < 0 || b < 0) throw new Error(`could not lift ${startMarker}`);
  return src.slice(a, b);
}

const catalogSrc = lift('const AUTOPILOT_CATALOG = {', '\n  const AUTOPILOT_COLUMNS');
const columnsSrc = lift('const AUTOPILOT_COLUMNS = {', '\n\n  /* The wizard survives');
const briefSrc = lift('function autopilotBrief(w) {', '\n  /* ── small pieces');

const L = (en, he) => en;
const uiHe = () => false;
// eslint-disable-next-line no-new-func
const { AUTOPILOT_CATALOG, AUTOPILOT_COLUMNS, AUTOPILOT_COLUMN_TYPE, autopilotBrief } =
  new Function('L', 'uiHe', `${catalogSrc}\n${columnsSrc}\n${briefSrc}\nreturn { AUTOPILOT_CATALOG, AUTOPILOT_COLUMNS, AUTOPILOT_COLUMN_TYPE, autopilotBrief };`)(L, uiHe);

const keys = Object.keys(AUTOPILOT_CATALOG);
ok(keys.length >= 5, 'there is a vertical for most people to recognise', keys.join(', '));

/* ── every vertical must be able to branch ── */
for (const k of keys) {
  const v = AUTOPILOT_CATALOG[k];
  ok(v.jobs.length >= 3, `${k}: enough jobs to choose between`, String(v.jobs.length));
  ok(v.jobs.some(j => j.table), `${k}: one job needs a table, so screen 4 has something to offer`);
  ok(v.jobs.some(j => j.email), `${k}: one job needs email, so screen 5 has something to connect`);
  ok(typeof v.name() === 'string' && v.name().length > 2, `${k}: a proposed name`);
  ok(typeof v.greeting() === 'string' && v.greeting().length > 10, `${k}: a proposed opening line`);
  ok(v.jobs.every(j => j.label() && j.hint()), `${k}: every job says what it is and what it does`);
  ok(new Set(v.jobs.map(j => j.id)).size === v.jobs.length, `${k}: job ids are distinct`);
}

/* ── a proposed table must be one the table API will take ── */
const TYPES = ['text', 'number', 'date', 'boolean'];
for (const k of Object.keys(AUTOPILOT_COLUMNS)) {
  const cols = AUTOPILOT_COLUMNS[k]();
  ok(cols.length >= 3 && cols.length <= 8, `${k}: a workable number of columns`, String(cols.length));
  ok(new Set(cols).size === cols.length, `${k}: no column is proposed twice`, cols.join(', '));
  ok(cols.every(c => TYPES.includes(AUTOPILOT_COLUMN_TYPE[c] || 'text')), `${k}: every column has a type the table accepts`);
}
// every job that asks for a table must have columns to propose, or the wizard
// falls back to a generic shape that fits nobody
for (const k of keys) {
  const job = AUTOPILOT_CATALOG[k].jobs.find(j => j.table);
  ok(!!AUTOPILOT_COLUMNS[job.id], `${k}: the table job "${job.id}" has columns of its own`, Object.keys(AUTOPILOT_COLUMNS).join(', '));
}

/* ── the brief is the only thing the model sees ── */
const answered = {
  biz: 'clinic', bizFree: 'A pilates studio with three instructors',
  jobs: { book: true, prices: true, mail: true }, jobsFree: 'Explain where to park',
  ownText: 'Mat 70, reformer 110', siteUrl: 'https://example.com', sources: { site: true },
  uploads: [{ name: 'prices.pdf' }],
  tableName: 'Appointments', tableColumns: ['Full name', 'Phone', 'Date'],
  abilities: { mail: true, web: true, human: true },
  tone: 'warm', rulesFree: 'Never promise a price',
};
const brief = autopilotBrief(answered);
for (const [what, needle] of [
  ['the vertical', 'Clinic'], ['what the owner typed', 'three instructors'],
  ['the jobs', 'Booking'], ['the extra job', 'where to park'],
  ['the facts typed in', 'reformer 110'], ['the crawled site', 'example.com'],
  ['the uploaded file', 'prices.pdf'], ['the table and its columns', 'Full name'],
  ['email', 'send email'], ['live reading', 'read a page'], ['handover', 'hand over'],
  ['the tone', 'warm'], ['the owner\'s own rule', 'Never promise a price'],
]) {
  ok(brief.includes(needle), `the brief carries ${what}`, needle);
}
ok(brief.includes('answer in that language'), 'and tells the model which language to answer in');

const bare = autopilotBrief({ ...answered, bizFree: '', jobsFree: '', ownText: '', siteUrl: '', sources: {}, uploads: [], tableName: '', tableColumns: [], abilities: {}, rulesFree: '' });
ok(!bare.includes('undefined') && !bare.includes('null'), 'an unanswered question leaves no hole in the brief', bare);
ok(bare.split('\n').every(line => line.trim()), 'and no blank lines either');

/* ── the wizard must not be reachable without its wiring ── */
ok(src.includes('function AutopilotWizard('), 'the wizard is in the page');
ok(src.includes('setAutopilot({ startStep: 0'), 'and "new chatbot" opens the fork');
ok(src.includes("setAutopilot({ startStep: 1, resumed: null })"), 'and an empty account goes straight in');
ok(src.includes('loadAutopilot()') && src.includes('gmail_connected'),
   'and the Gmail round trip comes back into the wizard, not the editor');
ok(/onAdvanced=\{existingId =>/.test(src), 'skipping hands the half-built chatbot to the editor rather than orphaning it');
ok(src.includes('sessionStorage.setItem(AUTOPILOT_KEY'), 'the answers survive leaving the page');

/* ── a tool is the exception, not the default ── */
const detect = lift('async function autopilotDetectTools(brief) {', '\n  /** The Python for one approved tool');
for (const [what, needle] of [
  ['it is told the chatbot already has knowledge', 'searchable knowledge base'],
  ['…a table', 'table it can read, add to and update'],
  ['…email', 'sending email'],
  ['…live reading', 'reading a page'],
  ['it is told to refuse by default', 'When in doubt, propose nothing'],
  ['nothing is the expected answer', 'That is the common answer'],
  ['and it is capped', 'At most two tools'],
]) {
  ok(detect.includes(needle), `the detector: ${what}`, needle);
}
ok(detect.includes('"steps"') && detect.includes('real, specific clicks'),
   'and every credential comes back with the steps to fetch it');
ok(/slice\(0, 2\)/.test(detect), 'no more than two tools reach the screen');
ok(detect.includes("return [];"), 'a detector that fails or answers rubbish proposes nothing');

const writer = lift('async function autopilotWriteTool(tool, brief) {', '\n  /** The brief the generator reads');
ok(writer.includes('def run(**kwargs)'), 'the writer is held to the shape a tool must have');
ok(writer.includes('os.environ'), 'and to taking its secrets from the environment');
ok(writer.includes('readable error string instead of raising'), 'and to failing in words a customer can read');
ok(writer.includes('which one is not set'), 'and to saying which key is missing rather than crashing');
ok(writer.includes('Never invent an endpoint'), 'and to not inventing an endpoint it does not know');

/* ── the screen only exists when it has to ── */
ok(src.includes(".filter(n => n !== 6 || w.tools.length > 0)"),
   'the connections screen is skipped when nothing needs one');
ok(src.includes('if (!asked || w.toolsChecked) { go(7); return; }'),
   'and the detector is not even called without something to read');
ok(/writtenTools\.push\(await autopilotWriteTool/.test(src) && src.includes('/* leave it out */'),
   'a tool that will not come back is dropped rather than half-saved');
ok(src.includes("(w.tools || []).some(t => t.keep)"), 'and the brief tells the skills the tool exists');

/* ── the key is asked for once, or not at all ── */
ok(src.includes(".filter(n => n !== 3 || !haveKey)"),
   'an account that already has a key is never asked for one again');
ok(src.includes('const haveKeyRef = useRef(null);') && src.includes('if (haveKeyRef.current === null && keyChecked)'),
   'and the answer is latched, so answering screen 3 does not renumber the run under you');

/* ── a filled field is not a key ── */
const verify = lift('async function verifyApiKey({ provider, apiKey, model, ollamaHost }) {', '\n  /** Did the model refuse us');
ok(verify.includes('api.anthropic.com/v1/messages') && verify.includes('max_tokens: 1'),
   'Claude is checked with the smallest call it will price');
ok(verify.includes('api.openai.com/v1/models'), 'OpenAI is checked without spending a token');
ok(verify.includes('/api/tags'), 'and a self-hosted server by asking what it has');
ok(verify.includes("return { ok: false, why:"), 'a refusal comes back in the provider\'s own words');

ok(src.includes('verifyApiKey(accountApi()).then(r =>'),
   'the account key is tried before the wizard decides to skip the key screen');
ok(/const tried = await verifyApiKey\(\{ \.\.\.patch, model: accountApi\(\)\.model \}\);[\s\S]{0,200}if \(!tried\.ok\)/.test(src),
   'and the key screen refuses to store a key the provider would not take');
ok(/const tried = await verifyApiKey\(draft\);[\s\S]{0,200}if \(!tried\.ok\)/.test(src),
   'Settings does the same, which is where the bad key got in');
ok(src.includes('looksLikeKeyProblem(error)') && src.includes("L('Fix the key', 'תקן את המפתח')"),
   'a build stopped by the key offers to fix the key rather than retrying into the same wall');
ok(src.includes('if (repairing) { setRepairing(false); go(8); build(); return; }'),
   'and a repaired key returns to the build instead of re-asking every question');
ok(src.includes('The latch is deliberately not flipped here'),
   'answering the key screen does not renumber the run that is asking it');
ok(src.includes('const questionSteps = [1, 2, 3, 4, 5, 7].filter(n => FLOW.includes(n));'),
   '"question 3 of 6" counts the questions actually being asked');
ok(src.includes('|| !settings || autopilot ||'),
   'and nothing opens by itself before the platform knows what the account has');
ok(src.includes('const after = at >= 0 ? FLOW[at + 1] : FLOW.find(n => n > w.step);'),
   'a step that leaves the flow underneath you falls forward, not back to the fork');

/* ── editing one in words, from its card ── */
ok(src.includes("onEditWithAi: () => onBuildInChat(EDIT_AGENT_ASK(a.name)),"),
   'every chatbot card can hand itself to the assistant');
ok(/function AgentCard\(\{ agent, onEdit, onEditWithAi,/.test(src) && /function AgentRow\(\{ agent, onEdit, onEditWithAi,/.test(src),
   'both the card and the row take it, so the list view is not a dead end');
ok(src.includes('EDIT_AGENT_ASK(name)') && src.includes('Read it first'),
   'and the assistant is told to read that chatbot before it asks anything');
const ask = lift('function EDIT_AGENT_ASK(name) {', '\n  /* Conversations are recognised');
ok(ask.includes('${name}') && ask.split('${name}').length === 3,
   'the chatbot is named in both languages, which also gives the conversation a title of its own');

/* ── picking which chatbot the home chat is about ── */
ok(src.includes('const agentPicker = hasAgents ? ('),
   'the home screen lists the account\'s chatbots to pick from');
ok(src.includes('setSubject(on ? null : { id: a.id, name: a.name });'),
   'picking one sets it as the subject, and picking it again clears it');
ok(/send\(subject \? L\(`About the AI Chatbot "\$\{subject\.name\}"/.test(src),
   'and the name rides in the message itself, so the transcript still says what it was about');
ok(src.includes('{subjectBar}') && src.split('{subjectBar}').length === 3,
   'the subject stays on screen in both the empty state and the conversation');
ok(src.includes('if (messages.length === 0) setSubject(null);'),
   'a new conversation starts with no subject');
ok(src.includes('paddingInlineEnd: 14') && src.includes('paddingInlineStart: 14'),
   'and the chips are padded by logical edge, so Hebrew does not put the tight side outward');

console.log(`\n${failed ? `${failed} FAILURE(S)` : 'all green'}`);
process.exit(failed ? 1 : 0);
