// Board persistence for pi-kanban-board: one sqlite file instead of a JSON file per
// board.
//
// Why: writeBoard() was read-modify-write on a JSON file with no transaction. Its own
// comment admitted the failure - "a fixed name lets a concurrent writer rename our tmp
// and persist ITS content under our name, silently dropping cards". Two processes
// sharing ~/.pi/kanban (a resident HTTP server and an in-process extension) could already
// lose cards. A transaction removes that class of bug; nothing here is about speed.
//
// This module only does rows. It does not know about scopes, sessions or paths.

import { createRequire } from "node:module";

// node:sqlite is sync-only from the caller's point of view: readBoard() is called from
// dozens of plain functions, so the require has to be as well. A dynamic import() would
// make every one of them async.
const req = createRequire(import.meta.url);

export type Col = "todo" | "doing" | "done";

export type Card = {
	id: number;
	text: string;
	col: Col;
	img?: string;
	movedAt?: number;
	movedBy?: string;
	priority?: number;
	nextFireAt?: string;
	blocked?: string;
	firedFor?: string;
	project?: string;
};

export type Board = { cards: Card[]; nextId: number };

/** A board is a (scope, sid) pair. Global boards use sid = "". */
export type BoardKey = { scope: "global" | "session"; sid: string };

export type KanbanDb = {
	readBoard(key: BoardKey): Board | null;
	writeBoard(key: BoardKey, b: Board): void;
	/** Monotonic per-board counter: the diskSnapshot signal now that there is no inode. */
	revOf(key: BoardKey): number;
	/** Insert a board only if it has never been written. Returns false when it existed. */
	importBoard(key: BoardKey, b: Board): boolean;
	/** Drop session boards untouched for longer than cutoff (ms). Returns rows deleted. */
	sweepSessions(cutoff: number): number;
	/** Drop a whole board. Tests use this to reproduce "no boards at all". */
	deleteBoard(key: BoardKey): void;
	/** Every session board, newest touch first - the replacement for readdir(SESSIONS_DIR). */
	sessionKeys(): { sid: string; touchedAt: number }[];
	close(): void;
};

const SCHEMA = [
	"CREATE TABLE IF NOT EXISTS board (",
	"  scope TEXT NOT NULL,",
	"  sid TEXT NOT NULL,",
	"  next_id INTEGER NOT NULL,",
	"  rev INTEGER NOT NULL DEFAULT 0,",
	"  touched_at INTEGER NOT NULL,",
	"  PRIMARY KEY (scope, sid)",
	");",
	"CREATE TABLE IF NOT EXISTS card (",
	"  scope TEXT NOT NULL,",
	"  sid TEXT NOT NULL,",
	"  id INTEGER NOT NULL,",
	"  ord INTEGER NOT NULL,",
	"  text TEXT NOT NULL,",
	"  col TEXT NOT NULL,",
	"  img TEXT, moved_at INTEGER, moved_by TEXT, priority INTEGER,",
	"  next_fire_at TEXT, blocked TEXT, fired_for TEXT, project TEXT,",
	"  PRIMARY KEY (scope, sid, id)",
	");",
	"CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);",
].join("\n");

type Row = Record<string, unknown>;

/**
 * sqlite needs a value per column, so an absent optional field is stored as NULL and
 * must come back absent - not as the string "null" or as 0.
 */
function optionalText(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}
function optionalNumber(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function rowToCard(r: Row): Card {
	const card: Card = { id: Number(r.id), text: String(r.text), col: String(r.col) as Col };
	const img = optionalText(r.img);
	if (img !== undefined) card.img = img;
	const movedAt = optionalNumber(r.moved_at);
	if (movedAt !== undefined) card.movedAt = movedAt;
	const movedBy = optionalText(r.moved_by);
	if (movedBy !== undefined) card.movedBy = movedBy;
	const priority = optionalNumber(r.priority);
	if (priority !== undefined) card.priority = priority;
	const nextFireAt = optionalText(r.next_fire_at);
	if (nextFireAt !== undefined) card.nextFireAt = nextFireAt;
	const blocked = optionalText(r.blocked);
	if (blocked !== undefined) card.blocked = blocked;
	const firedFor = optionalText(r.fired_for);
	if (firedFor !== undefined) card.firedFor = firedFor;
	const project = optionalText(r.project);
	if (project !== undefined) card.project = project;
	return card;
}

/** Open (creating if needed) the board database. Callers own the single instance. */
export function openKanbanDb(file: string): KanbanDb {
	// node:sqlite is still flagged experimental, and its warning is noise the user cannot
	// act on. Every other warning must still reach stderr.
	const emit = process.emitWarning;
	process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
		const text = typeof warning === "string" ? warning : warning.message;
		if (text.includes("SQLite")) return;
		return (emit as (...a: unknown[]) => void).call(process, warning, ...rest);
	}) as typeof process.emitWarning;
	let mod: typeof import("node:sqlite");
	try {
		mod = req("node:sqlite") as typeof import("node:sqlite");
	} finally {
		process.emitWarning = emit;
	}
	if (typeof mod.DatabaseSync !== "function") {
		throw new Error("node:sqlite is unavailable; pi-kanban-board needs Node 22.5 or newer");
	}
	const db = new mod.DatabaseSync(file);
	// WAL lets the dashboard process read while the extension writes. busy_timeout turns
	// the transient SQLITE_BUSY into a wait instead of an exception.
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA busy_timeout = 3000");
	db.exec(SCHEMA);

	const selectBoard = db.prepare("SELECT next_id FROM board WHERE scope = ? AND sid = ?");
	const selectCards = db.prepare(
		"SELECT id, text, col, img, moved_at, moved_by, priority, next_fire_at, blocked, fired_for, project FROM card WHERE scope = ? AND sid = ? ORDER BY ord",
	);
	const selectRev = db.prepare("SELECT rev FROM board WHERE scope = ? AND sid = ?");
	const insertBoard = db.prepare(
		"INSERT INTO board (scope, sid, next_id, rev, touched_at) VALUES (?, ?, ?, 1, ?)",
	);
	const countBoard = db.prepare("SELECT 1 AS hit FROM board WHERE scope = ? AND sid = ?");
	const upsertBoard = db.prepare(
		"UPDATE board SET next_id = ?, rev = rev + 1, touched_at = ? WHERE scope = ? AND sid = ?",
	);
	const deleteBoardRow = db.prepare("DELETE FROM board WHERE scope = ? AND sid = ?");
	const deleteAllCards = db.prepare("DELETE FROM card WHERE scope = ? AND sid = ?");
	const deleteStaleCards = db.prepare(
		"DELETE FROM card WHERE scope = ? AND sid = ? AND id NOT IN (SELECT value FROM json_each(?))",
	);
	const insertCard = db.prepare(
		"INSERT OR REPLACE INTO card (scope, sid, id, ord, text, col, img, moved_at, moved_by, priority, next_fire_at, blocked, fired_for, project) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	);
	const sweep = db.prepare("DELETE FROM board WHERE scope = 'session' AND touched_at < ?");

	const readBoard = (key: BoardKey): Board | null => {
		const head = selectBoard.get(key.scope, key.sid) as Row | undefined;
		if (!head) return null;
		const rows = selectCards.all(key.scope, key.sid) as Row[];
		return { cards: rows.map(rowToCard), nextId: Number(head.next_id) };
	};

	return {
		readBoard,
		// One transaction: a reader never sees half a board, and a concurrent writer waits
		// instead of overwriting. Cards that vanished from the array are deleted by id so a
		// removed card cannot come back on the next read.
		writeBoard(key, b) {
			const now = Date.now();
			db.exec("BEGIN IMMEDIATE");
			try {
				if (countBoard.get(key.scope, key.sid)) {
					upsertBoard.run(b.nextId, now, key.scope, key.sid);
				} else {
					insertBoard.run(key.scope, key.sid, b.nextId, now);
				}
				const ids = JSON.stringify(b.cards.map((c) => c.id));
				deleteStaleCards.run(key.scope, key.sid, ids);
				for (let i = 0; i < b.cards.length; i++) {
					const c = b.cards[i];
					insertCard.run(
						key.scope,
						key.sid,
						c.id,
						i,
						c.text ?? "",
						c.col ?? "todo",
						c.img ?? null,
						c.movedAt ?? null,
						c.movedBy ?? null,
						c.priority ?? null,
						c.nextFireAt ?? null,
						c.blocked ?? null,
						c.firedFor ?? null,
						c.project ?? null,
					);
				}
				db.exec("COMMIT");
			} catch (err) {
				db.exec("ROLLBACK");
				throw err;
			}
		},
		revOf(key) {
			const row = selectRev.get(key.scope, key.sid) as Row | undefined;
			return row ? Number(row.rev) : 0;
		},
		// INSERT only: an existing board wins. That keeps the import idempotent, so a JSON
		// file left on disk can never overwrite a newer sqlite state.
		importBoard(key, b) {
			if (countBoard.get(key.scope, key.sid)) return false;
			const now = Date.now();
			db.exec("BEGIN IMMEDIATE");
			try {
				insertBoard.run(key.scope, key.sid, b.nextId, now);
				deleteAllCards.run(key.scope, key.sid);
				for (let i = 0; i < b.cards.length; i++) {
					const c = b.cards[i];
					insertCard.run(
						key.scope,
						key.sid,
						c.id,
						i,
						c.text ?? "",
						c.col ?? "todo",
						c.img ?? null,
						c.movedAt ?? null,
						c.movedBy ?? null,
						c.priority ?? null,
						c.nextFireAt ?? null,
						c.blocked ?? null,
						c.firedFor ?? null,
						c.project ?? null,
					);
				}
				db.exec("COMMIT");
			} catch (err) {
				db.exec("ROLLBACK");
				throw err;
			}
			return true;
		},
		deleteBoard(key) {
			deleteAllCards.run(key.scope, key.sid);
			deleteBoardRow.run(key.scope, key.sid);
		},
		sessionKeys() {
			return db
				.prepare(
					"SELECT sid, touched_at AS touchedAt FROM board WHERE scope = 'session' ORDER BY touched_at DESC",
				)
				.all() as { sid: string; touchedAt: number }[];
		},
		sweepSessions(cutoff) {
			const info = sweep.run(cutoff);
			return Number(info.changes ?? 0);
		},
		close() {
			db.close();
		},
	};
}
