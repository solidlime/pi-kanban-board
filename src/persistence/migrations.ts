// Schema v1 for v2 (see docs/REWRITE_V2_PLAN.md §2). Migrations are ordered and
// applied inside a transaction; the applied version lives in kv_meta.schema_version.
import type { Db } from "./db.js";
import { all, one, run, withTx } from "./db.js";

export interface Migration { version: number; name: string; up: (db: Db) => void }

const V1 = `
CREATE TABLE kv_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE project (
  project_id   TEXT PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Project-local id sequencing. One row per (project, entity kind) holding the last id
-- issued; bumped inside the same tx that inserts the entity, so a rollback rolls the id
-- back too. Ids are gapless per project and never global.
CREATE TABLE counters (
  project_id TEXT NOT NULL,
  name       TEXT NOT NULL,
  next       INTEGER NOT NULL,
  PRIMARY KEY (project_id, name),
  FOREIGN KEY (project_id) REFERENCES project(project_id) ON DELETE CASCADE
);

CREATE TABLE column_def (
  project_id TEXT NOT NULL,
  id         TEXT NOT NULL,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('todo','doing','done','custom')),
  ord        INTEGER NOT NULL,
  wip_limit  INTEGER,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id) REFERENCES project(project_id) ON DELETE CASCADE
);
CREATE INDEX idx_column_ord ON column_def (project_id, ord);

CREATE TABLE card (
  project_id     TEXT NOT NULL,
  id             INTEGER NOT NULL,
  column_id      TEXT NOT NULL,
  title          TEXT NOT NULL,
  body           TEXT NOT NULL DEFAULT '',
  priority       INTEGER NOT NULL DEFAULT 0,
  owner          TEXT,
  due            TEXT,
  estimate       REAL,
  blocked_reason TEXT,
  labels_json    TEXT NOT NULL DEFAULT '[]',
  session_id     TEXT,
  commit_sha     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  moved_at       TEXT NOT NULL,
  closed_at      TEXT,
  version        INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id) REFERENCES project(project_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, column_id) REFERENCES column_def(project_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_card_column ON card (project_id, column_id, priority DESC, id);
CREATE INDEX idx_card_updated ON card (project_id, updated_at, id);

CREATE TABLE dependency (
  project_id TEXT NOT NULL,
  from_card  INTEGER NOT NULL,
  to_card    INTEGER NOT NULL,
  type       TEXT NOT NULL DEFAULT 'blocks',
  PRIMARY KEY (project_id, from_card, to_card, type),
  FOREIGN KEY (project_id, from_card) REFERENCES card(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, to_card) REFERENCES card(project_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_dependency_to ON dependency (project_id, to_card);

CREATE TABLE deliverable (
  project_id TEXT NOT NULL,
  id         INTEGER NOT NULL,
  card_id    INTEGER,
  title      TEXT NOT NULL DEFAULT '',
  ref        TEXT NOT NULL DEFAULT '',
  kind       TEXT NOT NULL DEFAULT 'note',
  meta_json  TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id) REFERENCES project(project_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, card_id) REFERENCES card(project_id, id) ON DELETE SET NULL
);

CREATE TABLE attachment (
  project_id     TEXT NOT NULL,
  id             INTEGER NOT NULL,
  card_id        INTEGER,
  deliverable_id INTEGER,
  storage_key    TEXT NOT NULL,
  safe_name      TEXT NOT NULL,
  mime           TEXT NOT NULL DEFAULT 'application/octet-stream',
  size           INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id) REFERENCES project(project_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, card_id) REFERENCES card(project_id, id) ON DELETE SET NULL,
  FOREIGN KEY (project_id, deliverable_id) REFERENCES deliverable(project_id, id) ON DELETE SET NULL
);
CREATE INDEX idx_attachment_card ON attachment (project_id, card_id);
CREATE INDEX idx_attachment_deliv ON attachment (project_id, deliverable_id);

-- Append-only: no FK to project (a project delete must not rewrite history) and
-- UPDATE/DELETE are rejected by triggers below.
CREATE TABLE timeline_event (
  project_id  TEXT NOT NULL,
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  actor       TEXT NOT NULL DEFAULT 'system',
  payload_json TEXT NOT NULL DEFAULT '{}',
  at          TEXT NOT NULL
);
CREATE INDEX idx_timeline_project ON timeline_event (project_id, seq);
CREATE INDEX idx_timeline_entity ON timeline_event (project_id, entity_type, entity_id, seq);

CREATE TRIGGER timeline_event_no_update BEFORE UPDATE ON timeline_event
BEGIN SELECT RAISE(ABORT, 'timeline_event is append-only'); END;
CREATE TRIGGER timeline_event_no_delete BEFORE DELETE ON timeline_event
BEGIN SELECT RAISE(ABORT, 'timeline_event is append-only'); END;

CREATE TABLE saved_view (
  project_id TEXT NOT NULL,
  id         INTEGER NOT NULL,
  name       TEXT NOT NULL,
  query_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id) REFERENCES project(project_id) ON DELETE CASCADE
);
`;

// v2 adds what the first cut left as schema-only or missing: a card reference path, the
// template/loop tables, and a unique view name per board. `ALTER TABLE` is inside the
// migration tx like everything else (SQLite allows it; a failure rolls the whole version back).
const V2 = `
ALTER TABLE card ADD COLUMN ref TEXT;

CREATE TABLE card_template (
  project_id  TEXT NOT NULL,
  id          INTEGER NOT NULL,
  name        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  column_id   TEXT,
  priority    INTEGER NOT NULL DEFAULT 0,
  labels_json TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id) REFERENCES project(project_id) ON DELETE CASCADE
);

-- One row per project. No executor lives here: this is the observable half of the loop.
CREATE TABLE loop_state (
  project_id   TEXT PRIMARY KEY,
  status       TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','running','halted')),
  mode         TEXT NOT NULL DEFAULT 'suggest' CHECK (mode IN ('suggest','off')),
  started_at   TEXT,
  halted_at    TEXT,
  halt_reason  TEXT,
  last_tick_at TEXT,
  ticks        INTEGER NOT NULL DEFAULT 0,
  next_card_id INTEGER,
  FOREIGN KEY (project_id) REFERENCES project(project_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_saved_view_name ON saved_view (project_id, name);
`;

// v3 adds the daemon lock (A6): one row per (project, resource), no history. Expiry is a
// plain timestamp — a crashed holder is reclaimed by whoever reads next, not by a sweeper.
const V3 = `
CREATE TABLE card_lock (
  project_id TEXT NOT NULL,
  resource   TEXT NOT NULL,
  owner      TEXT NOT NULL,
  at         TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (project_id, resource),
  FOREIGN KEY (project_id) REFERENCES project(project_id) ON DELETE CASCADE
);
CREATE INDEX idx_lock_expiry ON card_lock (project_id, expires_at);
`;

// v4 makes running the default: a board is born started, and the two reasons the loop used to
// halt itself are undone. An explicit stop (or any other reason someone typed) is left alone:
// the row is the record of who stopped it and why. A budget halt comes back running with its
// ticks still at the cap, so raising maxLoops is what restarts it — the halt was not a lie.
const V4 = `
UPDATE loop_state SET status = 'running', halted_at = NULL, halt_reason = NULL
WHERE status = 'halted' AND halt_reason IN ('ready なカードが無い', 'maxLoops に達した');

UPDATE loop_state SET status = 'running', halted_at = NULL, halt_reason = NULL
WHERE status = 'idle';
`;

export const MIGRATIONS: Migration[] = [
  { version: 1, name: "v1-schema", up: (db) => { db.exec(V1); } },
  { version: 2, name: "v2-extras", up: (db) => { db.exec(V2); } },
  { version: 3, name: "v3-locks", up: (db) => { db.exec(V3); } },
  { version: 4, name: "v4-running-default", up: (db) => { db.exec(V4); } },
];

export const SCHEMA_VERSION_KEY = "schema_version";
export const LATEST_SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

/** Applied version (0 = never migrated). */
export function schemaVersion(db: Db): number {
  // A brand new file has no kv_meta yet; that is version 0, not an error.
  if (!tableExists(db, "kv_meta")) return 0;
  const row = one<{ v: string }>(db, "SELECT v FROM kv_meta WHERE k = ?", SCHEMA_VERSION_KEY);
  return row ? Number(row.v) : 0;
}

export function tableExists(db: Db, name: string): boolean {
  return one(db, "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", name) !== undefined;
}

/** Apply every pending migration in its own tx; safe to call on every open. */
export function migrate(db: Db, target: number = LATEST_SCHEMA_VERSION): { from: number; to: number; applied: number[] } {
  const from = schemaVersion(db);
  const applied: number[] = [];
  for (const m of MIGRATIONS) {
    if (m.version <= from) continue;
    if (m.version > target) break;
    withTx(db, () => {
      m.up(db);
      run(db, "INSERT INTO kv_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", SCHEMA_VERSION_KEY, String(m.version));
      applied.push(m.version);
    });
  }
  return { from, to: schemaVersion(db), applied };
}

/** Columns present on a table — handy for drift checks in tests. */
export function columnsOf(db: Db, table: string): string[] {
  return all<{ name: string }>(db, `PRAGMA table_info(${table})`).map(r => r.name);
}
