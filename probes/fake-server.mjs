/** A stand-in platform: the real converter, an agent in memory, one token. */
import http from 'http';
import { agentToFiles, filesToAgent, agentVersion } from '../api/_agentFiles.js';

const TOKEN = '8legs_pat_TESTTOKEN';
let agent = {
  id: '804fe690-c8b6-4e3a-bb8f-1305bd1721d7', name: 'car-insurance', avatar: '🚗',
  openingMessage: 'שלום! האם אתה מבוטח ברכב?',
  basePrompt: '## Role\nYou are an insurance agent.\n\n## Rules\n- Be brief.\n- Never quote a price you are not sure of.\n',
  skills: [{ id: 's1', name: 'Pricing', description: 'quotes', prompt: '# Pricing\nExplain the quote.\n' }],
  tools: [{ id: 't1', name: 'fetch_quote', description: 'Fetch a quote', parameters: [{ name: 'plate', type: 'string', description: 'Plate' }],
            packages: 'requests', envVars: [{ key: 'QUOTE_KEY', value: 'SECRET' }], code: 'def run(**k):\n    return {}\n' }],
  apiConfig: { provider: 'claude', apiKey: 'SECRET-KEY', model: 'claude-sonnet-4-5' },
  dlp: { creditCard: false, israeliId: false }, scrapeUrls: [], emailEnabled: false,
  whatsapp: { enabled: false, phoneNumberId: '', accessToken: '', appSecret: '', verifyToken: '' },
  createdAt: '2026-01-01T00:00:00.000Z',
};


/* Branches, modelled the way the real endpoint behaves. */
let branches = [];
const openBranch = (ref) => branches.find(b => !b.merged && (b.id === ref || b.name.toLowerCase() === String(ref).toLowerCase()));

const server = http.createServer(async (req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthorized' });
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/api/agents') return send(200, [{ id: agent.id, name: agent.name }]);

  /* Test control: stands in for someone editing the agent in the browser. */
  if (url.pathname === '/__ui_edit' && req.method === 'POST') {
    const body = JSON.parse(await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); }));
    agent = { ...agent, ...body };
    return send(200, { ok: true });
  }
  if (url.pathname === '/__agent') return send(200, agent);

  const br = url.pathname.match(/^\/api\/agents\/([^/]+)\/branches$/);
  if (br) {
    const body = ['POST', 'PUT'].includes(req.method)
      ? JSON.parse(await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b || '{}')); }))
      : {};
    if (req.method === 'GET') {
      return send(200, { branches: [
        { id: null, name: 'main', kind: 'main', live: true,
          traffic_weight: 100 - branches.filter(b => !b.merged).reduce((n, b) => n + b.weight, 0) },
        ...branches.filter(b => !b.merged).map(b => ({ id: b.id, name: b.name, kind: 'branch', live: false, traffic_weight: b.weight })),
      ] });
    }
    if (req.method === 'POST' && body.action === 'merge') {
      const b = openBranch(body.branch);
      if (!b) return send(404, { error: 'No branch' });
      agent = { ...b.data, id: agent.id, apiConfig: agent.apiConfig, whatsapp: agent.whatsapp, createdAt: agent.createdAt };
      b.merged = true; b.weight = 0;
      return send(200, { branch: b.name, version: agentVersion(agent) });
    }
    if (req.method === 'POST') {
      if (openBranch(body.name)) return send(409, { error: 'exists' });
      const from = body.from === 'main' || !body.from ? agent : openBranch(body.from)?.data;
      branches.push({ id: `br-${branches.length + 1}`, name: body.name, data: structuredClone(from), weight: 0, merged: false });
      return send(201, { name: body.name, from: body.from || 'main' });
    }
    if (req.method === 'PUT' && body.action === 'stop') {
      const stopped = branches.filter(b => !b.merged && b.weight > 0).map(b => { b.weight = 0; return b.name; });
      return send(200, { stopped, released: 0 });
    }
    if (req.method === 'PUT') {
      const b = openBranch(body.branch);
      if (!b) return send(404, { error: 'No branch' });
      const other = branches.filter(x => !x.merged && x !== b).reduce((n, x) => n + x.weight, 0);
      if (other + body.weight > 100) return send(409, { error: 'over 100' });
      b.weight = body.weight;
      return send(200, { branch: b.name, traffic_weight: b.weight, main: 100 - other - b.weight });
    }
  }

  const m = url.pathname.match(/^\/api\/agents\/([^/]+)\/files$/);
  if (m) {
    if (m[1] !== agent.id) return send(404, { error: 'Agent not found' });
    const ref = url.searchParams.get('branch') || 'main';
    const onMain = ref === 'main';
    const b = onMain ? null : openBranch(ref);
    if (!onMain && !b) return send(404, { error: `No branch called "${ref}"` });
    const target = () => (onMain ? agent : b.data);

    if (req.method === 'GET') {
      return send(200, { agentId: agent.id, branch: onMain ? 'main' : b.name,
                         version: agentVersion(target()), files: agentToFiles(target()) });
    }
    if (req.method === 'PUT') {
      const body = JSON.parse(await new Promise(r => { let x = ''; req.on('data', c => x += c); req.on('end', () => r(x)); }));
      if (body.baseVersion && body.baseVersion !== agentVersion(target())) {
        return send(409, { error: 'The agent changed since you pulled it' });
      }
      const { agent: next, errors } = filesToAgent(body.files, target());
      if (errors.length) return send(422, { error: 'Invalid agent files', errors });
      next.id = agent.id;
      if (onMain) agent = next; else b.data = next;
      return send(200, { agentId: agent.id, version: agentVersion(next), branch: onMain ? 'main' : b.name });
    }
  }
  send(404, { error: 'not found' });
});

server.listen(0, '127.0.0.1', () => {
  /* The harness reads this line to learn the port. */
  process.stdout.write(`READY http://127.0.0.1:${server.address().port}\n`);
});
