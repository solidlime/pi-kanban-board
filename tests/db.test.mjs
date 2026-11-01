import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openKanbanDb } from "../extensions/db.ts";

const fresh = async () => {
	const dir = mkdtempSync(join(tmpdir(), "kbdb-"));
	const db = await openKanbanDb(join(dir, "board.sqlite"));
	return { db, key: { scope: "project", sid: "s1" } };
};

test("an unwritten board reads as null, not as an empty one", async () => {
	const { db, key } = await fresh();
	assert.equal(db.readBoard(key), null);
	db.close();
});

test("cards round-trip in array order, optional fields and all", async () => {
	const { db, key } = await fresh();
	const cards = [
		{ id: 2, text: "second", col: "doing", priority: 3, project: "kb", movedBy: "x" },
		{ id: 1, text: "first", col: "todo" },
	];
	db.writeBoard(key, { cards, nextId: 9 });
	const back = db.readBoard(key);
	assert.equal(back.nextId, 9);
	assert.deepEqual(back.cards, cards);
	// An absent field must stay absent: sqlite stores NULL, and a `img: undefined` key
	// would make deepEqual above pass while `"img" in card` differs from the JSON path.
	assert.equal(Object.keys(back.cards[1]).sort().join(), "col,id,text");
	db.close();
});

test("a card dropped from the array does not come back", async () => {
	const { db, key } = await fresh();
	db.writeBoard(key, { cards: [{ id: 1, text: "a", col: "todo" }, { id: 2, text: "b", col: "todo" }], nextId: 3 });
	db.writeBoard(key, { cards: [{ id: 1, text: "a", col: "done" }], nextId: 3 });
	assert.deepEqual(db.readBoard(key).cards, [{ id: 1, text: "a", col: "done" }]);
	db.close();
});

test("rev moves on every write and only on writes", async () => {
	const { db, key } = await fresh();
	assert.equal(db.revOf(key), 0);
	db.writeBoard(key, { cards: [], nextId: 1 });
	const one = db.revOf(key);
	db.writeBoard(key, { cards: [], nextId: 1 });
	assert.ok(one > 0);
	assert.ok(db.revOf(key) > one);
	db.writeBoard({ scope: "project", sid: "other" }, { cards: [], nextId: 1 });
	assert.equal(db.revOf({ scope: "project", sid: "other" }), 1);
	db.close();
});

test("a second handle on the same file sees the first one's writes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "kbdb-"));
	const file = join(dir, "board.sqlite");
	const a = await openKanbanDb(file);
	const b = await openKanbanDb(file);
	const key = { scope: "project", sid: "shared" };
	a.writeBoard(key, { cards: [{ id: 1, text: "from a", col: "todo" }], nextId: 2 });
	assert.deepEqual(b.readBoard(key).cards, [{ id: 1, text: "from a", col: "todo" }]);
	b.writeBoard(key, { cards: [{ id: 1, text: "from b", col: "done" }], nextId: 2 });
	assert.deepEqual(a.readBoard(key).cards, [{ id: 1, text: "from b", col: "done" }]);
	a.close();
	b.close();
});

test("a board written before due/estimate existed migrates and keeps its cards", async () => {
	const dir = mkdtempSync(join(tmpdir(), "kbdb-mig-"));
	const file = join(dir, "old.sqlite");
	// Build the v0 shape by hand: openKanbanDb always creates the current one, so a
	// fresh temp file cannot reproduce "the user already had a board".
	const { createRequire } = await import("node:module");
	const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
	const old = new DatabaseSync(file);
	old.exec(
		"CREATE TABLE board (scope TEXT NOT NULL, sid TEXT NOT NULL, next_id INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 0, touched_at INTEGER NOT NULL, PRIMARY KEY (scope, sid))",
	);
	old.exec(
		"CREATE TABLE card (scope TEXT NOT NULL, sid TEXT NOT NULL, id INTEGER NOT NULL, ord INTEGER NOT NULL, text TEXT NOT NULL, col TEXT NOT NULL, img TEXT, moved_at INTEGER, moved_by TEXT, priority INTEGER, next_fire_at TEXT, blocked TEXT, fired_for TEXT, project TEXT, PRIMARY KEY (scope, sid, id))",
	);
	old.exec("INSERT INTO board (scope, sid, next_id, rev, touched_at) VALUES ('project','s1',2,1,0)");
	old.exec("INSERT INTO card (scope, sid, id, ord, text, col) VALUES ('project','s1',1,0,'old','todo')");
	old.close();

	const db = await openKanbanDb(file);
	const key = { scope: "project", sid: "s1" };
	assert.deepEqual(db.readBoard(key).cards, [{ id: 1, text: "old", col: "todo" }]);
	// The point of the migration: the new columns are usable on the old board.
	db.writeBoard(key, { cards: [{ id: 1, text: "old", col: "todo", due: "2026-11-05", estimate: 3 }], nextId: 2 });
	const back = db.readBoard(key).cards[0];
	assert.equal(back.due, "2026-11-05");
	assert.equal(back.estimate, 3);
	db.close();
});

test("a board written before session_id/commit_sha existed migrates and keeps its links", async () => {
	const dir = mkdtempSync(join(tmpdir(), "kbdb-link-"));
	const file = join(dir, "old.sqlite");
	// #20: the shape right before this column pair - due/estimate already there.
	const { createRequire } = await import("node:module");
	const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
	const old = new DatabaseSync(file);
	old.exec(
		"CREATE TABLE board (scope TEXT NOT NULL, sid TEXT NOT NULL, next_id INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 0, touched_at INTEGER NOT NULL, PRIMARY KEY (scope, sid))",
	);
	old.exec(
		"CREATE TABLE card (scope TEXT NOT NULL, sid TEXT NOT NULL, id INTEGER NOT NULL, ord INTEGER NOT NULL, text TEXT NOT NULL, col TEXT NOT NULL, img TEXT, moved_at INTEGER, moved_by TEXT, priority INTEGER, next_fire_at TEXT, blocked TEXT, fired_for TEXT, project TEXT, due TEXT, estimate INTEGER, PRIMARY KEY (scope, sid, id))",
	);
	old.exec("INSERT INTO board (scope, sid, next_id, rev, touched_at) VALUES ('project','s1',2,1,0)");
	old.exec("INSERT INTO card (scope, sid, id, ord, text, col) VALUES ('project','s1',1,0,'old','todo')");
	old.close();

	const db = await openKanbanDb(file);
	const key = { scope: "project", sid: "s1" };
	assert.deepEqual(db.readBoard(key).cards, [{ id: 1, text: "old", col: "todo" }]);
	// The point of the migration: the new columns are writable AND selected back.
	db.writeBoard(key, { cards: [{ id: 1, text: "old", col: "todo", sessionId: "s-1", commit: "abcdef1" }], nextId: 2 });
	const back = db.readBoard(key).cards[0];
	assert.equal(back.sessionId, "s-1");
	assert.equal(back.commit, "abcdef1");
	db.close();
});

test("importBoard keeps sessionId/commit (its own insertCard.run)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "kbdb-imp-"));
	const db = await openKanbanDb(join(dir, "board.sqlite"));
	const key = { scope: "project", sid: "imp" };
	const card = { id: 1, text: "imported", col: "todo", sessionId: "s-9", commit: "deadbee" };
	assert.equal(db.importBoard(key, { cards: [card], nextId: 2 }), true);
	assert.deepEqual(db.readBoard(key).cards, [card]);
	db.close();
});

// #22: labels は JSON 列 1 本。writeBoard と importBoard に insertCard.run が 1 つずつある
// （バイト同一の双子）ので、両方を固定しないと importBoard 経由だけ無音で消える。
test("labels round-trip through writeBoard, and an empty array is just absent", async () => {
	const { db, key } = await fresh();
	db.writeBoard(key, { cards: [{ id: 1, text: "a", col: "todo", labels: ["bug", "調査"] }], nextId: 2 });
	assert.deepEqual(db.readBoard(key).cards[0].labels, ["bug", "調査"], "labels が読み戻せない");
	// 空配列と「無い」は区別しない（blocks と同じ）。列は NULL に戻る。
	db.writeBoard(key, { cards: [{ id: 1, text: "a", col: "todo", labels: [] }], nextId: 2 });
	assert.deepEqual(db.readBoard(key).cards[0], { id: 1, text: "a", col: "todo" });
	db.close();
});

test("importBoard keeps labels (its own insertCard.run)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "kbdb-imglab-"));
	const db = await openKanbanDb(join(dir, "board.sqlite"));
	const key = { scope: "project", sid: "gl" };
	const card = { id: 1, text: "imported labels", col: "todo", labels: ["feature"] };
	assert.equal(db.importBoard(key, { cards: [card], nextId: 2 }), true);
	assert.deepEqual(db.readBoard(key).cards, [card]);
	db.close();
});

test("a torn labels column reads as no labels instead of throwing", async () => {
	const dir = mkdtempSync(join(tmpdir(), "kbdb-tornlab-"));
	const file = join(dir, "board.sqlite");
	const key = { scope: "project", sid: "t1" };
	const db = await openKanbanDb(file);
	db.writeBoard(key, { cards: [{ id: 1, text: "a", col: "todo" }], nextId: 2 });
	db.close();
	// A hand-edited/regexed row: reading must stay lenient (the vocabulary is kanban.ts' job).
	const { createRequire } = await import("node:module");
	const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
	const raw = new DatabaseSync(file);
	raw.exec("UPDATE card SET labels = 'not json' WHERE id = 1");
	raw.close();
	const again = await openKanbanDb(file);
	assert.deepEqual(again.readBoard(key).cards, [{ id: 1, text: "a", col: "todo" }]);
	again.close();
});

test("a card table predating labels is migrated (no such column)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "kbdb-labcol-"));
	const file = join(dir, "old.sqlite");
	const { createRequire } = await import("node:module");
	const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
	const oldDb = new DatabaseSync(file);
	oldDb.exec(
		"CREATE TABLE board (scope TEXT NOT NULL, sid TEXT NOT NULL, next_id INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 0, touched_at INTEGER NOT NULL, PRIMARY KEY (scope, sid))",
	);
	oldDb.exec(
		"CREATE TABLE card (scope TEXT NOT NULL, sid TEXT NOT NULL, id INTEGER NOT NULL, ord INTEGER NOT NULL, text TEXT NOT NULL, col TEXT NOT NULL, img TEXT, moved_at INTEGER, moved_by TEXT, priority INTEGER, next_fire_at TEXT, blocked TEXT, fired_for TEXT, project TEXT, due TEXT, estimate INTEGER, session_id TEXT, commit_sha TEXT, PRIMARY KEY (scope, sid, id))",
	);
	oldDb.exec("INSERT INTO board (scope, sid, next_id, rev, touched_at) VALUES ('project','s1',2,1,0)");
	oldDb.exec("INSERT INTO card (scope, sid, id, ord, text, col) VALUES ('project','s1',1,0,'old','todo')");
	oldDb.close();

	const db = await openKanbanDb(file);
	const key = { scope: "project", sid: "s1" };
	// The ALTER guard: an older file must accept a label write, not die on no such column.
	db.writeBoard(key, { cards: [{ id: 1, text: "old", col: "todo", labels: ["chore"] }], nextId: 2 });
	assert.deepEqual(db.readBoard(key).cards[0].labels, ["chore"]);
	db.close();
});

test("a v0 database missing due/estimate is repaired on open, not on a version bump", async () => {
	const dir = mkdtempSync(join(tmpdir(), "kbdb-v0-"));
	const file = join(dir, "v0.sqlite");
	// The live DB that exposed #17: user_version 0, a card table without due/estimate, and
	// no project/card_dep/decision. A `if (version < …)` gate had silently skipped the ALTER.
	const { createRequire } = await import("node:module");
	const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
	const old = new DatabaseSync(file);
	old.exec("CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
	old.exec("CREATE TABLE board (scope TEXT NOT NULL, sid TEXT NOT NULL, next_id INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 0, touched_at INTEGER NOT NULL, PRIMARY KEY (scope, sid))");
	old.exec("CREATE TABLE card (scope TEXT NOT NULL, sid TEXT NOT NULL, id INTEGER NOT NULL, ord INTEGER NOT NULL, text TEXT NOT NULL, col TEXT NOT NULL, img TEXT, moved_at INTEGER, moved_by TEXT, priority INTEGER, next_fire_at TEXT, blocked TEXT, fired_for TEXT, project TEXT, PRIMARY KEY (scope, sid, id))");
	old.exec("INSERT INTO board (scope, sid, next_id, rev, touched_at) VALUES ('project','kb',2,1,0)");
	old.exec("INSERT INTO card (scope, sid, id, ord, text, col) VALUES ('project','kb',1,0,'old','todo')");
	old.close();

	const db = await openKanbanDb(file);
	// A second handle, because KanbanDb only exposes rows, not pragmas.
	const probe = new DatabaseSync(file);
	const cols = probe.prepare("PRAGMA table_info(card)").all().map((r) => r.name);
	assert.ok(cols.includes("due"), "due 列が増えていない");
	assert.ok(cols.includes("estimate"), "estimate 列が増えていない");
	const tables = probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
	for (const t of ["board", "card", "project", "card_dep", "decision"]) {
		assert.ok(tables.includes(t), `${t} テーブルが無い`);
	}
	assert.equal(probe.prepare("PRAGMA user_version").get().user_version, 2, "user_version が目印の 2 になっていない");
	probe.close();
	assert.deepEqual(db.readBoard({ scope: "project", sid: "kb" }).cards, [{ id: 1, text: "old", col: "todo" }]);
	db.close();
});

test("a project upserts by slug and keeps its created_at", async () => {
	const { db } = await fresh();
	assert.equal(db.readProject("kb"), null);
	assert.equal(db.writeProject("kb", "Kanban Board"), true, "新規なのに false が返った");
	assert.equal(db.writeProject("kb", "Kanban Board v2"), false, "既存なのに true が返った");
	const p = db.readProject("kb");
	assert.equal(p.name, "Kanban Board v2");
	assert.ok(p.createdAt <= p.updatedAt);
	assert.equal(db.listProjects().length, 1, "同じ slug が2行になった");
	db.close();
});

test("listProjects puts the most recently touched first", async () => {
	const { db } = await fresh();
	db.writeProject("old", "old");
	db.writeProject("new", "new");
	// updated_at is a Date.now() stamp, so two writes in the same millisecond tie and fall
	// back to slug order. Force the gap rather than sleeping into a flaky test.
	const rows = db.listProjects().map((p) => p.slug);
	assert.deepEqual(new Set(rows), new Set(["old", "new"]));
	db.close();
});

test("a decision keeps its why and comes back newest first", async () => {
	const { db } = await fresh();
	const a = db.addDecision("kb", "依存は隣接リストで持つ", "循環検出が書き込み時で済む", 1000);
	const b = db.addDecision("kb", "期日は日付だけ", undefined, 2000);
	assert.ok(a.id > 0 && a.id !== b.id, "id が振られていない");
	const back = db.listDecisions("kb");
	assert.deepEqual(back.map((d) => d.text), ["期日は日付だけ", "依存は隣接リストで持つ"]);
	assert.equal(back[1].why, "循環検出が書き込み時で済む");
	assert.equal("why" in back[0], false, "why 無しに why キーが生えた");
	db.close();
});

test("listDecisions with no slug spans every project", async () => {
	const { db } = await fresh();
	db.addDecision("kb", "kb の決定");
	db.addDecision("other", "other の決定");
	db.addDecision("", "プロジェクト横断の決定");
	assert.equal(db.listDecisions().length, 3);
	assert.deepEqual(db.listDecisions("kb").map((d) => d.text), ["kb の決定"]);
	db.close();
});

test("deleting a project takes its decision log and nothing else", async () => {
	const { db } = await fresh();
	db.writeProject("kb", "kb");
	db.writeProject("keep", "keep");
	db.addDecision("kb", "消える");
	db.addDecision("kb", "これも消える");
	db.addDecision("keep", "残る");
	assert.equal(db.deleteProject("kb"), 2, "消した決定数が違う");
	assert.equal(db.readProject("kb"), null);
	assert.deepEqual(db.listDecisions().map((d) => d.text), ["残る"]);
	assert.equal(db.deleteProject("kb"), 0, "2回目で 0 にならない");
	db.close();
});

test("deleteDecision reports whether a row went away", async () => {
	const { db } = await fresh();
	const d = db.addDecision("kb", "消す");
	assert.equal(db.deleteDecision(d.id), true);
	assert.equal(db.deleteDecision(d.id), false);
	assert.equal(db.listDecisions().length, 0);
	db.close();
});

test("a v1 database gains the project and decision tables without losing cards", async () => {
	const dir = mkdtempSync(join(tmpdir(), "kbdb-v1-"));
	const file = join(dir, "v1.sqlite");
	// v1 = cards with due/estimate but no project/decision tables: the shape every board
	// had before this change, so this is the upgrade every real user runs.
	const { createRequire } = await import("node:module");
	const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
	const old = new DatabaseSync(file);
	old.exec("PRAGMA user_version = 1");
	old.exec("CREATE TABLE board (scope TEXT NOT NULL, sid TEXT NOT NULL, next_id INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 0, touched_at INTEGER NOT NULL, PRIMARY KEY (scope, sid))");
	old.exec("CREATE TABLE card (scope TEXT NOT NULL, sid TEXT NOT NULL, id INTEGER NOT NULL, ord INTEGER NOT NULL, text TEXT NOT NULL, col TEXT NOT NULL, img TEXT, moved_at INTEGER, moved_by TEXT, priority INTEGER, next_fire_at TEXT, blocked TEXT, fired_for TEXT, project TEXT, due TEXT, estimate INTEGER, PRIMARY KEY (scope, sid, id))");
	old.exec("INSERT INTO board (scope, sid, next_id, rev, touched_at) VALUES ('project','s1',2,1,0)");
	old.exec("INSERT INTO card (scope, sid, id, ord, text, col, project) VALUES ('project','s1',1,0,'v1 card','todo','kb')");
	old.close();

	const db = await openKanbanDb(file);
	const key = { scope: "project", sid: "s1" };
	assert.deepEqual(db.readBoard(key).cards, [{ id: 1, text: "v1 card", col: "todo", project: "kb" }]);
	assert.equal(db.writeProject("kb", "kanban"), true);
	db.addDecision("kb", "v1 から昇格");
	assert.equal(db.listDecisions("kb").length, 1);
	assert.deepEqual(db.readBoard(key).cards, [{ id: 1, text: "v1 card", col: "todo", project: "kb" }]);
	db.close();
});

test("#13 maintenance reads integrity and page numbers without touching rows", async () => {
	const { db, key } = await fresh();
	db.writeBoard(key, { cards: [{ id: 1, text: "a", col: "todo" }], nextId: 2 });
	const m = db.maintenance();
	assert.equal(m.integrity, "ok");
	assert.ok(m.pages > 0, `pages=${m.pages}`);
	assert.ok(m.freelist >= 0, `freelist=${m.freelist}`);
	assert.ok(m.pageSize > 0, `pageSize=${m.pageSize}`);
	assert.deepEqual(db.readBoard(key).cards, [{ id: 1, text: "a", col: "todo" }]);
	db.close();
});

test("#13 vacuum compacts the file and every card survives it", async () => {
	const { db, key } = await fresh();
	const cards = [
		{ id: 1, text: "a", col: "todo" },
		{ id: 2, text: "b", col: "done", project: "kb" },
	];
	db.writeBoard(key, { cards, nextId: 3 });
	// Dropping a row is what leaves space behind: that is what VACUUM has to reclaim.
	db.writeBoard(key, { cards: [cards[1]], nextId: 3 });
	db.vacuum();
	assert.deepEqual(db.readBoard(key).cards, [cards[1]]);
	assert.equal(db.maintenance().integrity, "ok");
	db.close();
});
