import { checkAuth } from './_auth.js';
import { listTables, createTable } from './_tables.js';

/** The account's tables, and making one. */
export default async function handler(req, res) {
  const user = checkAuth(req, res);
  if (!user) return;

  try {
    if (req.method === 'GET') {
      return res.json({ tables: await listTables(user.userId) });
    }
    if (req.method === 'POST') {
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
