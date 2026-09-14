"""SQLite storage. Same schema as the original service, so existing data carries over."""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / 'data'
PLANS_DIR = ROOT / 'plans'
DB_PATH = Path(os.environ.get('HW_DB_PATH') or DATA_DIR / 'healthwise.db')

DATA_DIR.mkdir(parents=True, exist_ok=True)
PLANS_DIR.mkdir(parents=True, exist_ok=True)

# One connection shared by FastAPI's worker threads, serialised by a lock.
# Autocommit mode matches how the original service wrote.
_conn = sqlite3.connect(DB_PATH, check_same_thread=False, isolation_level=None)
_conn.row_factory = sqlite3.Row
_lock = threading.RLock()

SCHEMA = """
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
  status TEXT DEFAULT 'planned',        -- planned | eaten | missed | swapped | added | offplan
  swapped_from TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_entries_user_date ON plan_entries(user_id, date);

CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  date TEXT NOT NULL,
  slot TEXT,
  modality TEXT,                        -- photo | voice | text | menu
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
  verdict TEXT,                         -- matched | unplanned | flagged
  block_reason TEXT,
  matched_entry_id INTEGER REFERENCES plan_entries(id)
);

-- Every proposal an agent makes. Nothing here is applied until the engine
-- validates it and either auto-applies or a dietitian approves.
CREATE TABLE IF NOT EXISTS plan_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,                   -- swap | parse_review | exposure
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
  status TEXT DEFAULT 'queued',         -- queued | sent | opened | ignored | escalated
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
"""

with _lock:
    _conn.execute('PRAGMA journal_mode = WAL')
    _conn.execute('PRAGMA foreign_keys = ON')
    _conn.executescript(SCHEMA)
    # Additive migrations for databases created before a column existed.
    for _table, _col, _type in [('plan_entries', 'flag', 'TEXT')]:
        _cols = [r['name'] for r in _conn.execute(f'PRAGMA table_info({_table})')]
        if _col not in _cols:
            _conn.execute(f'ALTER TABLE {_table} ADD COLUMN {_col} {_type}')

# Tables wiped by a demo reset, in FK-safe order.
RESETTABLE = [
    'checkin_items', 'checkins', 'plan_changes', 'nudges', 'events',
    'traces', 'plan_entries', 'plan_items', 'plan_days', 'plans',
    'cohort_stats', 'partners', 'users',
]

# What survives a reset that keeps the parsed documents.
PLAN_TABLES = ['plans', 'plan_days', 'plan_items', 'users']


def wipe(keep_plans: bool = False) -> None:
    """Clear demo state. keep_plans preserves users and parsed documents, so a reset costs nothing at the API."""
    tables = [t for t in RESETTABLE if t not in PLAN_TABLES] if keep_plans else RESETTABLE
    with _lock:
        _conn.execute('PRAGMA foreign_keys = OFF')
        for t in tables:
            _conn.execute(f'DELETE FROM {t}')
        placeholders = ','.join('?' for _ in tables)
        _conn.execute(f'DELETE FROM sqlite_sequence WHERE name IN ({placeholders})', tables)
        _conn.execute('PRAGMA foreign_keys = ON')


def all_rows(sql: str, *params) -> list[dict]:
    with _lock:
        return [dict(r) for r in _conn.execute(sql, params).fetchall()]


def get_row(sql: str, *params) -> dict | None:
    with _lock:
        row = _conn.execute(sql, params).fetchone()
    return dict(row) if row else None


def run(sql: str, *params):
    with _lock:
        return _conn.execute(sql, params)


def to_json(value) -> str:
    """Compact JSON, like JSON.stringify."""
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False, default=str)


def _normalise(v):
    """SQLite takes no booleans or containers — coerce at the boundary."""
    if v is None:
        return None
    if isinstance(v, bool):
        return 1 if v else 0
    if isinstance(v, (dict, list, tuple)):
        return to_json(v)
    return v


def insert(table: str, obj: dict) -> int:
    keys = list(obj.keys())
    sql = f"INSERT INTO {table} ({','.join(keys)}) VALUES ({','.join('?' for _ in keys)})"
    with _lock:
        cur = _conn.execute(sql, [_normalise(obj[k]) for k in keys])
        return int(cur.lastrowid)


def from_json(value, fallback):
    if value is None:
        return fallback
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return fallback
