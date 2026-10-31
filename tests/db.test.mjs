import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openKanbanDb } from "../extensions/db.ts";

const fresh = async () => {
	const dir = mkdtempSync(join(tmpdir(), "kbdb-"));
	const db = await openKanbanDb(join(dir, "board.sqlite"));
	return { db, key: { scope: "session", sid: "s1" } };
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
	db.writeBoard({ scope: "session", sid: "other" }, { cards: [], nextId: 1 });
	assert.equal(db.revOf({ scope: "session", sid: "other" }), 1);
	db.close();
});

test("importBoard never overwrites a board that already exists", async () => {
	const { db, key } = await fresh();
	db.writeBoard(key, { cards: [{ id: 1, text: "live", col: "todo" }], nextId: 2 });
	assert.equal(db.importBoard(key, { cards: [{ id: 7, text: "stale json", col: "done" }], nextId: 8 }), false);
	assert.deepEqual(db.readBoard(key).cards, [{ id: 1, text: "live", col: "todo" }]);
	assert.equal(db.importBoard({ scope: "global", sid: "" }, { cards: [], nextId: 1 }), true);
	db.close();
});

test("sweepSessions drops only old session boards", async () => {
	const { db, key } = await fresh();
	db.writeBoard(key, { cards: [{ id: 1, text: "a", col: "todo" }], nextId: 2 });
	db.writeBoard({ scope: "global", sid: "" }, { cards: [], nextId: 1 });
	assert.equal(db.sweepSessions(Date.now() + 1000), 1);
	assert.equal(db.readBoard(key), null);
	assert.ok(db.readBoard({ scope: "global", sid: "" }), "the global board must survive a session sweep");
	db.close();
});

test("a second handle on the same file sees the first one's writes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "kbdb-"));
	const file = join(dir, "board.sqlite");
	const a = await openKanbanDb(file);
	const b = await openKanbanDb(file);
	const key = { scope: "session", sid: "shared" };
	a.writeBoard(key, { cards: [{ id: 1, text: "from a", col: "todo" }], nextId: 2 });
	assert.deepEqual(b.readBoard(key).cards, [{ id: 1, text: "from a", col: "todo" }]);
	b.writeBoard(key, { cards: [{ id: 1, text: "from b", col: "done" }], nextId: 2 });
	assert.deepEqual(a.readBoard(key).cards, [{ id: 1, text: "from b", col: "done" }]);
	a.close();
	b.close();
});
