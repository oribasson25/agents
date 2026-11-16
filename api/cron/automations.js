import { workerAuthorized } from '../_waControl.js';
import { fireDueSchedules, dueRuns, workRun, pruneRuns, WORK_BUDGET_MS } from '../_automations.js';
import { pollEmailTriggers } from '../_automationTriggers.js';
import { pruneOutbox } from '../_waOutbox.js';

/**
 * Every minute: fire the schedules that came due, and carry on every run that
 * is ready to — one whose wait is over, one a webhook queued, one whose
 * function ran out of time or died.
 *
 * Runs are worked side by side and each is claimed before it is touched, so a
 * tick that overlaps the last one cannot run anything twice.
 */
export default async function handler(req, res) {
  if (!workerAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  const started = Date.now();
  const fired = await fireDueSchedules().catch((err) => { console.error('[automations] schedules', err.message); return []; });
  const mail = await pollEmailTriggers().catch((err) => { console.error('[automations] mail', err.message); return 0; });
  const ids = await dueRuns(20);
  const worked = await Promise.all(ids.map(async (id) => {
    try {
      const run = await workRun(id, { host: req.headers.host, budgetMs: Math.max(10000, WORK_BUDGET_MS - (Date.now() - started)) });
      return { id, status: run ? run.status : 'taken' };
    } catch (err) {
      console.error('[automations] run', id, err.message);
      return { id, status: 'error' };
    }
  }));

  if (new Date().getUTCMinutes() === 0) {
    await pruneRuns().catch(() => {});
    await pruneOutbox().catch(() => {});
  }
  return res.json({ fired: fired.length, mail, worked });
}
