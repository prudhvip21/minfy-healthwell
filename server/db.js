import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const PLANS_DIR = path.join(ROOT, 'plans');
const DB_PATH = path.join(DATA_DIR, 'healthwise.db');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(PLANS_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  age INTEGER,
  sex TEXT,
  goal TEXT,
  conditions_json TEXT DEFAULT '[]',
  diet TEXT,
  allergies_json TEXT DEFAULT '[]',
  persona TEXT,
  cohort TEXT,
  start_date TEXT,
  tz TEXT DEFAULT 'Asia/Kolkata',
  avatar TEXT
);

-- A parsed dietitian plan. One row per source document.
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  source_file TEXT,
  file_hash TEXT,
  start_date TEXT,
  duration_days INTEGER DEFAULT 7,
  targets_json TEXT DEFAULT '{}',
  guidance_json TEXT DEFAULT '[]',
  parse_status TEXT DEFAULT 'seeded',   -- seeded | parsed | failed
  parse_note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- The repeating cycle: Day 1..N as authored by the dietitian.
CREATE TABLE IF NOT EXISTS plan_days (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  day_index INTEGER NOT NULL,
  label TEXT
);

CREATE TABLE IF NOT EXISTS plan_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_day_id INTEGER NOT NULL REFERENCES plan_days(id) ON DELETE CASCADE,
  slot TEXT NOT NULL,
  time_hint TEXT,
  name TEXT NOT NULL,
  qty REAL,
  unit TEXT,
  kcal REAL, protein_g REAL, carbs_g REAL, fat_g REAL,
  notes TEXT,
  confidence REAL DEFAULT 1.0,
  source_text TEXT,
  macro_source TEXT DEFAULT 'plan'      -- plan | estimated
);

-- The cycle materialised onto calendar dates. This is the table the whole
-- app reads, and the ONLY table an agent may never write to directly.
CREATE TABLE IF NOT EXISTS plan_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  date TEXT NOT NULL,
  slot TEXT NOT NULL,
  time_hint TEXT,
  plan_item_id INTEGER REFERENCES plan_items(id),
  name TEXT NOT NULL,
  qty REAL, unit TEXT,
  kcal REAL, protein_g REAL, carbs_g REAL, fat_g REAL,
  macro_source TEXT DEFAULT 'plan',
  status TEXT DEFAULT 'planned',        -- planned | eaten | missed | swapped | added
  swapped_from TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_entries_user_date ON plan_entries(user_id, date);

CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  date TEXT NOT NULL,
  slot TEXT,
  modality TEXT,                        -- photo | voice | text
  raw_text TEXT,
  transcript TEXT,
  image_ref TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_checkins_user_date ON checkins(user_id, date);

CREATE TABLE IF NOT EXISTS checkin_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  checkin_id INTEGER NOT NULL REFERENCES checkins(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  qty REAL, unit TEXT,
  kcal REAL, protein_g REAL, carbs_g REAL, fat_g REAL,
  confidence REAL,
  verdict TEXT,                         -- matched | unplanned | blocked
  block_reason TEXT,
  matched_entry_id INTEGER REFERENCES plan_entries(id)
);

-- Every proposal an agent makes. Nothing here is applied until the engine
-- validates it and either auto-applies or a dietitian approves.
CREATE TABLE IF NOT EXISTS plan_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,                   -- swap | parse_review | event
  summary TEXT,
  proposal_json TEXT,
  engine_json TEXT,
  confidence REAL,
  status TEXT DEFAULT 'pending',        -- pending | approved | rejected | auto_applied
  reason TEXT,
  reviewer TEXT,
  trace_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS nudges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  channel TEXT,                         -- push | whatsapp | inapp
  send_at TEXT,
  copy TEXT,
  rationale_json TEXT,
  cohort TEXT,
  status TEXT DEFAULT 'queued',         -- queued | sent | opened | ignored
  trace_id INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Stands in for the warehouse. Score and funnel read from here.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT REFERENCES users(id),
  type TEXT NOT NULL,
  payload_json TEXT,
  ts TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id, type);

-- Stands in for Langfuse.
CREATE TABLE IF NOT EXISTS traces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  route TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  input_json TEXT,
  output_json TEXT,
  tool_calls_json TEXT,
  latency_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  confidence REAL,
  guardrail_json TEXT,
  status TEXT,                          -- ok | blocked | degraded | error
  error TEXT,
  ts TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_traces_ts ON traces(ts DESC);

CREATE TABLE IF NOT EXISTS partners (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  brand_json TEXT DEFAULT '{}',
  enabled_json TEXT DEFAULT '[]',
  rate_limit INTEGER DEFAULT 1000,
  active INTEGER DEFAULT 0
);

-- Synthetic warehouse rows behind the engagement funnel.
CREATE TABLE IF NOT EXISTS cohort_stats (
  cohort TEXT NOT NULL,
  week INTEGER NOT NULL,
  retained INTEGER,
  total INTEGER,
  PRIMARY KEY (cohort, week)
);
`;

db.exec(SCHEMA);

// Additive migrations for databases created before a column existed.
for (const [table, col, type] of [['plan_entries', 'flag', 'TEXT']]) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}

/** Tables wiped by a demo reset, in FK-safe order. */
const RESETTABLE = [
  'checkin_items', 'checkins', 'plan_changes', 'nudges', 'events',
  'traces', 'plan_entries', 'plan_items', 'plan_days', 'plans',
  'cohort_stats', 'partners', 'users',
];

/** What survives a reset that keeps the parsed documents. */
const PLAN_TABLES = ['plans', 'plan_days', 'plan_items', 'users'];

/**
 * @param {{keepPlans?: boolean}} opts keepPlans preserves users and the parsed
 *   plan documents, so a demo reset costs nothing at the API.
 */
export function wipe({ keepPlans = false } = {}) {
  const tables = keepPlans ? RESETTABLE.filter((t) => !PLAN_TABLES.includes(t)) : RESETTABLE;
  db.exec('PRAGMA foreign_keys = OFF');
  for (const t of tables) db.exec(`DELETE FROM ${t}`);
  db.exec(`DELETE FROM sqlite_sequence WHERE name IN ('${tables.join("','")}')`);
  db.exec('PRAGMA foreign_keys = ON');
}

/* ------------------------------------------------------------------ *
 * Thin query helpers. node:sqlite returns null-prototype objects, so
 * everything is spread into a plain object before it leaves this file.
 * ------------------------------------------------------------------ */

export function all(sql, ...params) {
  return db.prepare(sql).all(...params).map((r) => ({ ...r }));
}

export function get(sql, ...params) {
  const row = db.prepare(sql).get(...params);
  return row ? { ...row } : undefined;
}

export function run(sql, ...params) {
  return db.prepare(sql).run(...params);
}

export function insert(table, obj) {
  const keys = Object.keys(obj);
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  const info = db.prepare(sql).run(...keys.map((k) => normalise(obj[k])));
  return Number(info.lastInsertRowid);
}

/** SQLite takes no booleans, undefined, or objects — coerce at the boundary. */
function normalise(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

export function json(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}
