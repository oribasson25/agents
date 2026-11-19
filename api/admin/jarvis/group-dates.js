import { sql } from '../../_db.js';
import { jarvisGate, numberInScope } from '../../_jarvisAccess.js';
import { getNumber } from '../../_waControl.js';
import { MAX_DATES, getGroup, insertDate, listDates, sanitizeDate } from '../../_waGroups.js';

/**
 * A group's birthdays and other yearly dates. The number congratulates on the
 * day, at the time set in the group's settings. Admins only.
 *
 *   GET    ?numberId&jid     → { dates }
 *   POST   ?numberId&jid     → { name, day, month, year?, phone?, kind?, label?, hebrew?, note? }   one date
 *                              { rows: [...], replace? }   a spreadsheet, read in the browser;
 *                              `replace` empties the list first. Rows that cannot be read are
 *                              returned in `skipped` and the rest are saved.
 *   PATCH  ?numberId&jid&id  → the same fields
 *   DELETE ?numberId&jid&id  → one date;  DELETE ?numberId&jid&all=1 → the whole list
 */
export default async function handler(req, res) {
  const admin = await jarvisGate(req, res);
  if (!admin) return;

  const numberId = String(req.query.numberId || '');
  const jid = String(req.query.jid || '');
  const found = await getNumber(numberId);
  const number = (await numberInScope(admin, found)) ? found : null;
  const group = number && (await getGroup(numberId, jid));
  if (!group) return res.status(404).json({ error: 'No such group.' });
  const list = async (extra = {}) => ({ dates: (await listDates(numberId, jid)).map(({ greeted_on, ...d }) => d), ...extra });
  // Someone added today whose day is today is still congratulated today, if the time has not long passed.
  const recheckToday = () => sql`update wa_groups set proactive_state = proactive_state - 'birthdays' where number_id = ${numberId} and jid = ${jid}`;

  if (req.method === 'GET') return res.json(await list());
  const id = req.query.id ? Number(req.query.id) : null;

  if (req.method === 'POST') {
    const body = req.body || {};
    if (Array.isArray(body.rows)) {
      const clean = [];
      const skipped = [];
      body.rows.slice(0, MAX_DATES).forEach((row, i) => {
        const { date, error } = sanitizeDate(row || {});
        if (date) clean.push(date);
        else skipped.push({ row: Number(row?.row) || i + 1, error });
      });
      if (!clean.length) return res.status(400).json({ error: 'No row could be read: each needs a name and a date.', skipped });
      const existing = body.replace ? [] : await listDates(numberId, jid);
      if (existing.length + clean.length > MAX_DATES) return res.status(400).json({ error: `A group can hold up to ${MAX_DATES} dates.` });
      // The same person and day twice (a file uploaded again) is kept once.
      const key = (d) => `${d.name.toLowerCase()}|${d.day}|${d.month}|${d.kind}`;
      const have = new Set(existing.map(key));
      const fresh = clean.filter((d) => !have.has(key(d)) && have.add(key(d)));
      /* One statement: emptying the list (replace) and adding the new rows
         happen together or not at all, so a cut-off import never leaves the
         old list gone and the new one half there. */
      const col = (k) => fresh.map((d) => d[k]);
      await sql`
        with emptied as (
          delete from wa_group_dates where number_id = ${numberId} and jid = ${jid} and ${!!body.replace}::boolean
        )
        insert into wa_group_dates (number_id, jid, name, phone, kind, label, day, month, year, hebrew, note)
        select ${numberId}, ${jid}, t.name, t.phone, t.kind, t.label, t.day, t.month, t.year, t.hebrew, t.note
        from unnest(${col('name')}::text[], ${col('phone')}::text[], ${col('kind')}::text[], ${col('label')}::text[],
                    ${col('day')}::int[], ${col('month')}::int[], ${col('year')}::int[], ${col('hebrew')}::boolean[],
                    ${col('note')}::text[]) as t(name, phone, kind, label, day, month, year, hebrew, note)
      `;
      const added = fresh.length;
      await recheckToday();
      return res.status(201).json(await list({ added, duplicates: clean.length - added, skipped }));
    }
    const { date, error } = sanitizeDate(body);
    if (error) return res.status(400).json({ error });
    const [{ n }] = await sql`select count(*)::int as n from wa_group_dates where number_id = ${numberId} and jid = ${jid}`;
    if (n >= MAX_DATES) return res.status(400).json({ error: `A group can hold up to ${MAX_DATES} dates.` });
    await insertDate(numberId, jid, date);
    await recheckToday();
    return res.status(201).json(await list());
  }

  if (req.method === 'PATCH') {
    const [current] = id ? await sql`select * from wa_group_dates where id = ${id} and number_id = ${numberId} and jid = ${jid}` : [];
    if (!current) return res.status(404).json({ error: 'No such date.' });
    const { date: d, error } = sanitizeDate({ ...current, ...(req.body || {}) });
    if (error) return res.status(400).json({ error });
    await sql`
      update wa_group_dates set name = ${d.name}, phone = ${d.phone}, kind = ${d.kind}, label = ${d.label}, day = ${d.day},
             month = ${d.month}, year = ${d.year}, hebrew = ${d.hebrew}, note = ${d.note}
      where id = ${id} and number_id = ${numberId} and jid = ${jid}
    `;
    await recheckToday();
    return res.json(await list());
  }

  if (req.method === 'DELETE') {
    if (req.query.all) await sql`delete from wa_group_dates where number_id = ${numberId} and jid = ${jid}`;
    else if (id) await sql`delete from wa_group_dates where id = ${id} and number_id = ${numberId} and jid = ${jid}`;
    else return res.status(400).json({ error: 'Which one?' });
    return res.json(await list());
  }

  return res.status(405).end();
}
