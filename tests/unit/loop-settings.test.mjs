// Loop thresholds are one kv_meta row ('loop.settings'): the three v1 knobs
// (/api/interval, /api/stuck, /api/maxloops) as numbers. What an unset row means, what a
// partial write does, and which values are refused (the HTTP layer turns that into 422).
import "./_load.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const P = await import("../../src/persistence/index.ts");
const R = await import("../../src/persistence/repos.ts");

function freshDb() {
  const db = P.openDb(":memory:", { wal: false });
  P.migrate(db);
  return db;
}

const DEFAULTS = { intervalMs: 15000, stuckDays: 7, maxLoops: 0 };

test("getLoopSettings: an unset row is the defaults, and reading does not write one", () => {
  const db = freshDb();
  assert.deepEqual(R.getLoopSettings(db), DEFAULTS);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM kv_meta WHERE k = 'loop.settings'").get().n, 0);
});

test("getLoopSettings: a fallback fills in what was never saved, a saved value wins", () => {
  const db = freshDb();
  assert.equal(R.getLoopSettings(db, { intervalMs: 60000 }).intervalMs, 60000, "KANBAN_LOOP_MS is a default");
  R.saveLoopSettings(db, { intervalMs: 30000 });
  assert.equal(R.getLoopSettings(db, { intervalMs: 60000 }).intervalMs, 30000, "the saved value outranks the env");
});

test("saveLoopSettings: a partial write keeps the other two", () => {
  const db = freshDb();
  assert.deepEqual(R.saveLoopSettings(db, { stuckDays: 3 }), { ...DEFAULTS, stuckDays: 3 });
  assert.deepEqual(R.saveLoopSettings(db, { maxLoops: 5 }), { intervalMs: 15000, stuckDays: 3, maxLoops: 5 });
  assert.deepEqual(R.getLoopSettings(db), { intervalMs: 15000, stuckDays: 3, maxLoops: 5 });
});

test("saveLoopSettings: the range boundaries themselves are accepted", () => {
  const db = freshDb();
  assert.deepEqual(R.saveLoopSettings(db, { intervalMs: 1000, stuckDays: 0, maxLoops: 0 }),
    { intervalMs: 1000, stuckDays: 0, maxLoops: 0 });
  assert.deepEqual(R.saveLoopSettings(db, { intervalMs: 600000, stuckDays: 365, maxLoops: 100000 }),
    { intervalMs: 600000, stuckDays: 365, maxLoops: 100000 });
});

test("saveLoopSettings: an out-of-range or non-integer value is VALIDATION and is not written", () => {
  const db = freshDb();
  const bad = [
    { intervalMs: 999 }, { intervalMs: 600001 }, { intervalMs: 1.5 }, { intervalMs: "15000" },
    { stuckDays: -1 }, { stuckDays: 366 },
    { maxLoops: -1 }, { maxLoops: 100001 },
  ];
  for (const patch of bad) {
    assert.throws(() => R.saveLoopSettings(db, patch), (err) => err.code === "VALIDATION", JSON.stringify(patch));
  }
  assert.throws(() => R.saveLoopSettings(db, { nope: 1 }), (err) => err.code === "VALIDATION", "an unknown key is not a setting");
  assert.deepEqual(R.getLoopSettings(db), DEFAULTS, "a refused patch wrote nothing");
});

test("getLoopSettings: a hand-edited row only contributes the fields it got right", () => {
  const db = freshDb();
  const put = (v) => db.prepare("INSERT INTO kv_meta (k, v) VALUES ('loop.settings', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(v);
  put(JSON.stringify({ intervalMs: 2000, stuckDays: 999, maxLoops: 4 }));
  assert.deepEqual(R.getLoopSettings(db), { intervalMs: 2000, stuckDays: 7, maxLoops: 4 });
  put("not json");
  assert.deepEqual(R.getLoopSettings(db), DEFAULTS);
  put("null");
  assert.deepEqual(R.getLoopSettings(db), DEFAULTS);
});
