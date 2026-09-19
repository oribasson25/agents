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

/** A value is stored in the shape its column promises, or not at all. */
export function coerce(value, type) {
  if (value === null || value === undefined || value === '') return '';
  if (type === 'number') {
    const n = Number(String(value).replace(/,/g, ''));
    return Number.isFinite(n) ? n : '';
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    return ['true', 'yes', '1', 'כן'].includes(String(value).trim().toLowerCase());
  }
  if (type === 'date') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? String(value).slice(0, 40) : d.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 4000);
}

/** Only the columns the table has, each in its own type. */
export function shapeRow(columns, input) {
  const out = {};
  for (const col of columns) {
    if (Object.prototype.hasOwnProperty.call(input || {}, col.key)) out[col.key] = coerce(input[col.key], col.type);
    else if (Object.prototype.hasOwnProperty.call(input || {}, col.name)) out[col.key] = coerce(input[col.name], col.type);
  }
  return out;
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
  const data = shapeRow(table.columns, input);
  await sql`
    insert into data_table_rows (id, table_id, data, written_by)
    values (${id}, ${table.id}, ${JSON.stringify(data)}::jsonb, ${writtenBy})
  `;
  await sql`update data_tables set updated_at = now() where id = ${table.id}`;
  return { id, data };
}

/** Only the fields passed are touched; the rest of the row stays as it was. */
export async function updateRow(table, rowId, input, writtenBy = 'user') {
  const [existing] = await sql`
    select id, data from data_table_rows where id = ${rowId} and table_id = ${table.id}
  `;
  if (!existing) return { error: 'No such row.' };
  const data = { ...existing.data, ...shapeRow(table.columns, input) };
  await sql`
    update data_table_rows
       set data = ${JSON.stringify(data)}::jsonb, written_by = ${writtenBy}, updated_at = now()
     where id = ${rowId} and table_id = ${table.id}
  `;
  await sql`update data_tables set updated_at = now() where id = ${table.id}`;
  return { id: rowId, data };
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
    const made = await addRow(table, inputs.row || {}, writtenBy);
    return `Added a row to "${table.name}" (row_id ${made.id}): ${JSON.stringify(made.data)}`;
  }

  if (toolName === 'table_update_row') {
    const saved = await updateRow(table, inputs.row_id, inputs.fields || {}, writtenBy);
    if (saved.error) return `${saved.error} Find the row with table_find first.`;
    return `Updated row ${saved.id} in "${table.name}": ${JSON.stringify(saved.data)}`;
  }

  return `Unknown table tool: ${toolName}`;
}

