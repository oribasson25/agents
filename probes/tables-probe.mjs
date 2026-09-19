/**
 * Tables, and what an AI Chatbot may do with them.
 *
 * The rules this holds to: a chatbot reaches only the tables ticked onto it
 * and only those its owner owns; it can read, add and update, and there is no
 * path from a conversation to deleting a row or reshaping a table; values are
 * stored in the shape their column promises; and a row remembers who wrote it.
 */
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

let failed = 0;
const ok = (cond, label, detail = '') => {
  if (cond) console.log(`✓ ${label}`);
  else { console.log(`✗ ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
};

const db = { tables: [], rows: [] };

globalThis.__db = (text, params) => {
  const q = text.replace(/\s+/g, ' ').trim();

  if (q.startsWith('select t.id, t.name, t.description')) {
    return db.tables.filter(t => t.user_id === params[0])
      .map(t => ({ ...t, row_count: db.rows.filter(r => r.table_id === t.id).length }));
  }
  if (q.startsWith('select id, name, description, columns')) {
    return db.tables.filter(t => t.id === params[0] && t.user_id === params[1]);
  }
  if (q.startsWith('insert into data_tables')) {
    const [id, user_id, name, description, columns] = params;
    db.tables.push({ id, user_id, name, description, columns: JSON.parse(columns) });
    return [];
  }
  if (q.startsWith('update data_tables set name')) {
    const [name, description, columns, id, user_id] = params;
    const t = db.tables.find(x => x.id === id && x.user_id === user_id);
    if (t) Object.assign(t, { name, description, columns: JSON.parse(columns) });
    return [];
  }
  if (q.startsWith('update data_tables set updated_at')) return [];
  if (q.startsWith('delete from data_tables')) {
    db.tables = db.tables.filter(t => !(t.id === params[0] && t.user_id === params[1]));
    return [];
  }
  if (q.startsWith('select id, data, written_by')) {
    const [tableId, term] = params;
    let rows = db.rows.filter(r => r.table_id === tableId);
    if (term !== undefined && q.includes('ilike')) {
      rows = rows.filter(r => JSON.stringify(r.data).toLowerCase().includes(String(term).toLowerCase()));
    }
    return rows;
  }
  if (q.startsWith('select count(*)::int as total')) {
    const [tableId, term] = params;
    let rows = db.rows.filter(r => r.table_id === tableId);
    if (term !== undefined && q.includes('ilike')) {
      rows = rows.filter(r => JSON.stringify(r.data).toLowerCase().includes(String(term).toLowerCase()));
    }
    return [{ total: rows.length }];
  }
  if (q.startsWith('insert into data_table_rows')) {
    const [id, table_id, data, written_by] = params;
    db.rows.push({ id, table_id, data: JSON.parse(data), written_by });
    return [];
  }
  if (q.startsWith('select id, data from data_table_rows')) {
    return db.rows.filter(r => r.id === params[0] && r.table_id === params[1]);
  }
  if (q.startsWith('update data_table_rows')) {
    const [data, written_by, rowId, tableId] = params;
    const r = db.rows.find(x => x.id === rowId && x.table_id === tableId);
    if (r) Object.assign(r, { data: JSON.parse(data), written_by });
    return [];
  }
  if (q.startsWith('delete from data_table_rows')) {
    db.rows = db.rows.filter(r => !(r.id === params[0] && r.table_id === params[1]));
    return [];
  }
  throw new Error('unexpected query: ' + q.slice(0, 80));
};

const T = await import(`${ROOT}/api/_tables.js`);

/* ── shaping ── */
const made = await T.createTable('u-1', {
  name: 'Orders',
  description: 'every order and its status',
  columns: [{ name: 'Order ID' }, { name: 'total', type: 'number' },
            { name: 'due', type: 'date' }, { name: 'paid', type: 'boolean' }],
});
ok(!made.error, 'an account can make a table', made.error);
ok(made.columns[0].key === 'order_id', 'a column name becomes a usable key', JSON.stringify(made.columns[0]));

const clash = T.normalizeColumns([{ name: 'total' }, { name: 'Total' }]);
ok(clash[1].key !== clash[0].key, 'two columns cannot share a key', JSON.stringify(clash));

ok(T.coerce('1,250', 'number') === 1250, 'a number arrives as a number');
ok(T.coerce('not a number', 'number') === '', 'a number that is not one is refused rather than stored');
ok(T.coerce('yes', 'boolean') === true && T.coerce('כן', 'boolean') === true, 'yes reads as yes, in either language');
ok(T.coerce('2026-09-19T10:00:00Z', 'date') === '2026-09-19', 'a date is stored as a day');

const [table] = await T.listTables('u-1');
const shaped = T.shapeRow(table.columns, { 'Order ID': 'A-1', total: '99.5', nonsense: 'x' });
ok(shaped.order_id === 'A-1' && shaped.total === 99.5, 'a row is shaped by the columns');
ok(!('nonsense' in shaped), 'a column the table does not have is dropped');

/* ── what a chatbot may reach ── */
await T.createTable('u-2', { name: 'Somebody else', columns: [{ name: 'a' }] });
const mine = db.tables.find(t => t.user_id === 'u-1');
const theirs = db.tables.find(t => t.user_id === 'u-2');

const ticked = { tables: [mine.id] };
const reachable = await T.tablesForAgent(ticked, 'u-1');
ok(reachable.length === 1 && reachable[0].id === mine.id, 'a chatbot reaches what is ticked onto it');

const greedy = { tables: [mine.id, theirs.id] };
const reachable2 = await T.tablesForAgent(greedy, 'u-1');
ok(reachable2.length === 1, "ticking somebody else's table id does not open it", JSON.stringify(reachable2.map(t => t.name)));

const untickedNone = await T.tablesForAgent({ tables: [] }, 'u-1');
ok(untickedNone.length === 0, 'a chatbot with nothing ticked reaches nothing');

/* ── the tools ── */
const call = (toolName, inputs, agent = ticked) =>
  T.runAgentTableTool({ toolName, inputs, agent, ownerId: 'u-1', writtenBy: 'a-1' });

ok((await call('table_list', {})).includes('Orders'), 'table_list names the table');

const added = await call('table_add_row', { table: 'Orders', row: { 'Order ID': 'A-77', total: '349' } });
ok(added.startsWith('Added a row'), 'a chatbot can add a row', added);
ok(db.rows[0].written_by === 'a-1', 'the row remembers which chatbot wrote it', db.rows[0].written_by);
ok(db.rows[0].data.total === 349, 'and the value was coerced on the way in', JSON.stringify(db.rows[0].data));

const found = await call('table_find', { table: 'Orders', search: 'A-77' });
ok(found.includes('row_id'), 'table_find hands back a row_id to update with');

const rowId = db.rows[0].id;
const updated = await call('table_update_row', { table: 'Orders', row_id: rowId, fields: { total: '400' } });
ok(db.rows[0].data.total === 400, 'a chatbot can update a row', updated);
ok(db.rows[0].data.order_id === 'A-77', 'and the fields it did not pass are left alone');

const missing = await call('table_update_row', { table: 'Orders', row_id: 'nope', fields: { total: 1 } });
ok(missing.toLowerCase().includes('no such row'), 'updating a row that is not there says so rather than throwing');

const refused = await call('table_find', { table: 'Somebody else' });
ok(refused.startsWith('No table called'), "a chatbot cannot read a table it was not given", refused);

const noTools = await T.runAgentTableTool({ toolName: 'table_list', inputs: {}, agent: { tables: [] }, ownerId: 'u-1' });
ok(noTools.includes('No tables are enabled'), 'a chatbot with none ticked is told so plainly');

/* ── a day, written the way it is written here ── */
ok(T.parseDay('9.1.2025') === '2025-01-09',
   'a date written day-first is the day it says', T.parseDay('9.1.2025'));
ok(T.parseDay('21/01/2025') === '2025-01-21',
   'and one that can only be day-first is not refused', T.parseDay('21/01/2025'));
ok(T.parseDay('19.9.2026') === '2026-09-19', 'dots read the same as slashes');
ok(T.parseDay('1/21/2025') === '2025-01-21', 'a month-first date is still understood');
ok(T.parseDay('2025-01-09') === '2025-01-09', 'ISO stays ISO');
ok(T.parseDay('19/9/26') === '2026-09-19', 'a two-digit year is this century');
ok(T.parseDay('מחר') === null && T.parseDay('32/1/2025') === null,
   'and what is not a day is refused rather than stored in a date column');

/* ── a column is not its punctuation ── */
const hebCols = [{ key: 'שם_מלא', name: 'שם מלא', type: 'text' },
                 { key: 'תאריך_רישום', name: 'תאריך רישום', type: 'date' },
                 { key: 'total', name: 'Total', type: 'number' }];
ok(T.shapeRow(hebCols, { 'שם מלא': 'דנה כהן' })['שם_מלא'] === 'דנה כהן', 'the column name lands');
ok(T.shapeRow(hebCols, { 'שם_מלא': 'דנה' })['שם_מלא'] === 'דנה', 'so does its key');
ok(T.shapeRow(hebCols, { 'שם-מלא': 'רון' })['שם_מלא'] === 'רון', 'and a near miss on the separator');
ok(T.shapeRow(hebCols, { TOTAL: '1,250' }).total === 1250, 'case is not what a column is');

const detailed = T.shapeRowDetailed(hebCols, { 'Full Name': 'x', total: 'בערך חמישים' });
ok(detailed.unknown[0] === 'Full Name', 'a column the table has not is named, not swallowed', JSON.stringify(detailed));
ok(detailed.refused[0] && detailed.refused[0].column === 'Total',
   'and a value the column cannot hold is named too', JSON.stringify(detailed.refused));

/* ── nothing is ever reported as saved when it was not ── */
const hebTable = await T.createTable('u-1', {
  name: 'משתתפי אירועים',
  columns: [{ name: 'שם מלא' }, { name: 'תאריך רישום', type: 'date' }],
});
const events = { tables: [hebTable.id] };
const heb = (toolName, inputs) => T.runAgentTableTool({ toolName, inputs, agent: events, ownerId: 'u-1', writtenBy: 'a-1' });

const hebrew = await heb('table_add_row', { table: 'משתתפי אירועים', row: { 'שם מלא': 'דנה כהן', 'תאריך רישום': '9.1.2025' } });
ok(hebrew.startsWith('Added a row'), 'a row in Hebrew is a row', hebrew);
const stored = db.rows.at(-1).data;
ok(stored['שם_מלא'] === 'דנה כהן', 'the Hebrew value is stored', JSON.stringify(stored));
ok(stored['תאריך_רישום'] === '2025-01-09', 'and 9.1.2025 is the 9th of January', JSON.stringify(stored));

const nonsense = await heb('table_add_row', { table: 'משתתפי אירועים', row: { attendee: 'דנה', when: 'tomorrow' } });
ok(nonsense.startsWith('Nothing was saved'),
   'a row where nothing matched does NOT come back as "Added a row"', nonsense);
ok(nonsense.includes('שם מלא'), 'and the answer names the columns the table does have', nonsense);
ok(Object.keys(db.rows.at(-1).data).length === 0, 'the empty row is still there to be fixed, with its row_id given');

const partial = await heb('table_add_row', { table: 'משתתפי אירועים', row: { 'שם מלא': 'רון', nickname: 'רוני' } });
ok(partial.startsWith('Added a row') && partial.includes('BUT'),
   'a row that half landed says which half did not', partial);

/* ── the two things a conversation must never do ── */
const names = T.TABLE_TOOLS.map(t => t.name);
ok(!names.some(n => /delete|drop|remove|column/.test(n)),
   'no tool offered to a chatbot deletes a row or reshapes a table', names.join(', '));
ok((await call('table_delete_row', { table: 'Orders' })).startsWith('Unknown table tool'),
   'and asking for one anyway is refused');

console.log(`\n${failed ? `${failed} FAILURE(S)` : 'all green'}`);
process.exit(failed ? 1 : 0);
