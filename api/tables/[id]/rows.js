import { checkAuth } from '../../_auth.js';
import { getTable, addRow, updateRow, deleteRow } from '../../_tables.js';

/** Rows, from the Tables screen. An AI Chatbot reaches them another way. */
export default async function handler(req, res) {
  const user = checkAuth(req, res);
  if (!user) return;
  const { id } = req.query;

  try {
    const table = await getTable(id, user.userId);
    if (!table) return res.status(404).json({ error: 'No such table.' });

    if (req.method === 'POST') {
      return res.json(await addRow(table, (req.body || {}).row || {}, 'user'));
    }
    if (req.method === 'PUT') {
      const { rowId, row } = req.body || {};
      if (!rowId) return res.status(400).json({ error: 'rowId is required' });
      const saved = await updateRow(table, rowId, row || {}, 'user');
      if (saved.error) return res.status(404).json(saved);
      return res.json(saved);
    }
    if (req.method === 'DELETE') {
      const rowId = (req.query.rowId || '').trim();
      if (!rowId) return res.status(400).json({ error: 'rowId is required' });
      return res.json(await deleteRow(id, rowId));
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  return res.status(405).end();
}
