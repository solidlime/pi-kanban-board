// Board persistence for pi-kanban-board: one sqlite file instead of a JSON file per
// board.
//
// Why: writeBoard() was read-modify-write on a JSON file with no transaction. Its own
// comment admitted the failure - "a fixed name lets a concurrent writer rename our tmp
// and persist ITS content under our name, silently dropping cards". Two processes
// sharing ~/.pi/kanban (a resident HTTP server and an in-process extension) could already
// lose cards. A transaction removes that class of bug; nothing here is about speed.
//
// This module only does rows. It does not know about paths, and its only opinion about
// scopes is dropNonProject(), the one-shot #17 reset that keeps project rows and deletes
// the rest: which board a request may touch is decided by the caller, never here.

import { createRequire } from "node:module";

// node:sqlite is sync-only from the caller's point of view: readBoard() is called from
// dozens of plain functions, so the require has to be as well. A dynamic import() would
// make every one of them async.
const req = createRequire(import.meta.url);

// #67: "deliverable" is the 4th column - a place for output (cards with attachments), outside
// TODO/DOING/DONE. The sqlite `col` column is plain TEXT with no CHECK, so widening this
// union is the whole schema story.
export type Col = "todo" | "doing" | "done" | "deliverable";

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
	/** #20: the conversation this card came from (A-Za-z0-9._:@-, max 128). */
	sessionId?: string;
	/** #20: 7-40 lowercase hex: the commit this card is about. */
	commit?: string;
	/**
	 * #22: labels (bug / feature / chore / 調査) as a JSON array. This module does not know
	 * the allowed set - kanban.ts validates on write. Reading stays lenient: a broken or
	 * unknown value is dropped, never thrown (same rule as priorityOf).
	 */
	labels?: string[];
	/** YYYY-MM-DD only: a deadline is a date, not an instant. */
	due?: string;
	/** Points, integer >= 0. */
	estimate?: number;
	/** Cards this one WAITS FOR (it stays blocked until they are done). Filled in from card_dep. */
	blocks?: number[];
};

export type Board = { cards: Card[]; nextId: number };

/**
 * A board is a (scope, sid) pair. Global boards use sid = "".
 * "project" boards key on a cwd slug (kanban.ts owns what a slug is); this module only
 * stores the string.
 */
export type BoardKey = { scope: "global" | "project"; sid: string };

/** A project lives outside any board: `card.project` is its slug, so one project can span boards. */
export type Project = {
	slug: string;
	name: string;
	createdAt: number;
	updatedAt: number;
};

/** One line of the decision log. `why` is what makes it worth keeping. */
export type Decision = {
	id: number;
	/** "" means a decision that is not tied to a single project. */
	slug: string;
	at: number;
	text: string;
	why?: string;
};

export type KanbanDb = {
	readBoard(key: BoardKey): Board | null;
	writeBoard(key: BoardKey, b: Board): void;
	/** Monotonic per-board counter: the diskSnapshot signal now that there is no inode. */
	revOf(key: BoardKey): number;
	/** #36: the spelling this board is stored under; every sid match is COLLATE NOCASE, so the caller's spelling is not the board's. */
	boardSid(key: BoardKey): string | null;
	/** Insert a board only if it has never been written. Returns false when it existed. */
	importBoard(key: BoardKey, b: Board): boolean;
	/** Drop a whole board. Tests use this to reproduce "no boards at all". */
	deleteBoard(key: BoardKey): void;
	/**
	 * #17: one-shot reset - drop every board whose scope is not project, with its cards and
	 * deps. The session model's rows are unenumerable from outside (no sessionKeys any more),
	 * so the reset cannot be composed out of deleteBoard() alone. Returns boards removed.
	 * No `keep` argument on purpose: the only surviving scope is project, and a caller that
	 * could pass anything else is one typo away from deleting every project board.
	 */
	dropNonProject(): number;
	/** Every project board key with its rev, in slug order. */
	projectKeys(): { slug: string; touchedAt: number; rev: number }[];
	/**
	 * Every project board's cards, keyed by slug: slug ascending, card id ascending inside a
	 * board (the same order aggregateGlobal() builds). Two queries total, not one per board.
	 */
	listProjectBoards(): { slug: string; cards: Card[] }[];
	/** Every project, most recently touched first. */
	listProjects(): Project[];
	/** Read one project, or null. */
	readProject(slug: string): Project | null;
	/** Upsert by slug. Returns false when the project did not exist yet. */
	writeProject(slug: string, name: string): boolean;
	/** Drops the project and its decision log. Returns how many decisions went with it. */
	deleteProject(slug: string): number;
	/** Newest first. Omit the slug for the whole log. */
	listDecisions(slug?: string): Decision[];
	addDecision(slug: string, text: string, why?: string, at?: number): Decision;
	deleteDecision(id: number): boolean;
	/** Small key/value store for one-shot flags (schema work). */
	getMeta(k: string): string | null;
	setMeta(k: string, v: string): void;
	/** Fold the WAL back into the main file so a plain file copy is complete. */
	checkpoint(): void;
	/** #13: read-only health numbers for the settings tab. */
	maintenance(): { integrity: string; pages: number; freelist: number; pageSize: number };
	/** #13: compact the file. Throws on failure; the caller turns it into a 500. */
	vacuum(): void;
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
	"  due TEXT, estimate INTEGER,",
	"  session_id TEXT, commit_sha TEXT, labels TEXT,",
	"  PRIMARY KEY (scope, sid, id)",
	");",
	// Dependencies live outside card: they are a relation, and rewriting one card's
	// dependency list must not touch its row (or its rev).
	"CREATE TABLE IF NOT EXISTS card_dep (",
	"  scope TEXT NOT NULL, sid TEXT NOT NULL,",
	"  card_id INTEGER NOT NULL, blocks_id INTEGER NOT NULL,",
	"  PRIMARY KEY (scope, sid, card_id, blocks_id)",
	");",
	// New tables need no ALTER guard: SCHEMA runs on every open, so CREATE TABLE IF NOT
	// EXISTS *is* the migration. user_version stays a marker (see below), not a gate.
	"CREATE TABLE IF NOT EXISTS project (",
	"  slug TEXT PRIMARY KEY,",
	"  name TEXT NOT NULL,",
	"  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL",
	");",
	"CREATE TABLE IF NOT EXISTS decision (",
	"  id INTEGER PRIMARY KEY AUTOINCREMENT,",
	"  slug TEXT NOT NULL, at INTEGER NOT NULL,",
	"  text TEXT NOT NULL, why TEXT",
	");",
	"CREATE INDEX IF NOT EXISTS decision_by_slug ON decision (slug, at DESC);",
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

/**
 * #22: the label column is JSON text. Only an array of strings is adopted; anything else
 * (NULL, a torn value, a hand-edited row) comes back as "no labels" - a read must never
 * throw over one bad cell. The allowed vocabulary is checked in kanban.ts, not here.
 */
function optionalLabels(v: unknown): string[] | undefined {
	if (typeof v !== "string" || v.length === 0) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(v);
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed)) return undefined;
	const out = parsed.filter((x): x is string => typeof x === "string");
	return out.length === 0 ? undefined : out;
}

/** #22: absent and empty are the same thing, exactly like blocks. */
function labelColumn(c: Card): string | null {
	return c.labels !== undefined && c.labels.length > 0 ? JSON.stringify(c.labels) : null;
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
	const sessionId = optionalText(r.session_id);
	if (sessionId !== undefined) card.sessionId = sessionId;
	const commit = optionalText(r.commit_sha);
	if (commit !== undefined) card.commit = commit;
	const labels = optionalLabels(r.labels);
	if (labels !== undefined) card.labels = labels;
	const due = optionalText(r.due);
	if (due !== undefined) card.due = due;
	const estimate = optionalNumber(r.estimate);
	if (estimate !== undefined) card.estimate = estimate;
	return card;
}

function rowToProject(r: Row): Project {
	return {
		slug: String(r.slug),
		name: String(r.name),
		createdAt: Number(r.created_at),
		updatedAt: Number(r.updated_at),
	};
}

function rowToDecision(r: Row): Decision {
	const d: Decision = { id: Number(r.id), slug: String(r.slug), at: Number(r.at), text: String(r.text) };
	const why = optionalText(r.why);
	if (why !== undefined) d.why = why;
	return d;
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

	// CREATE TABLE IF NOT EXISTS cannot add a column to a table that already exists, so the
	// upgrade is an ALTER driven by table_info. #17: user_version is a marker, not a
	// precondition - the live DB was found at v0 with missing columns, so a version gate
	// had silently skipped the repair. The version is written last so an interrupted
	// upgrade still retries.
	const cols = new Set((db.prepare("PRAGMA table_info(card)").all() as Row[]).map((r) => String(r.name)));
	if (!cols.has("due")) db.exec("ALTER TABLE card ADD COLUMN due TEXT");
	if (!cols.has("estimate")) db.exec("ALTER TABLE card ADD COLUMN estimate INTEGER");
	if (!cols.has("session_id")) db.exec("ALTER TABLE card ADD COLUMN session_id TEXT");
	if (!cols.has("commit_sha")) db.exec("ALTER TABLE card ADD COLUMN commit_sha TEXT");
	if (!cols.has("labels")) db.exec("ALTER TABLE card ADD COLUMN labels TEXT");
	// shortcut: ALTER は列名で判定する。型変更が必要になったらテーブル再作成に切り替える。
	db.exec("PRAGMA user_version = 2");

	// #34: a slug comes from a directory name, and Windows does not tell `C:\Code\Repo` from
	// `c:\code\repo`, so every sid lookup matches case-insensitively. What is STORED keeps
	// the spelling it was written with (writeBoard reads the first one back for the rest of
	// the transaction), or the same directory would grow a second board.
	const selectBoard = db.prepare("SELECT next_id, sid FROM board WHERE scope = ? AND sid = ? COLLATE NOCASE");
	const selectCards = db.prepare(
		"SELECT id, text, col, img, moved_at, moved_by, priority, next_fire_at, blocked, fired_for, project, due, estimate, session_id, commit_sha, labels FROM card WHERE scope = ? AND sid = ? COLLATE NOCASE ORDER BY ord",
	);
	const selectRev = db.prepare("SELECT rev FROM board WHERE scope = ? AND sid = ? COLLATE NOCASE");
	// #16: the global aggregate reads every project board on every tick; two statements for
	// all of them instead of readBoard() per slug. SELECT * because rowToCard() is the only
	// reader and it ignores the extra (scope, sid, ord) columns.
	const selectProjectCards = db.prepare("SELECT * FROM card WHERE scope = 'project' ORDER BY sid, id");
	const selectProjectDeps = db.prepare(
		"SELECT sid, card_id, blocks_id FROM card_dep WHERE scope = 'project' ORDER BY sid, card_id, blocks_id",
	);
	const insertBoard = db.prepare(
		"INSERT INTO board (scope, sid, next_id, rev, touched_at) VALUES (?, ?, ?, 1, ?)",
	);
	const countBoard = db.prepare("SELECT 1 AS hit FROM board WHERE scope = ? AND sid = ? COLLATE NOCASE");
	const upsertBoard = db.prepare(
		"UPDATE board SET next_id = ?, rev = rev + 1, touched_at = ? WHERE scope = ? AND sid = ? COLLATE NOCASE",
	);
	const deleteBoardRow = db.prepare("DELETE FROM board WHERE scope = ? AND sid = ? COLLATE NOCASE");
	const deleteAllCards = db.prepare("DELETE FROM card WHERE scope = ? AND sid = ? COLLATE NOCASE");
	const deleteStaleCards = db.prepare(
		"DELETE FROM card WHERE scope = ? AND sid = ? COLLATE NOCASE AND id NOT IN (SELECT value FROM json_each(?))",
	);
	const insertCard = db.prepare(
		"INSERT OR REPLACE INTO card (scope, sid, id, ord, text, col, img, moved_at, moved_by, priority, next_fire_at, blocked, fired_for, project, due, estimate, session_id, commit_sha, labels) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	);
	const selectDeps = db.prepare(
		"SELECT card_id, blocks_id FROM card_dep WHERE scope = ? AND sid = ? COLLATE NOCASE ORDER BY card_id, blocks_id",
	);
	const deleteDeps = db.prepare("DELETE FROM card_dep WHERE scope = ? AND sid = ? COLLATE NOCASE");
	const insertDep = db.prepare(
		"INSERT OR IGNORE INTO card_dep (scope, sid, card_id, blocks_id) VALUES (?, ?, ?, ?)",
	);
	const selectProjects = db.prepare(
		"SELECT slug, name, created_at, updated_at FROM project ORDER BY updated_at DESC, slug",
	);
	const selectProject = db.prepare("SELECT slug, name, created_at, updated_at FROM project WHERE slug = ?");
	const countProject = db.prepare("SELECT 1 AS hit FROM project WHERE slug = ?");
	const upsertProject = db.prepare(
		"INSERT INTO project (slug, name, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(slug) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at",
	);
	const deleteProjectRow = db.prepare("DELETE FROM project WHERE slug = ?");
	const selectDecisions = db.prepare("SELECT id, slug, at, text, why FROM decision ORDER BY at DESC, id DESC");
	const selectDecisionsBySlug = db.prepare(
		"SELECT id, slug, at, text, why FROM decision WHERE slug = ? ORDER BY at DESC, id DESC",
	);
	const insertDecision = db.prepare("INSERT INTO decision (slug, at, text, why) VALUES (?, ?, ?, ?)");
	const deleteDecisionsBySlug = db.prepare("DELETE FROM decision WHERE slug = ?");
	const deleteDecisionRow = db.prepare("DELETE FROM decision WHERE id = ?");
	const selectMeta = db.prepare("SELECT v FROM meta WHERE k = ?");
	const upsertMeta = db.prepare(
		"INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
	);
	// The whole dependency set of a board is rewritten on every write, exactly like the
	// cards: a removed edge (or card) must not survive the next read.
	const writeDeps = (scope: string, sid: string, cards: Card[]): void => {
		deleteDeps.run(scope, sid);
		for (const c of cards) {
			for (const blocksId of c.blocks ?? []) insertDep.run(scope, sid, c.id, blocksId);
		}
	};

	const readBoard = (key: BoardKey): Board | null => {
		const head = selectBoard.get(key.scope, key.sid) as Row | undefined;
		if (!head) return null;
		const rows = selectCards.all(key.scope, key.sid) as Row[];
		const cards = rows.map(rowToCard);
		const deps = selectDeps.all(key.scope, key.sid) as Row[];
		if (deps.length > 0) {
			const byCard = new Map<number, number[]>();
			for (const d of deps) {
				const id = Number(d.card_id);
				const list = byCard.get(id);
				if (list === undefined) byCard.set(id, [Number(d.blocks_id)]);
				else list.push(Number(d.blocks_id));
			}
			for (const c of cards) {
				const blocks = byCard.get(c.id);
				if (blocks !== undefined) c.blocks = blocks;
			}
		}
		return { cards, nextId: Number(head.next_id) };
	};

	// First column of a one-row pragma. Only maintenance() reads pragmas this way, so this
	// stays a local helper instead of a general "run some SQL" door.
	const pragmaValue = (sql: string): unknown => {
		const row = db.prepare(sql).get() as Row | undefined;
		return row === undefined ? undefined : Object.values(row)[0];
	};

	return {
		readBoard,
		// One transaction: a reader never sees half a board, and a concurrent writer waits
		// instead of overwriting. Cards that vanished from the array are deleted by id so a
		// removed card cannot come back on the next read.
		writeBoard(key, b) {
			const now = Date.now();
			// #34: a board that already exists keeps the spelling it was created with, so a
			// write under another case cannot split its cards into a twin board.
			const head = selectBoard.get(key.scope, key.sid) as Row | undefined;
			const sid = head === undefined ? key.sid : String(head.sid);
			db.exec("BEGIN IMMEDIATE");
			try {
				if (head === undefined) {
					insertBoard.run(key.scope, sid, b.nextId, now);
				} else {
					upsertBoard.run(b.nextId, now, key.scope, sid);
				}
				const ids = JSON.stringify(b.cards.map((c) => c.id));
				deleteStaleCards.run(key.scope, sid, ids);
				for (let i = 0; i < b.cards.length; i++) {
					const c = b.cards[i];
					insertCard.run(
						key.scope,
						sid,
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
						c.due ?? null,
						c.estimate ?? null,
						c.sessionId ?? null,
						c.commit ?? null,
						labelColumn(c),
					);
				}
				writeDeps(key.scope, sid, b.cards);
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
		// #36: same prepared read as readBoard's first step, so this costs one indexed lookup.
		boardSid(key) {
			const r = selectBoard.get(key.scope, key.sid) as Row | undefined;
			return r === undefined ? null : String(r.sid);
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
						c.due ?? null,
						c.estimate ?? null,
						c.sessionId ?? null,
						c.commit ?? null,
						labelColumn(c),
					);
				}
				writeDeps(key.scope, key.sid, b.cards);
				db.exec("COMMIT");
			} catch (err) {
				db.exec("ROLLBACK");
				throw err;
			}
			return true;
		},
		listProjects() {
			return (selectProjects.all() as Row[]).map(rowToProject);
		},
		readProject(slug) {
			const row = selectProject.get(slug) as Row | undefined;
			return row === undefined ? null : rowToProject(row);
		},
		writeProject(slug, name) {
			const now = Date.now();
			const existed = countProject.get(slug) !== undefined;
			// createdAt only matters when the row is new: a rename must not rewrite it.
			upsertProject.run(slug, name, now, now);
			return !existed;
		},
		deleteProject(slug) {
			// One transaction: a project without its decision log is a hole, not a state.
			db.exec("BEGIN IMMEDIATE");
			try {
				const info = deleteDecisionsBySlug.run(slug);
				deleteProjectRow.run(slug);
				db.exec("COMMIT");
				return Number(info.changes ?? 0);
			} catch (err) {
				db.exec("ROLLBACK");
				throw err;
			}
		},
		getMeta(k) {
			const row = selectMeta.get(k) as Row | undefined;
			return row === undefined ? null : String(row.v);
		},
		setMeta(k, v) {
			upsertMeta.run(k, v);
		},
		// TRUNCATE also empties the -wal file, so the backup needs no -wal/-shm sidecar.
		checkpoint() {
			db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		},
		// One pragma at a time and every failure ends in the same answer: node:sqlite is
		// experimental and the settings tab must still open on a file it cannot read.
		maintenance() {
			try {
				return {
					integrity: String(pragmaValue("PRAGMA integrity_check") ?? "unavailable"),
					pages: Number(pragmaValue("PRAGMA page_count") ?? 0),
					freelist: Number(pragmaValue("PRAGMA freelist_count") ?? 0),
					pageSize: Number(pragmaValue("PRAGMA page_size") ?? 0),
				};
			} catch {
				return { integrity: "unavailable", pages: 0, freelist: 0, pageSize: 0 };
			}
		},
		// Not caught: a failed compaction is a real error, and the caller owns the 500.
		vacuum() {
			db.exec("VACUUM");
		},
		listDecisions(slug) {
			const rows = slug === undefined ? selectDecisions.all() : selectDecisionsBySlug.all(slug);
			return (rows as Row[]).map(rowToDecision);
		},
		addDecision(slug, text, why, at) {
			const when = at ?? Date.now();
			const info = insertDecision.run(slug, when, text, why ?? null);
			const d: Decision = { id: Number(info.lastInsertRowid), slug, at: when, text };
			if (why !== undefined) d.why = why;
			return d;
		},
		deleteDecision(id) {
			return Number(deleteDecisionRow.run(id).changes ?? 0) > 0;
		},
		deleteBoard(key) {
			deleteDeps.run(key.scope, key.sid);
			deleteAllCards.run(key.scope, key.sid);
			deleteBoardRow.run(key.scope, key.sid);
		},
		dropNonProject() {
			// One statement per table, no enumeration: a half-deleted board cannot survive.
			// Not one transaction either: the caller sets its marker only after this returns, so
			// a throw half way leaves the marker unset and the next start retries the reset.
			db.prepare("DELETE FROM card_dep WHERE scope != 'project'").run();
			db.prepare("DELETE FROM card WHERE scope != 'project'").run();
			return Number(db.prepare("DELETE FROM board WHERE scope != 'project'").run().changes ?? 0);
		},
		projectKeys() {
			// slug order: callers sort it anyway (aggregateGlobal), and a no-change tick must
			// enumerate the same order twice.
			return db
				.prepare(
					"SELECT sid AS slug, touched_at AS touchedAt, rev FROM board WHERE scope = 'project' ORDER BY sid",
				)
				.all() as { slug: string; touchedAt: number; rev: number }[];
		},
		listProjectBoards() {
			const boards = new Map<string, Card[]>();
			for (const r of selectProjectCards.all() as Row[]) {
				const slug = String(r.sid);
				const cards = boards.get(slug);
				if (cards === undefined) boards.set(slug, [rowToCard(r)]);
				else cards.push(rowToCard(r));
			}
			// readBoard() hangs blocks off the card; keep the shape even out of the per-key path.
			const bySlugCard = new Map<string, Map<number, number[]>>();
			for (const d of selectProjectDeps.all() as Row[]) {
				const slug = String(d.sid);
				const byCard = bySlugCard.get(slug) ?? new Map<number, number[]>();
				bySlugCard.set(slug, byCard);
				const id = Number(d.card_id);
				const list = byCard.get(id) ?? [];
				list.push(Number(d.blocks_id));
				byCard.set(id, list);
			}
			for (const [slug, cards] of boards) {
				const byCard = bySlugCard.get(slug);
				if (byCard === undefined) continue;
				for (const c of cards) {
					const blocks = byCard.get(c.id);
					if (blocks !== undefined) c.blocks = blocks;
				}
			}
			// Map insertion order is the SQL order (sid ascending), which is the contract above.
			return [...boards].map(([slug, cards]) => ({ slug, cards }));
		},
		close() {
			db.close();
		},
	};
}
