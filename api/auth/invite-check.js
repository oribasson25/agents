import { checkInvite } from '../_invites.js';

/**
 * Is this code still good?
 *
 * Public, because the person asking has no account yet — that is the point of
 * the code. It reserves nothing: the code is spent by the registration it
 * belongs to, in one statement, so that two people racing the same code
 * cannot both get in. This only decides whether to show them a form.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const result = await checkInvite(req.body?.code);
  if (!result.ok) return res.status(400).json({ error: result.reason });
  return res.json({ ok: true });
}
