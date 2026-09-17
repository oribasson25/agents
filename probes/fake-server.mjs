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

  const m = url.pathname.match(/^\/api\/agents\/([^/]+)\/files$/);
  if (m) {
    if (m[1] !== agent.id) return send(404, { error: 'Agent not found' });
    if (req.method === 'GET') return send(200, { agentId: agent.id, branch: 'main', version: agentVersion(agent), files: agentToFiles(agent) });
    if (req.method === 'PUT') {
      const body = JSON.parse(await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); }));
      if (body.baseVersion && body.baseVersion !== agentVersion(agent)) {
        return send(409, { error: 'The agent changed since you pulled it' });
      }
      const { agent: next, errors } = filesToAgent(body.files, agent);
      if (errors.length) return send(422, { error: 'Invalid agent files', errors });
      next.id = agent.id; agent = next;
      return send(200, { agentId: agent.id, version: agentVersion(agent), branch: 'main' });
    }
  }
  send(404, { error: 'not found' });
});

server.listen(0, '127.0.0.1', () => {
  /* The harness reads this line to learn the port. */
  process.stdout.write(`READY http://127.0.0.1:${server.address().port}\n`);
});
