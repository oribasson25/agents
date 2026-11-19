import { workerAuthorized } from '../_waControl.js';
import { fireDueSchedules, dueRuns, workRun, pruneRuns, WORK_BUDGET_MS } from '../_automations.js';
import { pollEmailTriggers } from '../_automationTriggers.js';
import { pruneOutbox } from '../_waOutbox.js';

/* This function's maxDuration (vercel.json) and what is kept back from it. */
const MAX_DURATION_MS = 300 * 1000;
const MARGIN_MS = 15 * 1000;

/**
 * Every minute: fire the schedules that came due, and carry on every run that
 * is ready to — one whose wait is over, one a webhook queued, one whose
 * function ran out of time or died.
 *
 * The runs that are due are picked first and worked side by side; looking in
 * mailboxes for new mail goes on at the same time, with its own budget, so a
 * slow mailbox never holds up a run that is ready. Each run is claimed before
 * it is touched, so a tick that overlaps the last one cannot run anything
 * twice, and no run is given more time than the function has left.
 */
export default async function handler(req, res) {
  if (!workerAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  const started = Date.now();
  const left = () => MAX_DURATION_MS - MARGIN_MS - (Date.now() - started);

  const fired = await fireDueSchedules().catch((err) => { console.error('[automations] schedules', err.message); return []; });
  const ids = await dueRuns(20).catch((err) => { console.error('[automations] due runs', err.message); return []; });

  const working = Promise.all(ids.map(async (id) => {
    try {
      const run = await workRun(id, {
        host: req.headers.host,
        budgetMs: Math.max(10000, Math.min(WORK_BUDGET_MS, left() - 40000)),
        hardBudgetMs: Math.max(15000, left()),
      });
      return { id, status: run ? run.status : 'taken' };
    } catch (err) {
      console.error('[automations] run', id, err.message);
      return { id, status: 'error' };
    }
  }));
  const mail = pollEmailTriggers({ budgetMs: Math.max(10000, Math.min(120000, left() - 60000)) })
    .catch((err) => { console.error('[automations] mail', err.message); return 0; });

  const [worked, mailStarted] = await Promise.all([working, mail]);

  /* Once an hour, by the minute this tick started (not the one it ended in). */
  if (new Date(started).getUTCMinutes() === 0) {
    await pruneRuns().catch(() => {});
    await pruneOutbox().catch(() => {});
  }
  return res.json({ fired: fired.length, mail: mailStarted, worked });
}
