/**
 * When a schedule trigger fires next.
 *
 * Three ways to say it — every N minutes or hours, at a time on chosen days,
 * or five-part cron — and one clock: the platform's zone, so "09:00" means
 * nine in Israel in summer and in winter, whatever zone the function runs in.
 */
import { PLATFORM_TZ } from './_now.js';

const MINUTE = 60 * 1000;

/** The wall-clock parts of an instant in a zone. */
function partsIn(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  });
  const p = Object.fromEntries(f.formatToParts(date).map(x => [x.type, x.value]));
  return {
    minute: Number(p.minute), hour: Number(p.hour), day: Number(p.day), month: Number(p.month),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday),
  };
}

/** One cron field as the set of values it allows. */
function fieldSet(field, min, max) {
  const out = new Set();
  for (const part of String(field).split(',')) {
    const [range, stepRaw] = part.split('/');
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) throw new Error(`"${field}" is not a valid schedule part`);
    let lo, hi;
    if (range === '*') { lo = min; hi = max; }
    else if (range.includes('-')) { [lo, hi] = range.split('-').map(Number); }
    else { lo = Number(range); hi = stepRaw === undefined ? lo : max; }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`"${field}" is not a valid schedule part`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('A cron schedule has five parts, like "0 9 * * *"');
  const weekdays = fieldSet(parts[4].replace(/7/g, '0'), 0, 6);
  return {
    minutes: fieldSet(parts[0], 0, 59),
    hours: fieldSet(parts[1], 0, 23),
    days: fieldSet(parts[2], 1, 31),
    months: fieldSet(parts[3], 1, 12),
    weekdays,
  };
}

/** The first minute after `after` a cron schedule allows. Null if none within a year. */
export function nextCron(expr, after = new Date(), tz = PLATFORM_TZ) {
  const c = parseCron(expr);
  let at = new Date(Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE);
  const end = at.getTime() + 366 * 24 * 60 * MINUTE;
  while (at.getTime() < end) {
    const p = partsIn(at, tz);
    if (!c.months.has(p.month) || !c.days.has(p.day) || !c.weekdays.has(p.weekday)) {
      /* Wrong day: jump to the next local midnight (an hour at a time, so a
         clock change cannot make it overshoot). */
      at = new Date(at.getTime() + (60 - p.minute) * MINUTE);
      continue;
    }
    if (!c.hours.has(p.hour)) { at = new Date(at.getTime() + (60 - p.minute) * MINUTE); continue; }
    if (c.minutes.has(p.minute)) return at;
    at = new Date(at.getTime() + MINUTE);
  }
  return null;
}

/** A schedule trigger's settings as a cron line, when it is not an interval. */
export function cronOf(config) {
  const c = config || {};
  if (c.mode === 'cron') return String(c.cron || '').trim();
  if (c.mode === 'daily') {
    const [h, m] = String(c.time || '09:00').split(':').map(Number);
    const days = Array.isArray(c.days) && c.days.length && c.days.length < 7 ? c.days.join(',') : '*';
    return `${m || 0} ${h || 0} * * ${days}`;
  }
  return null;
}

/**
 * The next firing of a schedule trigger after `after`.
 *
 * An interval counts from the last firing, so "every 2 hours" does not creep
 * later by however long each run took to start.
 */
export function nextRun(config, after = new Date(), tz = PLATFORM_TZ) {
  const c = config || {};
  const cron = cronOf(c);
  if (cron) return nextCron(cron, after, tz);
  const every = Math.max(1, Math.round(Number(c.every) || 1));
  const unit = { minutes: 1, hours: 60, days: 1440 }[c.unit] || 60;
  return new Date(Math.floor(after.getTime() / MINUTE) * MINUTE + every * unit * MINUTE);
}
