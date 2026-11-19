import { waitUntil } from '@vercel/functions';
import { jarvisGate, numberInScope, ownerInScope } from '../../_jarvisAccess.js';
import { getUserSettings, resolveApiConfig, configUsable } from '../../_settings.js';
import { getNumber } from '../../_waControl.js';
import { describeClaudeError, getGroup } from '../../_waGroups.js';
import { buildKnowledge, digestPart, jobState, setKnowledge } from '../../_waGroupKnowledge.js';

/**
 * What a group's number learned from a WhatsApp chat export. Admins only.
 *
 *   GET    ?numberId&jid  → { profile, samples, stats, importedAt, job }
 *   POST   ?numberId&jid  → { step: 'digest', part, parts, from, to, text } → { notes }
 *                           { step: 'build', notes, recent, samples, stats } → 202, built in the background
 *   PUT    ?numberId&jid  → { profile, samples } — the admin's corrections
 *   DELETE ?numberId&jid  → forgets it
 *
 * The export is parsed in the browser and arrives in parts, so the file never
 * reaches the server whole. Reading runs on the number owner's Claude key.
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
  const k = group.knowledge || null;

  if (req.method === 'GET') {
    return res.json({ knowledge: k && { ...k, job: jobState(k) } });
  }

  if (req.method === 'PUT') {
    if (!k) return res.status(404).json({ error: 'Nothing was learned for this group yet.' });
    const body = req.body || {};
    const profile = String(body.profile ?? k.profile ?? '').slice(0, 60_000);
    const samples = String(body.samples ?? k.samples ?? '').slice(0, 30_000);
    await setKnowledge(numberId, jid, { ...k, profile, samples });
    return res.json({ knowledge: { ...k, profile, samples, job: jobState(k) } });
  }

  if (req.method === 'DELETE') {
    await setKnowledge(numberId, jid, null);
    return res.json({ knowledge: null });
  }

  if (req.method !== 'POST') return res.status(405).end();

  const cfg = resolveApiConfig(await getUserSettings(number.owner_user_id));
  if (!configUsable(cfg)) {
    return res.status(400).json({ error: 'The platform has not chosen a model for this account yet.' });
  }
  const body = req.body || {};

  if (body.step === 'digest') {
    const text = String(body.text || '');
    if (!text.trim() || text.length > 150_000) return res.status(400).json({ error: 'A part must be 1–150,000 characters.' });
    try {
      const out = await digestPart({
        cfg, ownerId: number.owner_user_id, chatName: group.name,
        part: Number(body.part) || 1, parts: Number(body.parts) || 1,
        from: String(body.from || ''), to: String(body.to || ''), text,
      });
      return res.json(out);
    } catch (err) {
      return res.status(502).json({ error: describeClaudeError(err) });
    }
  }

  if (body.step === 'build') {
    if (jobState(k)?.status === 'building') return res.status(409).json({ error: 'This group is already being learned.' });
    const notes = (Array.isArray(body.notes) ? body.notes : []).slice(0, 40).map((n) => ({
      part: Number(n.part) || 0, from: String(n.from || ''), to: String(n.to || ''), notes: String(n.notes || '').slice(0, 20_000),
    }));
    if (!notes.some((n) => n.notes)) return res.status(400).json({ error: 'No part of the chat could be read.' });
    // Mark it as building before answering, so the screen's first poll sees it.
    await setKnowledge(numberId, jid, { ...(k || {}), job: { status: 'building', startedAt: Date.now() } });
    waitUntil(buildKnowledge({
      cfg, ownerId: number.owner_user_id, numberId, group,
      notes,
      recent: String(body.recent || '').slice(0, 120_000),
      samples: String(body.samples || '').slice(0, 30_000),
      stats: body.stats && typeof body.stats === 'object' ? body.stats : null,
    }));
    return res.status(202).json({ started: true });
  }

  return res.status(400).json({ error: 'Unknown step.' });
}
