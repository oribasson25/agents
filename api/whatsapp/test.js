import { checkAuth } from '../_auth.js';

const GRAPH = 'https://graph.facebook.com/v20.0';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const user = checkAuth(req, res);
  if (!user) return;

  const { phoneNumberId, accessToken } = req.body || {};
  if (!phoneNumberId || !accessToken) {
    return res.status(400).json({ ok: false, error: 'phoneNumberId and accessToken are required' });
  }

  try {
    const resp = await fetch(
      `${GRAPH}/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const data = await resp.json();

    if (!resp.ok) {
      return res.status(200).json({ ok: false, error: data.error?.message || 'Meta API request failed' });
    }

    return res.json({
      ok: true,
      displayPhoneNumber: data.display_phone_number || '',
      verifiedName: data.verified_name || '',
    });
  } catch (err) {
    return res.status(200).json({ ok: false, error: err.message });
  }
}
