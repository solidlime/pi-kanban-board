// The undo window for a delete lives in the store, not in app.ts: one snapshot or one tick that
// still sees the card would otherwise put it back on the board mid-animation.
import test from "node:test";
import assert from "node:assert/strict";
import "./_load.mjs";

const { createStore, applySnapshot, upsertCard, vanishCard, revealCard, resetBoard, cardKey } =
  await import("../../web/src/store.ts");

function card(id, props = {}) {
  return { projectId: "p", id, columnId: "todo", title: `c${id}`, priority: 0, ...props };
}
function snapshot(cards, dependencies = []) {
  return { project: { slug: "p" }, columns: [], cards, dependencies };
}
function loaded(cards = [card(1), card(2)], dependencies = []) {
  const s = createStore();
  assert.equal(applySnapshot(s, "p", snapshot(cards, dependencies)), true);
  return s;
}

test("a vanishing card leaves the board", () => {
  const s = loaded();
  vanishCard(s, cardKey("p", 1));
  assert.deepEqual(Object.keys(s.cards), [cardKey("p", 2)]);
});

test("a poll that still carries the card does not put it back", () => {
  const s = loaded();
  vanishCard(s, cardKey("p", 1));
  assert.equal(applySnapshot(s, "p", snapshot([card(1), card(2)])), true);
  assert.equal(s.cards[cardKey("p", 1)], undefined, "the snapshot resurrected it");
});

test("a tick or a move response does not put it back either", () => {
  const s = loaded();
  vanishCard(s, cardKey("p", 1));
  assert.equal(upsertCard(s, card(1)), false);
  assert.equal(s.cards[cardKey("p", 1)], undefined);
});

test("the edges of a hidden card go with it", () => {
  const s = loaded([card(1), card(2)], [{ projectId: "p", fromCard: 1, toCard: 2, type: "blocks" }]);
  vanishCard(s, cardKey("p", 1));
  assert.deepEqual(s.dependencies, [], "a dangling edge reads as 'nothing blocks this'");
});

test("an undo puts the card back", () => {
  const s = loaded();
  vanishCard(s, cardKey("p", 1));
  revealCard(s, cardKey("p", 1));
  assert.equal(upsertCard(s, card(1)), true);
  assert.equal(s.cards[cardKey("p", 1)].id, 1);
});

test("an undo leaves the edges missing until a snapshot restores them", () => {
  const edges = () => [{ projectId: "p", fromCard: 1, toCard: 2, type: "blocks" }];
  const s = loaded([card(1), card(2)], edges());
  vanishCard(s, cardKey("p", 1));
  assert.deepEqual(s.dependencies, []);
  revealCard(s, cardKey("p", 1));
  assert.equal(upsertCard(s, card(1)), true);
  // This is why undoDelete reloads: the card alone comes back unblocked.
  applySnapshot(s, "p", snapshot([card(1), card(2)], edges()));
  assert.equal(s.dependencies.length, 1);
});

test("switching boards keeps the window open, so the delete still commits", () => {
  const s = loaded();
  vanishCard(s, cardKey("p", 1));
  resetBoard(s, "other");
  assert.equal(s.vanishing.has(cardKey("p", 1)), true);
});
