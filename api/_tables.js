import crypto from 'crypto';
import { sql } from './_db.js';

/**
 * Tables — the shared knowledge an account keeps in rows.
 *
 * One place decides what a table is, so the three callers agree: the Tables
 * screen, the AI Chatbot mid-conversation, and the platform assistant. They
 * differ only in who is asking and what they are allowed to do — a chatbot may
 * read, add and update, and may never delete or change a table's shape.
 */

export const COLUMN_TYPES = ['text', 'number', 'date', 'boolean'];

/** A column's key is what a row is stored under; the name is what people read. */
function columnKey(name, taken) {
  const base = (name || '')
    .trim().toLowerCase()
    .replace(/[^a-z0-9_֐-׿]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'column';
  let key = base, n = 2;
  while (taken.has(key)) key = `${base}_${n++}`;
  taken.add(key);
  return key;
}

export function normalizeColumns(columns) {
  const taken = new Set();
  return (Array.isArray(columns) ? columns : [])
    .filter(c => c && (c.name || c.key))
    .slice(0, 40)
    .map(c => ({
      key: c.key && !taken.has(c.key) ? (taken.add(c.key), c.key) : columnKey(c.name || c.key, taken),
      name: String(c.name || c.key).trim().slice(0, 60),
      type: COLUMN_TYPES.includes(c.type) ? c.type : 'text',
    }));
}

const YES = ['true', 'yes', 'y', '1', 'כן'];
const NO = ['false', 'no', 'n', '0', 'לא'];

function twoDigits(n) { return String(n).padStart(2, '0'); }

/**
 * A day, written the way it is written here.
 *
 * `new Date('9.1.2025')` reads that as the ninth month and hands back
 * 2025-08-31 — September the first, pushed back a day because `toISOString`
 * converts a local midnight to UTC and Israel is ahead of it. Someone
 * registering for an event on the 9th of January ended up in August. And
 * `21/01/2025` was rejected outright and left in a date column as raw text.
 *
 * So: ISO is read as ISO, and anything separated by dots or slashes is read
 * day-first, which is the convention here. The day is assembled from its parts
 * rather than round-tripped through UTC, so no timezone can move it.
 */
export function parseDay(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : `${value.getFullYear()}-${twoDigits(value.getMonth() + 1)}-${twoDigits(value.getDate())}`;
  }
  const s = String(value).trim();
  if (!s) return null;

  const build = (y, m, d) => {
    y = Number(y); m = Number(m); d = Number(d);
    // 21/01 can only be day-first; 01/21 can only be month-first.
    if (m > 12 && d <= 12) [m, d] = [d, m];
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1900 && y <= 2999)) return null;
    return `${y}-${twoDigits(m)}-${twoDigits(d)}`;
  };

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ]|$)/.exec(s);
  if (m) return build(m[1], m[2], m[3]);

  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/.exec(s);
  if (m) {
    const year = m[3].length <= 2 ? 2000 + Number(m[3]) : m[3];
    return build(year, m[2], m[1]);
  }

  const parsed = new Date(s);
  if (Number.isNaN(parsed.getTime())) return null;
  // An instant carries its own zone; a bare date was read as a local midnight.
  return /Z$|[+-]\d{2}:?\d{2}$/.test(s)
    ? parsed.toISOString().slice(0, 10)
    : `${parsed.getFullYear()}-${twoDigits(parsed.getMonth() + 1)}-${twoDigits(parsed.getDate())}`;
}

/**
 * A value in the shape its column promises.
 *
 * Returns `null` when the value cannot be that shape — which the caller reports
 * rather than swallowing. A number column used to turn "בערך חמישים" into an
 * empty cell and say nothing, so the row looked saved and was not.
 */
export function coerceOrNull(value, type) {
  if (value === null || value === undefined || value === '') return '';
  if (type === 'number') {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const n = Number(String(value).replace(/[,\s\u00a0]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    const v = String(value).trim().toLowerCase();
    if (YES.includes(v)) return true;
    if (NO.includes(v)) return false;
    return null;
  }
  if (type === 'date') return parseDay(value);
  return String(value).slice(0, 4000);
}

/** The forgiving form, kept for callers that only want a value. */
export function coerce(value, type) {
  const out = coerceOrNull(value, type);
  return out === null ? '' : out;
}

/** Case, spaces, underscores and hyphens are not what a column is. */
function matchable(name) {
  return String(name || '').trim().toLowerCase().replace(/[\s_\-.]+/g, '');
}

/**
 * Which column a field name means.
 *
 * The exact key or name first, then the same folded. A model writing into
 * `שם מלא` will try `שם_מלא`, `שם מלא`, `full name` and `Full Name`, and the
 * exact-match lookup this replaces silently dropped every near miss — leaving a
 * row the chatbot had just told the user it had saved.
 */
export function findColumn(columns, field) {
  const exact = columns.find(c => c.key === field || c.name === field);
  if (exact) return exact;
  const folded = matchable(field);
  return columns.find(c => matchable(c.key) === folded || matchable(c.name) === folded) || null;
}

/**
 * Only the columns the table has, each in its own type — and an account of
 * what would not go in, so nothing is reported as saved when it was not.
 */
export function shapeRowDetailed(columns, input) {
  const data = {};
  const unknown = [];
  const refused = [];
  for (const [field, value] of Object.entries(input || {})) {
    const col = findColumn(columns, field);
    if (!col) { unknown.push(field); continue; }
    const out = coerceOrNull(value, col.type);
    if (out === null) { refused.push({ column: col.name, type: col.type, value: String(value).slice(0, 60) }); continue; }
    data[col.key] = out;
  }
  return { data, unknown, refused };
}

export function shapeRow(columns, input) {
  return shapeRowDetailed(columns, input).data;
}

/* ─────────────────── tables ─────────────────── */

export async function listTables(userId) {
  return sql`
    select t.id, t.name, t.description, t.columns, t.created_at, t.updated_at,
           (select count(*)::int from data_table_rows r where r.table_id = t.id) as row_count
    from data_tables t
    where t.user_id = ${userId}
    order by t.updated_at desc
  `;
}

export async function getTable(id, userId) {
  const [row] = await sql`
    select id, name, description, columns, created_at, updated_at
    from data_tables where id = ${id} and user_id = ${userId}
  `;
  return row || null;
}

export async function createTable(userId, { name, description, columns }) {
  const clean = normalizeColumns(columns);
  if (!clean.length) return { error: 'A table needs at least one column.' };
  const id = crypto.randomUUID();
  await sql`
    insert into data_tables (id, user_id, name, description, columns)
    values (${id}, ${userId}, ${String(name || 'Table').trim().slice(0, 80)},
            ${String(description || '').trim().slice(0, 400)}, ${JSON.stringify(clean)}::jsonb)
  `;
  return { id, columns: clean };
}

/**
 * Renaming a column keeps its key, so the rows underneath follow it. Dropping
 * one leaves the value in the row untouched — invisible, but there if the
 * column comes back, and nothing is destroyed by a mis-click.
 */
export async function updateTable(id, userId, patch) {
  const current = await getTable(id, userId);
  if (!current) return { error: 'No such table.' };
  const name = patch.name !== undefined ? String(patch.name).trim().slice(0, 80) : current.name;
  const description = patch.description !== undefined
    ? String(patch.description).trim().slice(0, 400) : current.description;
  const columns = patch.columns !== undefined ? normalizeColumns(patch.columns) : current.columns;
  if (!columns.length) return { error: 'A table needs at least one column.' };
  await sql`
    update data_tables
       set name = ${name}, description = ${description},
           columns = ${JSON.stringify(columns)}::jsonb, updated_at = now()
     where id = ${id} and user_id = ${userId}
  `;
  return { id, name, description, columns };
}

export async function deleteTable(id, userId) {
  await sql`delete from data_tables where id = ${id} and user_id = ${userId}`;
  return { ok: true };
}

/* ─────────────────── rows ─────────────────── */

export async function listRows(tableId, { q = '', limit = 100, offset = 0 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  const term = (q || '').trim();
  const rows = term
    ? await sql`
        select id, data, written_by, created_at, updated_at
        from data_table_rows
        where table_id = ${tableId} and data::text ilike '%' || ${term} || '%'
        order by created_at limit ${lim} offset ${off}`
    : await sql`
        select id, data, written_by, created_at, updated_at
        from data_table_rows
        where table_id = ${tableId}
        order by created_at limit ${lim} offset ${off}`;
  const [{ total }] = term
    ? await sql`select count(*)::int as total from data_table_rows
                 where table_id = ${tableId} and data::text ilike '%' || ${term} || '%'`
    : await sql`select count(*)::int as total from data_table_rows where table_id = ${tableId}`;
  return { rows, total };
}

export async function addRow(table, input, writtenBy = 'user') {
  const id = crypto.randomUUID();
  const { data, unknown, refused } = shapeRowDetailed(table.columns, input);
  await sql`
    insert into data_table_rows (id, table_id, data, written_by)
    values (${id}, ${table.id}, ${JSON.stringify(data)}::jsonb, ${writtenBy})
  `;
  await sql`update data_tables set updated_at = now() where id = ${table.id}`;
  return { id, data, unknown, refused };
}

/** Only the fields passed are touched; the rest of the row stays as it was. */
export async function updateRow(table, rowId, input, writtenBy = 'user') {
  const [existing] = await sql`
    select id, data from data_table_rows where id = ${rowId} and table_id = ${table.id}
  `;
  if (!existing) return { error: 'No such row.' };
  const shaped = shapeRowDetailed(table.columns, input);
  const data = { ...existing.data, ...shaped.data };
  await sql`
    update data_table_rows
       set data = ${JSON.stringify(data)}::jsonb, written_by = ${writtenBy}, updated_at = now()
     where id = ${rowId} and table_id = ${table.id}
  `;
  await sql`update data_tables set updated_at = now() where id = ${table.id}`;
  return { id: rowId, data, changed: Object.keys(shaped.data).length, unknown: shaped.unknown, refused: shaped.refused };
}

export async function deleteRow(tableId, rowId) {
  await sql`delete from data_table_rows where id = ${rowId} and table_id = ${tableId}`;
  await sql`update data_tables set updated_at = now() where id = ${tableId}`;
  return { ok: true };
}

/* ─────────────────── what an AI Chatbot may reach ─────────────────── */

/**
 * The tables one chatbot is allowed to use: the ones its owner has, filtered
 * by the list ticked on the chatbot itself. Two gates, not one — ticking an id
 * that belongs to somebody else must not open it.
 */
export async function tablesForAgent(agent, ownerId) {
  const allowed = Array.isArray(agent && agent.tables) ? agent.tables : [];
  if (!allowed.length || !ownerId) return [];
  const rows = await listTables(ownerId);
  return rows.filter(t => allowed.includes(t.id));
}

/** Matching by name is what a model will try; ids are what the UI passes. */
export function findTable(tables, nameOrId) {
  const needle = String(nameOrId || '').trim().toLowerCase();
  return tables.find(t => t.id === nameOrId)
      || tables.find(t => (t.name || '').trim().toLowerCase() === needle)
      || null;
}

/**
 * The four things an AI Chatbot may do with the account's tables. Read, add
 * and update — never delete a row, and never change a table's shape: those
 * belong to the person whose account it is, not to a conversation.
 *
 * They are only offered when the chatbot has tables ticked, so a chatbot that
 * uses none carries none of this in its prompt.
 */
export const TABLE_TOOLS = [
  {
    name: 'table_list',
    description: 'List the tables you can use, with their columns. Call this first when you do not already know a table\'s columns.',
    schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'table_find',
    description: 'Search one table and get back matching rows, each with its row_id. Leave search empty to get the first rows.',
    schema: {
      type: 'object',
      properties: {
        table:  { type: 'string', description: 'The table name' },
        search: { type: 'string', description: 'Text to look for in any column' },
        limit:  { type: 'number', description: 'How many rows, at most 25' },
      },
      required: ['table'],
    },
  },
  {
    name: 'table_add_row',
    description: 'Add one row to a table. Pass the columns you know; the rest are left empty.',
    schema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'The table name' },
        row:   { type: 'object', description: 'The row, as column name to value' },
      },
      required: ['table', 'row'],
    },
  },
  {
    name: 'table_update_row',
    description: 'Change one row. Find it with table_find first — you need its row_id. Only the fields you pass are touched.',
    schema: {
      type: 'object',
      properties: {
        table:  { type: 'string', description: 'The table name' },
        row_id: { type: 'string', description: 'The row_id from table_find' },
        fields: { type: 'object', description: 'The columns to change, as column name to value' },
      },
      required: ['table', 'row_id', 'fields'],
    },
  },
];

/** What would not go in, and what the columns actually are. */
function trouble(table, result) {
  const parts = [];
  if (result.unknown && result.unknown.length) {
    parts.push(`"${table.name}" has no column called ${result.unknown.map(u => `"${u}"`).join(', ')}`);
  }
  for (const r of (result.refused || [])) {
    parts.push(`"${r.value}" is not a ${r.type} and column "${r.column}" only holds ${r.type}`);
  }
  const columns = (table.columns || []).map(c => `${c.name} (${c.type})`).join(', ');
  return `${parts.join('; ')}. The columns are: ${columns}.`;
}

/** A tool's answer to the model is text, including when it went wrong. */
export async function runAgentTableTool({ toolName, inputs = {}, agent, ownerId, writtenBy = 'agent' }) {
  const tables = await tablesForAgent(agent, ownerId);
  if (!tables.length) return 'No tables are enabled for this AI Chatbot.';

  if (toolName === 'table_list') {
    return JSON.stringify(tables.map(t => ({
      table: t.name,
      about: t.description || undefined,
      columns: (t.columns || []).map(c => `${c.name} (${c.type})`),
      rows: t.row_count,
    })), null, 1);
  }

  const table = findTable(tables, inputs.table);
  if (!table) {
    return `No table called "${inputs.table}" is enabled here. Available: ${tables.map(t => t.name).join(', ')}.`;
  }

  if (toolName === 'table_find') {
    const { rows, total } = await listRows(table.id, {
      q: inputs.search || '', limit: Math.min(parseInt(inputs.limit, 10) || 10, 25),
    });
    if (!rows.length) return `No rows in "${table.name}" match that.`;
    return JSON.stringify({
      total,
      showing: rows.length,
      rows: rows.map(r => ({ row_id: r.id, ...r.data })),
    }, null, 1);
  }

  if (toolName === 'table_add_row') {
    const asked = Object.keys(inputs.row || {}).length;
    const made = await addRow(table, inputs.row || {}, writtenBy);
    // An empty row reported as "Added a row" is how a chatbot came to tell
    // someone it had registered them for an event and store nothing at all.
    if (asked && !Object.keys(made.data).length) {
      return `Nothing was saved — ${trouble(table, made)} The row was added empty; fix the field names and update it with table_update_row, row_id ${made.id}.`;
    }
    return `Added a row to "${table.name}" (row_id ${made.id}): ${JSON.stringify(made.data)}`
         + (made.unknown.length || made.refused.length ? ` BUT ${trouble(table, made)}` : '');
  }

  if (toolName === 'table_update_row') {
    const asked = Object.keys(inputs.fields || {}).length;
    const saved = await updateRow(table, inputs.row_id, inputs.fields || {}, writtenBy);
    if (saved.error) return `${saved.error} Find the row with table_find first.`;
    if (asked && !saved.changed) return `Nothing was changed — ${trouble(table, saved)}`;
    return `Updated row ${saved.id} in "${table.name}": ${JSON.stringify(saved.data)}`
         + (saved.unknown.length || saved.refused.length ? ` BUT ${trouble(table, saved)}` : '');
  }

  return `Unknown table tool: ${toolName}`;
}

