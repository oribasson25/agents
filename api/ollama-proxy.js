import { checkInternalOrAuth } from './_auth.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).end();

  /* The browser reaches this same-origin with its session token; the agent
     runner reaches it with the internal secret. It used to be open to the
     whole internet with CORS `*`, which turned the server into a proxy anyone
     could point at an arbitrary host. */
  if (!checkInternalOrAuth(req, res)) return;

  const { host, path, body } = req.body || {};
  if (!host || !path) return res.status(400).json({ error: 'host and path required' });

  const cleanHost = host.replace(/\/$/, '');
  const url = `${cleanHost}${path}`;

  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: `Cannot reach Ollama server: ${err.message}` });
  }
}
