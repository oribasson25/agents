/**
 * When a schedule trigger fires next.
 *
 * Three ways to say it — every N minutes or hours, at a time on chosen days,
 * or five-part cron — and one clock: the platform's zone, so "09:00" means
 * nine in Israel in summer and in winter, whatever zone the function runs in.
 *
 * Cron follows cron's own rules: 0 and 7 are both Sunday; when both the
 * day-of-month and the day-of-week are restricted, a day matching either
 * fires; and a wall-clock time that happens twice (the hour the clocks go
 * back) fires once, the first time.
 */
import { PLATFORM_TZ } from './_now.js';

const MINUTE = 60 * 1000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/* One formatter per zone: building an Intl.DateTimeFormat is the slow part. */
const FORMATS = new Map();
function formatFor(tz) {
  let f = FORMATS.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
    });
    FORMATS.set(tz, f);
  }
  return f;
}

/** The wall-clock parts of an instant in a zone. */
function partsIn(date, tz) {
  const p = {};
  for (const x of formatFor(tz).formatToParts(date)) p[x.type] = x.value;
  return {
    minute: Number(p.minute), hour: Number(p.hour), day: Number(p.day), month: Number(p.month), year: Number(p.year),
    weekday: WEEKDAYS.indexOf(p.weekday),
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

const restricted = (field) => String(field).trim() !== '*';

export function parseCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('A cron schedule has five parts, like "0 9 * * *"');
  /* 7 is Sunday too: read the field as 0–7, then fold 7 onto 0 (so "5-7" and
     "0-7" mean what they say). */
  const weekdays = new Set([...fieldSet(parts[4], 0, 7)].map(d => (d === 7 ? 0 : d)));
  return {
    minutes: fieldSet(parts[0], 0, 59),
    hours: fieldSet(parts[1], 0, 23),
    days: fieldSet(parts[2], 1, 31),
    months: fieldSet(parts[3], 1, 12),
    weekdays,
    /* Cron's rule: both restricted means either may match. */
    either: restricted(parts[2]) && restricted(parts[4]),
  };
}

function dayMatches(c, p) {
  if (!c.months.has(p.month)) return false;
  const dom = c.days.has(p.day);
  const dow = c.weekdays.has(p.weekday);
  return c.either ? (dom || dow) : (dom && dow);
}

const sameWallClock = (a, b) => a.minute === b.minute && a.hour === b.hour && a.day === b.day && a.month === b.month && a.year === b.year;

/** The first minute after `after` a cron schedule allows. Null if none within a year. */
export function nextCron(expr, after = new Date(), tz = PLATFORM_TZ) {
  const c = parseCron(expr);
  const minutes = [...c.minutes].sort((a, b) => a - b);
  let at = new Date(Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE);
  const end = at.getTime() + 366 * 24 * 60 * MINUTE;
  while (at.getTime() < end) {
    const p = partsIn(at, tz);
    /* Wrong day or wrong hour: on to the next local hour (an hour at a time,
       so a clock change cannot make it overshoot). */
    if (!dayMatches(c, p) || !c.hours.has(p.hour)) { at = new Date(at.getTime() + (60 - p.minute) * MINUTE); continue; }
    const next = minutes.find(m => m >= p.minute);
    if (next === undefined) { at = new Date(at.getTime() + (60 - p.minute) * MINUTE); continue; }
    if (next !== p.minute) { at = new Date(at.getTime() + (next - p.minute) * MINUTE); continue; }
    /* The hour the clocks go back happens twice; fire on the first. */
    if (sameWallClock(partsIn(new Date(at.getTime() - 60 * MINUTE), tz), p)) { at = new Date(at.getTime() + MINUTE); continue; }
    return at;
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

/** An interval schedule's period in ms; null for one that is not an interval. */
function periodOf(config) {
  const c = config || {};
  if (cronOf(c)) return null;
  const every = Math.max(1, Math.round(Number(c.every) || 1));
  const unit = { minutes: 1, hours: 60, days: 1440 }[c.unit] || 60;
  return every * unit * MINUTE;
}

/**
 * The next firing of a schedule trigger after `after`.
 *
 * For an interval, `after` is the firing it counts from (see nextRunAfter).
 */
export function nextRun(config, after = new Date(), tz = PLATFORM_TZ) {
  const c = config || {};
  const cron = cronOf(c);
  if (cron) return nextCron(cron, after, tz);
  return new Date(Math.floor(after.getTime() / MINUTE) * MINUTE + periodOf(c));
}

/**
 * The firing after one that just happened at `scheduledFor`, seen at `now`.
 *
 * An interval counts from the slot it was due at, not from when the clock got
 * to it, so "every 2 hours" does not creep later by however long each tick
 * took; a schedule that fell behind skips to the next slot still ahead, so it
 * fires once, not once per missed slot.
 */
export function nextRunAfter(config, scheduledFor, now = new Date(), tz = PLATFORM_TZ) {
  const period = periodOf(config);
  if (!period) return nextRun(config, now, tz);
  const from = scheduledFor ? new Date(scheduledFor) : now;
  let at = Math.floor(from.getTime() / MINUTE) * MINUTE + period;
  if (at <= now.getTime()) at += Math.ceil((now.getTime() - at + 1) / period) * period;
  return new Date(at);
}
