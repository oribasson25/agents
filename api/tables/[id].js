import { checkAuth } from '../_auth.js';
import { getTable, updateTable, deleteTable, listRows } from '../_tables.js';

/** One table: its shape, and the rows in it. */
export default async function handler(req, res) {
  const user = checkAuth(req, res);
  if (!user) return;
  const { id } = req.query;

  try {
    const table = await getTable(id, user.userId);
    if (!table) return res.status(404).json({ error: 'No such table.' });

    if (req.method === 'GET') {
      const { rows, total } = await listRows(id, {
        q: req.query.q, limit: req.query.limit, offset: req.query.offset,
      });
      return res.json({ table, rows, total });
    }
    if (req.method === 'PUT') {
      const saved = await updateTable(id, user.userId, req.body || {});
      if (saved.error) return res.status(400).json(saved);
      return res.json(saved);
    }
    if (req.method === 'DELETE') {
      return res.json(await deleteTable(id, user.userId));
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  return res.status(405).end();
}
