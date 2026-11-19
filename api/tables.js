import { requireSession } from './_auth.js';
import { listTables, createTable } from './_tables.js';
import { member, visible, canCreate } from './_access.js';

/** The account's tables, and making one. */
export default async function handler(req, res) {
  const user = await requireSession(req, res);
  if (!user) return;

  try {
    const me = await member(user);
    if (!me) return res.status(401).json({ error: 'unauthorized' });
    if (req.method === 'GET') {
      const shown = await visible(me, 'table', await listTables(user.userId));
      return res.json({ tables: shown.map(({ row, level }) => ({ ...row, _access: level })) });
    }
    if (req.method === 'POST') {
      if (!canCreate(me)) {
        return res.status(403).json({ error: 'Only the organization\'s admin, or a member who can edit everything, can add a table.', code: 'READ_ONLY' });
      }
      const { name, description, columns } = req.body || {};
      if (!String(name || '').trim()) return res.status(400).json({ error: 'A table needs a name.' });
      const made = await createTable(user.userId, { name, description, columns });
      if (made.error) return res.status(400).json(made);
      return res.json(made);
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  return res.status(405).end();
}
