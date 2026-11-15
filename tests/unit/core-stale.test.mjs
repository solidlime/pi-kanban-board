import "./_load.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const { staleDoingCount } = await import("../../src/core/board.ts");
const { STALE_DOING_MS } = await import("../../src/shared/constants.ts");

const COLUMNS = [
  { projectId: "p", id: "todo", name: "TODO", kind: "todo", ord: 0, wipLimit: null },
  { projectId: "p", id: "doing", name: "DOING", kind: "doing", ord: 1, wipLimit: null },
  { projectId: "p", id: "done", name: "DONE", kind: "done", ord: 2, wipLimit: null },
];

function card(id, columnId, movedAt) {
  return {
    projectId: "p", id, columnId, title: `c${id}`, priority: 0,
    createdAt: movedAt, updatedAt: movedAt, movedAt, version: 1,
  };
}

const NOW = Date.UTC(2026, 0, 2, 12, 0, 0);
const ago = (ms) => new Date(NOW - ms).toISOString();

test("the constant is three hours", () => {
  assert.equal(STALE_DOING_MS, 3 * 60 * 60 * 1000);
});

test("a doing card older than the threshold is stale", () => {
  const cards = [card(1, "doing", ago(STALE_DOING_MS + 60_000))];
  assert.equal(staleDoingCount(COLUMNS, cards, NOW), 1);
});

test("exactly at the threshold counts (<=)", () => {
  const cards = [card(1, "doing", ago(STALE_DOING_MS))];
  assert.equal(staleDoingCount(COLUMNS, cards, NOW), 1);
});

test("a fresh doing card and an old todo card are not stale", () => {
  const cards = [
    card(1, "doing", ago(60 * 60 * 1000)),
    card(2, "todo", ago(STALE_DOING_MS * 5)),
  ];
  assert.equal(staleDoingCount(COLUMNS, cards, NOW), 0);
});

test("an unparseable movedAt is not stale", () => {
  const cards = [card(1, "doing", "not a date")];
  assert.equal(staleDoingCount(COLUMNS, cards, NOW), 0);
});

test("ms and now can be overridden", () => {
  const cards = [card(1, "doing", ago(2 * 60 * 1000))];
  assert.equal(staleDoingCount(COLUMNS, cards, NOW, 60 * 1000), 1);
  assert.equal(staleDoingCount(COLUMNS, cards, NOW - 10 * 60 * 1000, 60 * 1000), 0);
});
