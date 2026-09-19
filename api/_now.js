/**
 * What day it is, told to every AI Chatbot on every turn.
 *
 * A model has no clock. Left alone it answers "today" from whenever its
 * training stopped, which is how a booking chatbot offers an appointment in a
 * year that has already gone. This is not a tool it may choose to call — it is
 * in the system prompt of every turn, so it is always there and always fresh.
 *
 * The zone is fixed rather than taken from the machine. A Vercel function runs
 * in UTC and a browser runs wherever its owner is sitting, and the test chat
 * has to say the same thing the widget says or testing a chatbot tells you
 * about a chatbot you do not have. Change PLATFORM_TZ to move the platform.
 */

export const PLATFORM_TZ = 'Asia/Jerusalem';

/** `2026-09-20`, in the platform's zone rather than the machine's. */
function isoDay(date, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function nowBlock(at = new Date(), tz = PLATFORM_TZ) {
  const long = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'longOffset',
  }).format(at);

  const today = isoDay(at, tz);
  const tomorrow = isoDay(new Date(at.getTime() + 24 * 60 * 60 * 1000), tz);

  return [
    '## Right now',
    `It is ${long}, in the ${tz} time zone.`,
    `Today is ${today}. Tomorrow is ${tomorrow}.`,
    'Work out every "today", "tomorrow", "this week", "next Tuesday" and every date you write down from this.',
    'Never answer a question about the date or the time from your training, and never guess one.',
  ].join('\n');
}
