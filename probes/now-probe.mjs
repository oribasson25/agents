/**
 * What every AI Chatbot is told about the date.
 *
 * A model has no clock, so this goes into the system prompt of every turn
 * rather than being a tool it may or may not call. Two things have to hold: it
 * must be right about the zone, including across the day Israel changes its
 * clocks; and the browser's copy must say exactly what the server's says, or
 * the test chat tells you about a chatbot you do not have.
 */
import fs from 'fs';

let failed = 0;
const ok = (cond, label, detail = '') => {
  if (cond) console.log(`✓ ${label}`);
  else { console.log(`✗ ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
};

const { nowBlock, PLATFORM_TZ } = await import(new URL('../api/_now.js', import.meta.url).href);

ok(PLATFORM_TZ === 'Asia/Jerusalem', 'the platform has one fixed zone, not the machine\'s', PLATFORM_TZ);

const summer = nowBlock(new Date('2026-09-20T19:41:00Z'));
ok(summer.includes('## Right now'), 'it is a titled block the prompt can hold');
ok(summer.includes('Sunday'), 'it names the weekday — a working day here is not a working day everywhere');
ok(summer.includes('20 September 2026'), 'and the date in words');
ok(summer.includes('22:41'), 'the time is the local time, not the machine\'s', summer);
ok(summer.includes('Today is 2026-09-20'), 'the day is given as a date a table can take');
ok(summer.includes('Tomorrow is 2026-09-21'), 'and so is tomorrow, which models get wrong unaided');
ok(/Never answer a question about the date or the time from your training/.test(summer),
   'and it is told not to answer from training');

/* ── the zone, including the days it changes ── */
ok(nowBlock(new Date('2026-09-20T19:41:00Z')).includes('GMT+03:00'), 'summer here is UTC+3');
ok(nowBlock(new Date('2026-01-15T12:00:00Z')).includes('GMT+02:00'), 'winter here is UTC+2');

// 21:30 UTC is already the next day in Jerusalem; a block that reports the
// machine's day would say the 20th and book someone in yesterday.
const past = nowBlock(new Date('2026-09-20T21:30:00Z'));
ok(past.includes('Today is 2026-09-21') && past.includes('Monday'),
   'an instant that is tomorrow here is reported as tomorrow', past.split('\n')[2]);

/* ── the browser says the same words ── */
const src = fs.readFileSync(new URL('../agentforge.html', import.meta.url), 'utf8');
const a = src.indexOf("  const PLATFORM_TZ = 'Asia/Jerusalem';");
const b = src.indexOf('\n  function buildSystemPrompt(agent, ragChunks = [], webChunks = []) {', a);
ok(a > 0 && b > a, 'the browser carries its own copy');
const browser = new Function(`${src.slice(a, b)}\nreturn { nowBlock, PLATFORM_TZ };`)();
ok(browser.PLATFORM_TZ === PLATFORM_TZ, 'in the same zone');
for (const when of ['2026-09-20T19:41:00Z', '2026-01-15T12:00:00Z', '2026-09-20T21:30:00Z', '2026-03-27T00:30:00Z']) {
  const same = browser.nowBlock(new Date(when)) === nowBlock(new Date(when));
  ok(same, `and word for word at ${when}`, browser.nowBlock(new Date(when)));
}

/* ── and every chatbot actually gets it ── */
const runner = fs.readFileSync(new URL('../api/_agentRunner.js', import.meta.url), 'utf8');
ok(/let system = `\$\{nowBlock\(\)\}/.test(runner),
   'the widget and WhatsApp prompt opens with it');
ok(src.includes('let system = `${nowBlock()}'), 'the test chat prompt opens with it');
ok(/nowBlock\(\),\n      '',\n      PLATFORM_REFERENCE/.test(src),
   'and so does the platform assistant, which writes dates into tables');
ok(!/table_|tool/i.test(String(nowBlock)) , 'it is not a tool a model has to remember to call');

console.log(`\n${failed ? `${failed} FAILURE(S)` : 'all green'}`);
process.exit(failed ? 1 : 0);
