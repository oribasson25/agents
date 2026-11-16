/*
 * Time for the things a number does in a group on its own: when a schedule
 * runs next, whose birthday it is, which holiday starts tonight, and when
 * Shabbat comes in. Pure functions, no database and no network.
 */

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad = (n) => String(n).padStart(2, '0');
export const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

/** The wall-clock date and time of `date` in a time zone. */
export function localParts(date, tz) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const y = get('year'), m = get('month'), d = get('day');
  return { y, m, d, hh: get('hour'), mm: get('minute'), date: ymd(y, m, d), weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}

/** The instant at which a time zone's clocks read `dateStr` `timeStr`. */
export function zonedToUtc(dateStr, timeStr, tz) {
  const [, y, m, d] = YMD.exec(dateStr).map(Number);
  const [, hh, mm] = HHMM.exec(timeStr).map(Number);
  const wanted = Date.UTC(y, m - 1, d, hh, mm);
  // Start from "as if UTC" and correct by the zone's offset there; twice, for days the offset changes.
  let guess = wanted;
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(guess), tz);
    guess += wanted - Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
  }
  return new Date(guess);
}

const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * When a schedule runs next, strictly after `after`; null when it never will.
 * @param {{ repeat, on_date, at_time, weekdays, month_day }} s
 */
export function nextRun(s, after, tz) {
  if (!HHMM.test(s.at_time || '')) return null;
  if (s.repeat === 'once') {
    if (!YMD.test(s.on_date || '')) return null;
    const at = zonedToUtc(s.on_date, s.at_time, tz);
    return at > after ? at : null;
  }
  const start = localParts(after, tz);
  const weekdays = Array.isArray(s.weekdays) ? s.weekdays.map(Number) : [];
  for (let i = 0; i < 400; i++) {
    const day = new Date(Date.UTC(start.y, start.m - 1, start.d + i));
    const y = day.getUTCFullYear(), m = day.getUTCMonth() + 1, d = day.getUTCDate();
    if (s.repeat === 'weekly' && !weekdays.includes(day.getUTCDay())) continue;
    if (s.repeat === 'monthly' && d !== Math.min(Number(s.month_day) || 1, daysInMonth(y, m))) continue;
    const at = zonedToUtc(ymd(y, m, d), s.at_time, tz);
    if (at > after) return at;
  }
  return null;
}

/* ---------- the Hebrew calendar ---------- */

const hebFmt = new Intl.DateTimeFormat('en-u-ca-hebrew', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });

/** The Hebrew date of a civil day: { day, month: 'Tishri' … 'Elul', year }. */
export function hebrewDate(y, m, d) {
  const parts = hebFmt.formatToParts(new Date(Date.UTC(y, m - 1, d, 12)));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { day: Number(get('day')), month: get('month'), year: Number(get('year')) };
}

const isAdar = (m) => m === 'Adar' || m === 'Adar I' || m === 'Adar II';

/** Whether a Hebrew month this year is the one a date from another year falls in. */
function sameHebrewMonth(born, now) {
  if (born === now) return true;
  // Adar of a plain year is kept in Adar II of a leap year; either Adar is kept in a plain year's Adar.
  if (isAdar(born) && isAdar(now)) return now === 'Adar' || (born === 'Adar' && now === 'Adar II');
  return false;
}

function addDays(y, m, d, n) {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/**
 * Whether a yearly date falls on `today` ({ y, m, d }).
 * @param {{ day, month, year, hebrew }} row
 */
export function isAnniversary(row, today) {
  if (row.hebrew && row.year) {
    const born = hebrewDate(row.year, row.month, row.day);
    const now = hebrewDate(today.y, today.m, today.d);
    if (!sameHebrewMonth(born.month, now.month)) return false;
    if (born.day === now.day) return true;
    // The 30th of a month that has 29 days this year is kept on the 29th.
    if (born.day === 30 && now.day === 29) {
      const next = addDays(today.y, today.m, today.d, 1);
      return hebrewDate(next.y, next.m, next.d).day === 1;
    }
    return false;
  }
  if (row.month === today.m && row.day === today.d) return true;
  // 29 February is kept on the 28th in a plain year.
  return row.month === 2 && row.day === 29 && today.m === 2 && today.d === 28 && daysInMonth(today.y, 2) === 28;
}

/** How many years it has been, or null when the year is unknown. */
export function yearsSince(row, today) {
  if (!row.year) return null;
  if (row.hebrew) return hebrewDate(today.y, today.m, today.d).year - hebrewDate(row.year, row.month, row.day).year;
  return today.y - row.year;
}

// Greeted on the morning before the holiday comes in, or on the day itself for the ones without an eve.
const HOLIDAYS = [
  ['Elul', 29, 'Rosh Hashanah begins tonight', 'ערב ראש השנה'],
  ['Tishri', 9, 'Yom Kippur begins tonight', 'ערב יום כיפור'],
  ['Tishri', 14, 'Sukkot begins tonight', 'ערב סוכות'],
  ['Tishri', 21, 'Simchat Torah begins tonight', 'ערב שמחת תורה'],
  ['Kislev', 24, 'Hanukkah begins tonight: first candle', 'נר ראשון של חנוכה הערב'],
  ['Shevat', 15, 'Tu BiShvat is today', 'ט״ו בשבט'],
  ['Nisan', 14, 'Passover begins tonight', 'ערב פסח'],
  ['Nisan', 20, 'The seventh day of Passover begins tonight', 'ערב שביעי של פסח'],
  ['Iyar', 18, 'Lag BaOmer is today', 'ל״ג בעומר'],
  ['Sivan', 5, 'Shavuot begins tonight', 'ערב שבועות'],
];

/** The Jewish holidays to greet the group for on a civil day: [{ en, he }]. */
export function holidaysOn(today) {
  const h = hebrewDate(today.y, today.m, today.d);
  const weekday = new Date(Date.UTC(today.y, today.m - 1, today.d)).getUTCDay();
  const out = HOLIDAYS.filter(([month, day]) => month === h.month && day === h.day).map(([, , en, he]) => ({ en, he }));
  if (h.day === 14 && (h.month === 'Adar' || h.month === 'Adar II')) out.push({ en: 'Purim is today', he: 'פורים' });
  // Independence Day is 5 Iyar, moved so that neither it nor Memorial Day touches Shabbat.
  if (h.month === 'Iyar') {
    const moved = (h.day === 4 && weekday === 4) || (h.day === 3 && weekday === 4) || (h.day === 6 && weekday === 2);
    const plain = h.day === 5 && ![5, 6, 1].includes(weekday);
    if (moved || plain) out.push({ en: 'Israel’s Independence Day is today', he: 'יום העצמאות' });
  }
  return out;
}

/* ---------- Shabbat ---------- */

// lat, lon, and how many minutes before sunset candles are lit there by custom.
export const SHABBAT_CITIES = {
  'jerusalem': { name: 'Jerusalem', he: 'ירושלים', lat: 31.778, lon: 35.235, candles: 40 },
  'tel-aviv': { name: 'Tel Aviv', he: 'תל אביב', lat: 32.08, lon: 34.78, candles: 18 },
  'haifa': { name: 'Haifa', he: 'חיפה', lat: 32.794, lon: 34.989, candles: 30 },
  'beer-sheva': { name: 'Be’er Sheva', he: 'באר שבע', lat: 31.252, lon: 34.791, candles: 18 },
  'eilat': { name: 'Eilat', he: 'אילת', lat: 29.558, lon: 34.948, candles: 18 },
};
// Nightfall for the end of Shabbat, in minutes after sunset: the usual printed approximation.
const HAVDALAH_AFTER_SUNSET = 40;

const rad = (deg) => (deg * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/** Sunset on a civil day at a place, as an instant (NOAA's sunrise equation; good to a minute or two). */
export function sunset(y, m, d, lat, lon) {
  const n = Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 0)) / 86400000);
  const g = ((2 * Math.PI) / 365) * (n - 1 + 0.5);
  const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
    - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const ha = deg(Math.acos(Math.cos(rad(90.833)) / (Math.cos(rad(lat)) * Math.cos(decl)) - Math.tan(rad(lat)) * Math.tan(decl)));
  const minutesUtc = 720 - 4 * (lon - ha) - eqTime;
  return new Date(Date.UTC(y, m - 1, d) + minutesUtc * 60000);
}

/**
 * Candle lighting and the end of Shabbat for the Friday `friday` ({ y, m, d }),
 * as "HH:MM" in `tz`; null for an unknown city.
 */
export function shabbatTimes(friday, cityId, tz) {
  const city = SHABBAT_CITIES[cityId];
  if (!city) return null;
  const sat = addDays(friday.y, friday.m, friday.d, 1);
  const clock = (date) => {
    const p = localParts(date, tz);
    return `${pad(p.hh)}:${pad(p.mm)}`;
  };
  return {
    city,
    candles: clock(new Date(sunset(friday.y, friday.m, friday.d, city.lat, city.lon).getTime() - city.candles * 60000)),
    ends: clock(new Date(sunset(sat.y, sat.m, sat.d, city.lat, city.lon).getTime() + HAVDALAH_AFTER_SUNSET * 60000)),
  };
}
