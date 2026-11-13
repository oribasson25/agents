/*
 * How much of the account's Claude credit is left.
 *
 * Anthropic has no endpoint for the remaining balance. Its Admin API cost
 * report (GET /v1/organizations/cost_report) does say what the organization
 * spent, per UTC day, in USD cents. So: the balance the account typed in from
 * the Console, minus what the report says was spent since. It counts the whole
 * organization — every app using its keys, not only 8legs — and runs a few
 * minutes behind Anthropic's own numbers.
 */

const COST_REPORT = 'https://api.anthropic.com/v1/organizations/cost_report';
const PAGE_DAYS = 31;   // the report's maximum page size, in daily buckets
const MAX_PAGES = 24;   // two years back is plenty for "since you last typed the balance"

export class CreditError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export function startOfUtcDay(d) {
  const x = new Date(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()));
}

export function startOfUtcMonth(d) {
  const x = new Date(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), 1));
}

/** Spend per UTC day from `from` until now: [{ day: Date, cents: number }]. */
export async function dailyCost(adminKey, from) {
  const days = [];
  let page = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const qs = new URLSearchParams({
      starting_at: startOfUtcDay(from).toISOString(),
      bucket_width: '1d',
      limit: String(PAGE_DAYS),
    });
    if (page) qs.set('page', page);

    let res;
    try {
      res = await fetch(`${COST_REPORT}?${qs}`, {
        headers: { 'x-api-key': adminKey, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new CreditError(`Could not reach Anthropic: ${err.message}`, 'UNREACHABLE');
    }
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) {
      throw new CreditError(
        'Anthropic refused this key for the cost report. It needs an Admin key (sk-ant-admin…) from Console › Settings › Admin keys.',
        'BAD_KEY',
      );
    }
    if (!res.ok) {
      throw new CreditError(body?.error?.message || `Anthropic answered ${res.status}`, 'API_ERROR');
    }

    for (const bucket of body.data || []) {
      let cents = 0;
      for (const r of bucket.results || []) {
        if (r.currency && r.currency !== 'USD') continue;
        const n = Number(r.amount);   // a decimal string, in cents
        if (Number.isFinite(n)) cents += n;
      }
      days.push({ day: new Date(bucket.starting_at), cents });
    }
    if (!body.has_more || !body.next_page) break;
    page = body.next_page;
  }
  return days;
}

const sumFrom = (days, from) => days.filter((d) => d.day >= from).reduce((s, d) => s + d.cents, 0);

/** What the settings screen shows. Throws CreditError when Anthropic cannot be asked. */
export async function creditSummary(row, now = new Date()) {
  const monthStart = startOfUtcMonth(now);
  const balanceDay = row.balance_at ? startOfUtcDay(row.balance_at) : null;
  const from = balanceDay && balanceDay < monthStart ? balanceDay : monthStart;
  const days = await dailyCost(row.admin_key, from);

  const monthCents = sumFrom(days, monthStart);
  let spentSinceCents = null;
  let remainingCents = null;
  if (balanceDay && row.balance_cents !== null && row.balance_cents !== undefined) {
    spentSinceCents = Math.max(0, sumFrom(days, balanceDay) - Number(row.spend_offset_cents || 0));
    remainingCents = Number(row.balance_cents) - spentSinceCents;
  }
  return { monthCents, spentSinceCents, remainingCents, asOf: now.toISOString() };
}

/** Today's spend so far, recorded with a new balance so it is not counted twice. */
export async function todayCents(adminKey, now = new Date()) {
  const today = startOfUtcDay(now);
  return sumFrom(await dailyCost(adminKey, today), today);
}

export const keyHint = (key) => (key ? `…${String(key).slice(-4)}` : null);
