// SQLite access for v2 (node:sqlite). One file, WAL, FK on, busy wait, and a tx helper.
// Every write path in repos.ts goes through withTx so state change + timeline append land together.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = DatabaseSync;

export interface OpenDbOptions {
  /** 0 disables the wal pragma (memory DBs report "memory" and cannot use it). */
  wal?: boolean;
  busyTimeoutMs?: number;
}

/**
 * Open (creating if needed) a SQLite file with the pragmas v2 depends on:
 * WAL for concurrent readers, busy_timeout so a second writer waits instead of
 * throwing SQLITE_BUSY, foreign_keys=ON because the schema enforces composite FKs.
 */
export function openDb(path: string, opts: OpenDbOptions = {}): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(opts.busyTimeoutMs ?? 5000))}`);
  db.exec("PRAGMA foreign_keys = ON");
  if (opts.wal !== false) db.exec("PRAGMA journal_mode = WAL");
  return db;
}

/** True when the downgrade pragma actually took effect (always false for :memory:). */
export function journalMode(db: Db): string {
  const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
  return row?.journal_mode ?? "";
}

export function closeDb(db: Db): void {
  try { db.close(); } catch { /* already closed */ }
}

// shortcut: no nested transactions — a repo never opens a tx inside another repo's.
// Upgrade to savepoint counters if repos start composing.
export function withTx<T>(db: Db, fn: (db: Db) => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn(db);
    db.exec("COMMIT");
    return out;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* tx already gone */ }
    throw err;
  }
}

export function one<T>(db: Db, sql: string, ...params: (string | number | null)[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function all<T>(db: Db, sql: string, ...params: (string | number | null)[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function run(db: Db, sql: string, ...params: (string | number | null)[]): { changes: number; lastInsertRowid: number } {
  const r = db.prepare(sql).run(...params);
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}
