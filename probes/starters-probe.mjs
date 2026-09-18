/**
 * What a new account is handed.
 *
 * The rules this holds to: the list is chosen by id, so a copy living in
 * somebody else's account can never take a starter's place however it is named
 * or however recently it was touched; a starter is frozen when it is marked, so
 * editing the agent it came from changes nothing until it is refreshed; and
 * nothing belonging to the owner — key, WhatsApp, tool secrets — rides along.
 */
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

let failed = 0;
const ok = (cond, label, detail = '') => {
  if (cond) console.log(`✓ ${label}`);
  else { console.log(`✗ ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
};

/* ── the database, as far as this code can tell ── */
const db = {
  agents: new Map(),        // id → { data, user_id, is_admin }
  starters: [],             // rows of starter_agents
  documents: [],            // rows of documents
};

globalThis.__db = (text, params) => {
  const q = text.replace(/\s+/g, ' ').trim();

  if (q.startsWith('select s.id, s.source_agent_id')) {
    return db.starters
      .slice()
      .sort((a, b) => a.position - b.position)
      .map(s => ({ ...s, source_data: (db.agents.get(s.source_agent_id) || {}).data || null,
                   created_by_name: 'ori' }));
  }
  if (q.startsWith('select a.id, a.data, a.user_id, coalesce(u.is_admin')) {
    const row = db.agents.get(params[0]);
    return row ? [{ id: params[0], data: row.data, user_id: row.user_id, owner_is_admin: row.is_admin }] : [];
  }
  if (q.startsWith('select skill_id, title, content, normalized')) {
    return db.documents.filter(d => d.agent_id === params[0] && !d.parent_id);
  }
  if (q.startsWith('select id from starter_agents where source_agent_id')) {
    const hit = db.starters.find(s => s.source_agent_id === params[0]);
    return hit ? [{ id: hit.id }] : [];
  }
  if (q.startsWith('select coalesce(max(position), 0) + 1')) {
    return [{ next: db.starters.reduce((m, s) => Math.max(m, s.position), 0) + 1 }];
  }
  if (q.startsWith('insert into starter_agents')) {
    const [id, source_agent_id, name, data, documents, position, created_by] = params;
    db.starters.push({ id, source_agent_id, name, data: JSON.parse(data),
                       documents: JSON.parse(documents), position, created_by,
                       created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    return [];
  }
  if (q.startsWith('update starter_agents')) {
    const [source_agent_id, name, data, documents, id] = params;
    const row = db.starters.find(s => s.id === id);
    if (!row) return [];
    Object.assign(row, { source_agent_id, name, data: JSON.parse(data),
                         documents: JSON.parse(documents), updated_at: new Date().toISOString() });
    return [{ id }];
  }
  if (q.startsWith('delete from starter_agents')) {
    db.starters = db.starters.filter(s => s.id !== params[0]);
    return [];
  }
  if (q.startsWith('insert into agents')) {
    db.agents.set(params[0], { data: JSON.parse(params[1]), user_id: params[2], is_admin: false });
    return [];
  }
  if (q.startsWith('insert into documents')) {
    db.documents.push({ id: params[0], agent_id: params[1], skill_id: params[2], title: params[3],
                        content: params[4], parent_id: null });
    return [];
  }
  if (q.startsWith('delete from documents where parent_id')) return [];
  throw new Error('unexpected query: ' + q.slice(0, 80));
};

const { seedDefaultAgents, snapshotAgent, removeStarter, listStarters } =
  await import(`${ROOT}/api/_defaultAgent.js`);

/* ── the admin's own AI Chatbot, with everything that must not travel ── */
const TEMPLATE = {
  id: 'tpl-1', name: 'weather', avatar: '☀️',
  basePrompt: 'The original prompt.',
  skills: [{ id: 's1', name: 'forecast', prompt: 'x' }],
  tools: [{ id: 't1', name: 'fetch', envVars: [{ key: 'API_KEY', value: 'SECRET-VALUE' }], code: 'pass' }],
  apiConfig: { provider: 'claude', apiKey: 'SECRET-KEY', model: 'claude-opus-5' },
  whatsapp: { enabled: true, phoneNumberId: '972500000', accessToken: 'SECRET-WA', appSecret: 'S', verifyToken: 'V' },
  emailEnabled: true,
};
db.agents.set('tpl-1', { data: JSON.parse(JSON.stringify(TEMPLATE)), user_id: 'admin-1', is_admin: true });
db.documents.push({ id: 'd1', agent_id: 'tpl-1', skill_id: 's1', title: 'Rates', content: 'the original text', parent_id: null });

const admin = { userId: 'admin-1' };

/* ── marking ── */
const marked = await snapshotAgent({ agentId: 'tpl-1', admin });
ok(!marked.error && db.starters.length === 1, 'an admin can freeze their own AI Chatbot as a starter', marked.error);
ok(marked.documents === 1, 'the documents are frozen with it');

const again = await snapshotAgent({ agentId: 'tpl-1', admin });
ok(!!again.error, 'the same AI Chatbot cannot be marked twice');

db.agents.set('user-copy', { data: { ...TEMPLATE, id: 'user-copy', name: 'weather' }, user_id: 'u-2', is_admin: false });
const refused = await snapshotAgent({ agentId: 'user-copy', admin });
ok(!!refused.error, "an ordinary user's AI Chatbot cannot be made a starter", JSON.stringify(refused));

/* ── the source moves on; the starter does not ── */
db.agents.get('tpl-1').data.basePrompt = 'EDITED AFTER THE SNAPSHOT';
db.agents.get('tpl-1').data.name = 'weather (renamed)';
db.documents[0].content = 'edited after the snapshot';

/* ── and somebody who is also an admin edits their copy, named the same ── */
db.agents.set('admin-copy', {
  data: { ...JSON.parse(JSON.stringify(TEMPLATE)), id: 'admin-copy', basePrompt: 'A COPY SOMEBODY ELSE EDITED' },
  user_id: 'admin-2', is_admin: true,
});

const created = await seedDefaultAgents('new-user');
ok(created.length === 1, 'a new account gets one AI Chatbot', `got ${created.length}`);
const given = db.agents.get(created[0]).data;

ok(given.basePrompt === 'The original prompt.',
   'it gets the frozen prompt, not the one edited since', given.basePrompt);
ok(given.name === 'weather', 'and the name as it was frozen', given.name);
ok(given.basePrompt !== 'A COPY SOMEBODY ELSE EDITED',
   "another admin's copy of the same name never stands in for the starter");

const doc = db.documents.find(d => d.agent_id === created[0]);
ok(doc && doc.content === 'the original text',
   'the document comes from the snapshot too', doc && doc.content);

/* ── nothing of the owner's travels ── */
ok(given.apiConfig.apiKey === '', 'the API key is dropped');
ok(given.apiConfig.model === 'claude-opus-5', 'the model is kept, so it is ready to run');
ok(given.whatsapp.phoneNumberId === '' && given.whatsapp.accessToken === '', 'the WhatsApp number and tokens are dropped');
ok(given.tools[0].envVars[0].key === 'API_KEY' && given.tools[0].envVars[0].value === '',
   "a tool's secret keeps its name and loses its value");
ok(given.id !== 'tpl-1', 'the copy is its own row');

/* ── refreshing takes the source as it is now ── */
const starter = (await listStarters())[0];
await snapshotAgent({ agentId: 'tpl-1', admin, starterId: starter.id });
const after = await seedDefaultAgents('new-user-2');
ok(db.agents.get(after[0]).data.basePrompt === 'EDITED AFTER THE SNAPSHOT',
   'after a refresh the next account gets the newer version');

/* ── removing stops it ── */
await removeStarter(starter.id);
const none = await seedDefaultAgents('new-user-3');
ok(none.length === 0, 'with no starters marked a new account starts empty');

console.log(`\n${failed ? `${failed} FAILURE(S)` : 'all green'}`);
process.exit(failed ? 1 : 0);
