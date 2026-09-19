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

const stepsSrc = lift('const TOUR_STEPS = () => [', '\n  /**\n   * The spotlight.');
const L = (en) => en;
const steps = new Function('L', `${stepsSrc}\nreturn TOUR_STEPS();`)(L);

ok(steps.length === 5, 'five steps, as agreed — every extra one loses people', String(steps.length));

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

/* ── the spotlight's own hazards ── */
const tour = lift('function PlatformTour({ onNav, onClose, onBuild }) {', '\n  /* ═══════════════════════ AUTOPILOT');
ok(tour.includes("Number(getComputedStyle(document.body).zoom) || 1"),
   'the zoom on <body> is read, not assumed');
ok(/r\.left \/ z.*r\.top \/ z/s.test(tour) && /r\.width \/ z/.test(tour),
   'and every measurement is divided by it');
ok(tour.includes('window.innerWidth / z') && tour.includes('window.innerHeight / z'),
   'including the viewport the dark panels are sized from');
ok(tour.includes('requestAnimationFrame'),
   'the ring follows the target rather than being placed once');
ok(tour.includes("el.scrollIntoView({ block: 'center'"),
   'a target below the fold is brought into view');
ok(/Math\.min\(box\.h \+ pad \* 2/.test(tour),
   'a target taller than the screen cannot squeeze the card out');
ok(tour.includes('setI(n => (n + 1 < steps.length ? n + 1 : n))') && tour.includes('2500'),
   'a step whose target never appears moves on instead of stalling');
ok(tour.includes('markTourSeen()'), 'finishing or skipping both count as seen');

/* ── the order the two wizards run in ── */
ok(!src.includes("if (state.agents.length > 0) { firstRunDone.current = true; return; }"),
   'Autopilot no longer waits for an empty account — registration seeds one, so that never happened');
ok(src.includes('if (tourSeen()) return;') && src.includes('setTour(true);'),
   'the tour is what opens by itself now');
ok(/last \? finish\(onBuild\)/.test(tour) && src.includes("onBuild={() => setAutopilot({ startStep: 1, resumed: null })}"),
   'and its last card is what hands over to Autopilot');
ok(src.includes('if (isMobile) markTourSeen();'),
   'a phone is marked seen rather than ambushed on a desktop later');
ok(src.includes('onReplayTour={() => setTour(true)}'),
   'and it can be run again from the documentation');

console.log(`\n${failed ? `${failed} FAILURE(S)` : 'all green'}`);
process.exit(failed ? 1 : 0);
