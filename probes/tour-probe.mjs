/**
 * The tour: what it points at, and the things about it that break silently.
 *
 * Two of those are worth a probe on their own. A target named in a step but
 * never put on an element means a ring around nothing, and nothing in the page
 * would complain. And the whole spotlight rests on dividing every measurement
 * by the `zoom` on <body> — drop that line and the ring lands 28% too small,
 * up and to the left, which looks like a styling wobble rather than a bug.
 */
import fs from 'fs';

let failed = 0;
const ok = (cond, label, detail = '') => {
  if (cond) console.log(`✓ ${label}`);
  else { console.log(`✗ ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
};

const src = fs.readFileSync(new URL('../agentforge.html', import.meta.url), 'utf8');
const lift = (from, to) => {
  const a = src.indexOf(from), b = src.indexOf(to, a);
  if (a < 0 || b < a) throw new Error(`could not lift ${from}`);
  return src.slice(a, b);
};

const stepsSrc = lift('const TOUR_STEPS = () => [', '\n  /**\n   * The very first screen');
const L = (en) => en;
const both = new Function('L', `${stepsSrc}\nreturn { steps: TOUR_STEPS(), editor: EDITOR_TOUR_STEPS('Clinic assistant') };`)(L);
const steps = both.steps;
const editor = both.editor;

ok(steps.length === 5, 'five steps in the platform tour', String(steps.length));
ok(editor.length === 5, 'and five in the editor tour', String(editor.length));

const tagged = new Set([...src.matchAll(/data-tour="([a-z-]+)"/g)].map(m => m[1]));
const navIds = ['home', 'agents', 'tables', 'interactions', 'docs', 'settings', 'admin'];

for (const [i, s] of steps.entries()) {
  const n = i + 1;
  ok(navIds.includes(s.nav), `step ${n}: goes to a screen that exists`, s.nav);
  ok(s.target.length >= 2, `step ${n}: names a fallback as well as its first choice`, s.target.join(', '));
  for (const t of s.target) {
    const exists = tagged.has(t) || (t.startsWith('nav-') && navIds.includes(t.slice(4)));
    ok(exists, `step ${n}: "${t}" is on a real element`, [...tagged].join(', '));
  }
  ok(s.target[1] === `nav-${s.nav}`, `step ${n}: the fallback is that screen's own menu item`, s.target[1]);
  ok(s.title && s.title.length > 4 && s.body && s.body.length > 60,
     `step ${n}: says something worth stopping for`, s.title);
}
ok(new Set(steps.map(s => s.nav)).size === steps.length, 'no screen is visited twice');
ok(steps[0].nav === 'home', 'it starts where the person already is');
ok(!steps.some(s2 => /flycard|weather/i.test(s2.body)),
   'the platform tour stays general — it does not name a chatbot that an account may have deleted');

/* ── the spotlight's own hazards ── */
const tour = lift('function PlatformTour({ steps, tag, onGo, onClose, onFinish, finishLabel }) {', '\n  /* ═══════════════════════ AUTOPILOT');
ok(tour.includes("Number(getComputedStyle(document.body).zoom) || 1"),
   'the zoom on <body> is read, not assumed');
ok(/r\.left \/ z.*r\.top \/ z/s.test(tour) && /r\.width \/ z/.test(tour),
   'and every measurement is divided by it');
ok(tour.includes('window.innerWidth / z') && tour.includes('window.innerHeight / z'),
   'including the viewport the dark panels are sized from');
ok(tour.includes('const beside = !fitsBelow && !fitsAbove;'),
   'a tall target puts the card beside it, never over the thing it explains');
ok(tour.includes('box-shadow: 0 0 0 9999px') || tour.includes("boxShadow: '0 0 0 9999px"),
   'the world outside the hole is one spread shadow, not four panels with seams');
ok(tour.includes('requestAnimationFrame'),
   'the ring follows the target rather than being placed once');
ok(tour.includes("el.scrollIntoView({ block: 'center'"),
   'a target below the fold is brought into view');
ok(/Math\.min\(box\.h \+ pad \* 2/.test(tour),
   'a target taller than the screen cannot squeeze the card out');
ok(tour.includes('setI(n => (n + 1 < steps.length ? n + 1 : n))') && tour.includes('2500'),
   'a step whose target never appears moves on instead of stalling');
ok(src.includes('onClose={() => { markTourSeen();') && src.includes('onClose={() => { markEditorTourSeen();'),
   'finishing or skipping either one counts as seen');

/* ── the editor tour, and what it waits for ── */
const railIds = ['configuration', 'skills', 'tools', 'knowledge', 'tables', 'manual tests', 'export', 'whatsapp'];
for (const [i, e] of editor.entries()) {
  const n = i + 1;
  ok(railIds.includes(e.tab), `editor ${n}: opens a rail tab that exists`, e.tab);
  for (const t of e.target) {
    ok(tagged.has(t) || (t.startsWith('rail-') && railIds.includes(t.slice(5))),
       `editor ${n}: "${t}" is on a real element`);
  }
  ok(e.title && e.body && e.body.length > 60, `editor ${n}: says something worth stopping for`, e.title);
}
ok(editor.some(e => e.body.includes('Clinic assistant')),
   "it is explained on the person's own chatbot, by name");
ok(editor[0].tab === 'configuration' && editor.at(-1).tab === 'manual tests',
   'it starts at the character and ends at talking to it');

const own = lift('function ownAgents(agents) {', '\n  /* ── what each tour points at ── */');
ok(own.includes('!a.seededFrom'),
   'a chatbot handed over at registration does not count as one they built');
ok(own.includes('known.includes(a.id)'),
   'and for accounts from before that marker, the ids held when the first tour ended do');
ok(src.includes("if (!tourSeen() || editorTourSeen() || mine.length === 0) return;"),
   'so the editor tour waits until there is one of their own');

const seed = fs.readFileSync(new URL('../api/_defaultAgent.js', import.meta.url), 'utf8');
ok(seed.includes('agent.seededFrom = starter.id;'),
   'the server records which starter a copy came from');
ok(fs.readFileSync(new URL('../api/_agentFiles.js', import.meta.url), 'utf8').includes("'seededFrom'"),
   'and the marker stays out of the exported files');

/* ── the question that comes before any of it ── */
const gate = lift('function LanguageGate({ onPick, busy }) {', '\n  /**\n   * The spotlight.');
ok(gate.includes("id: 'en'") && gate.includes("id: 'he'"), 'both languages are offered');
ok(gate.includes("dir: 'rtl'") && gate.includes("dir: 'ltr'"),
   'each option is written in its own direction');
ok(/Welcome to 8Legs\.ai/.test(gate) && /בחר שפה/.test(gate),
   'and the welcome is in both, because nobody can read the one they have not picked');
ok(/You can change this later in Settings/.test(gate) && /אפשר לשנות אחר כך/.test(gate),
   'and it says the choice is not final');
ok(src.includes("setTour('language');"),
   'it is the first thing a new account sees, before the tour it is about to read');
ok(src.includes("assistantLanguage: lang }); }") && src.includes("finally { setLangBusy(false); setTour('platform'); }"),
   'the answer is saved to the account and then the tour begins');
ok(src.includes('catch { setAccountApi({ assistantLanguage: lang }); }'),
   'and a failed save still lets the tour run in the language they picked');

/* ── the order the two wizards run in ── */
ok(!src.includes("if (state.agents.length > 0) { firstRunDone.current = true; return; }"),
   'Autopilot no longer waits for an empty account — registration seeds one, so that never happened');
ok(src.includes('if (tourSeen()) return;') && src.includes("setTour('platform');"),
   'the platform tour is what opens by itself now');
ok(src.includes('setAutopilot({ startStep: 1, resumed: null });') && src.includes("finishLabel={L('Build one of my own'"),
   'and the platform tour\'s last card is what hands over to Autopilot');
ok(src.includes('rememberKnownAgents(state.agents);'),
   'which is also when the account\'s chatbots are snapshotted, so what comes after is theirs');
ok(src.includes('if (isMobile) { markTourSeen(); markEditorTourSeen(); }'),
   'a phone is marked seen rather than ambushed on a desktop later');
ok(src.includes("onReplayTour('platform')") && src.includes("onReplayTour('editor')"),
   'and both can be run again from the documentation');

console.log(`\n${failed ? `${failed} FAILURE(S)` : 'all green'}`);
process.exit(failed ? 1 : 0);
