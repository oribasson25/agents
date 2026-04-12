import { sql } from '../_db.js';
import { checkAuth } from '../_auth.js';

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;

  const { docId } = req.query;

  if (req.method === 'PATCH') {
    const { title, content } = req.body;
    await sql`
      update documents set title = ${title}, content = ${content}
      where id = ${docId}
    `;
    return res.status(200).json({ id: docId, title, content });
  }

  if (req.method === 'DELETE') {
    await sql`delete from documents where id = ${docId}`;
    return res.status(204).end();
  }

  res.status(405).end();
}
