// 停滞 is a pure function of movedAt and the threshold; the board only paints it.
import test from "node:test";
import assert from "node:assert/strict";
import "./_load.mjs";

const { createStore, isStalled, daysSinceMoved, STALE_DAYS_DEFAULT } =
  await import("../../web/src/store.ts");

const NOW = Date.parse("2026-11-17T12:00:00Z");
const ago = days => new Date(NOW - days * 86_400_000).toISOString();
const card = (days, columnId = "doing") => ({ columnId, movedAt: ago(days) });
const col = (id, kind, ord) => ({ projectId: "demo", id, name: id.toUpperCase(), kind, ord, wipLimit: null });

// The id is a name: 停滞 is a property of the column's kind, exactly like isDoneColumn.
const store = createStore();
store.columns = {
  doing: col("doing", "doing", 1),
  wip: col("wip", "doing", 2),
  todo: col("todo", "todo", 0),
  done: col("done", "done", 3),
};

test("7日ちょうどで停滞になる", () => {
  assert.equal(isStalled(store, card(7), STALE_DAYS_DEFAULT, NOW), true);
  assert.equal(isStalled(store, card(6.99), STALE_DAYS_DEFAULT, NOW), false);
});

test("doing 以外の列は対象外", () => {
  assert.equal(isStalled(store, card(30, "todo"), STALE_DAYS_DEFAULT, NOW), false);
  assert.equal(isStalled(store, card(30, "done"), STALE_DAYS_DEFAULT, NOW), false);
});

test("id が doing でなくても kind が doing なら対象", () => {
  assert.equal(isStalled(store, card(9, "wip"), STALE_DAYS_DEFAULT, NOW), true);
});

test("知らない列 id は対象外", () => {
  assert.equal(isStalled(store, card(9, "nope"), STALE_DAYS_DEFAULT, NOW), false);
});

test("閾値 0 で無効になる", () => {
  assert.equal(isStalled(store, card(30), 0, NOW), false);
});

test("movedAt が読めなければ停滞にしない", () => {
  assert.equal(isStalled(store, { columnId: "doing", movedAt: "nope" }, STALE_DAYS_DEFAULT, NOW), false);
});

test("日数は切り捨てで数える", () => {
  assert.equal(daysSinceMoved(card(7.9), NOW), 7);
  assert.equal(daysSinceMoved({ movedAt: "nope" }, NOW), 0);
});
