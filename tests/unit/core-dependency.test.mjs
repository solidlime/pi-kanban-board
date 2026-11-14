// Dependency graph: add/remove, duplicate + self rejection, cycle rejection (direct and
// transitive), and the blocked/ready derivations built on top of it.
import "./_load.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const core = await import("../../src/core/index.ts");

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-02T00:00:00.000Z";

/** Board with `n` cards: #1..#n in todo. */
function boardWithCards(n) {
  let board = core.makeBoard(core.createProject({ slug: "proj", name: "Project" }, { now: T0 }));
  for (let i = 1; i <= n; i++) board = core.addCard(board, { title: `card ${i}` }, { now: T0 }).state;
  return board;
}

function link(board, from, to, type) {
  return core.addDependencyIn(board, from, to, type, { now: T1 }).state;
}

test("addDependencyIn: stores a composite-scoped edge and emits dependency.added", () => {
  const board = boardWithCards(2);
  const res = core.addDependencyIn(board, 1, 2, "blocks", { now: T1 });
  assert.equal(res.state.dependencies.length, 1);
  const dep = res.value;
  assert.equal(dep.projectId, "proj");
  assert.equal(dep.fromCard, 1);
  assert.equal(dep.toCard, 2);
  assert.equal(dep.type, "blocks");

  assert.equal(res.events.length, 1);
  assert.equal(res.events[0].kind, "dependency.added");
  assert.equal(res.events[0].entityType, "dependency");
  assert.equal(res.events[0].entityId, "proj#1->2");
  assert.equal(res.events[0].at, T1);
  assert.deepEqual(res.events[0].payload, { fromCard: 1, toCard: 2, type: "blocks" });
  // Default type is "blocks".
  assert.equal(core.addDependencyIn(board, 1, 2).value.type, "blocks");
  // Unknown endpoints never create a dangling edge.
  assert.throws(() => core.addDependencyIn(board, 1, 9), (err) => err.code === "NOT_FOUND");
});

test("addDependencyIn: self edge and duplicates are rejected", () => {
  const board = boardWithCards(2);
  assert.throws(() => core.addDependencyIn(board, 1, 1), (err) => err.code === "VALIDATION");
  assert.throws(() => core.addDependencyIn(board, 1, 1, "relates"), (err) => err.code === "VALIDATION");

  const linked = link(board, 1, 2);
  assert.throws(() => core.addDependencyIn(linked, 1, 2), (err) => err.code === "CONFLICT");
  // Same endpoints, other type is a different edge.
  assert.doesNotThrow(() => core.addDependencyIn(linked, 1, 2, "relates"));
});

test("cycles: a direct back edge is rejected", () => {
  const board = boardWithCards(2);
  const linked = link(board, 1, 2);
  assert.throws(() => core.addDependencyIn(linked, 2, 1), (err) => {
    assert.equal(err.code, "CYCLE");
    assert.deepEqual(err.details, { fromCard: 2, toCard: 1 });
    return true;
  });
  assert.equal(linked.dependencies.length, 1);
});

test("cycles: a transitive loop (3 -> 1 after 1 -> 2 -> 3) is rejected", () => {
  let board = boardWithCards(3);
  board = link(board, 1, 2);
  board = link(board, 2, 3);
  assert.throws(() => core.addDependencyIn(board, 3, 1), (err) => err.code === "CYCLE");
  // Skipping a level is fine as long as it does not close the loop.
  assert.doesNotThrow(() => core.addDependencyIn(board, 1, 3));
});

test("cycles: relates edges are not part of the blocking graph and may be mutual", () => {
  let board = boardWithCards(2);
  board = link(board, 1, 2, "relates");
  assert.doesNotThrow(() => core.addDependencyIn(board, 2, 1, "relates"));
});

test("wouldCreateCycle / assertDependencyAddable operate on a bare edge list", () => {
  const deps = [core.makeDependency("proj", 1, 2), core.makeDependency("proj", 2, 3)];
  assert.equal(core.wouldCreateCycle(deps, 3, 1), true);
  assert.equal(core.wouldCreateCycle(deps, 1, 3), false);
  assert.equal(core.wouldCreateCycle(deps, 1, 1), true);
  assert.equal(core.wouldCreateCycle(deps, 3, 1, "relates"), false);
  assert.throws(() => core.assertDependencyAddable(deps, 3, 1), (err) => err.code === "CYCLE");
  assert.doesNotThrow(() => core.assertDependencyAddable(deps, 1, 3));
});

test("removeDependencyIn: drops the edge and emits dependency.removed", () => {
  const board = link(boardWithCards(2), 1, 2);
  const res = core.removeDependencyIn(board, 1, 2, "blocks", { now: T1 });
  assert.deepEqual(res.state.dependencies, []);
  assert.equal(res.value.fromCard, 1);
  assert.equal(res.events[0].kind, "dependency.removed");
  assert.equal(res.events[0].entityId, "proj#1->2");
  assert.throws(() => core.removeDependencyIn(res.state, 1, 2), (err) => err.code === "NOT_FOUND");
});

test("blockedBy / isBlocked / isReady follow the blockers' closedAt", () => {
  const board = link(boardWithCards(2), 1, 2);
  assert.deepEqual(core.blockedBy(board, 2), [1]);
  assert.deepEqual(core.blockedBy(board, 1), []);
  assert.equal(core.isBlocked(board, 2), true);
  assert.equal(core.isBlocked(board, 1), false);

  const card2 = board.cards.find(c => c.id === 2);
  assert.equal(core.isReady(board, card2), false);
  assert.equal(core.isReady(board, board.cards.find(c => c.id === 1)), true);

  // Closing the blocker unblocks the dependent card.
  const closed = core.moveCardIn(board, 1, "done", { now: T1 }).state;
  assert.deepEqual(core.blockedBy(closed, 2), []);
  assert.equal(core.isBlocked(closed, 2), false);
  assert.equal(core.isReady(closed, closed.cards.find(c => c.id === 2)), true);
  assert.deepEqual(core.readyCards(closed).map(c => c.id), [2]);
});

test("isBlocked: a manual blockedReason blocks without any edge", () => {
  const board = boardWithCards(1);
  const patched = core.patchCardIn(board, 1, { blockedReason: "waiting on design" }, { now: T1 }).state;
  assert.deepEqual(core.blockedBy(patched, 1), []);
  assert.equal(core.isBlocked(patched, 1), true);
  assert.equal(core.isReady(patched, patched.cards[0]), false);
});

test("isReady: done-column cards and closed cards are never ready", () => {
  let board = boardWithCards(2);
  board = core.moveCardIn(board, 1, "done", { now: T1 }).state;
  const done = board.cards.find(c => c.id === 1);
  assert.equal(core.isReady(board, done), false);
  assert.deepEqual(core.readyCards(board).map(c => c.id), [2]);
});

test("blockersOf / blocksOf expose both directions of the blocks edges only", () => {
  let board = boardWithCards(3);
  board = link(board, 1, 3);
  board = link(board, 2, 3, "relates");
  assert.deepEqual(core.blockersOf(board.dependencies, 3), [1]);
  assert.deepEqual(core.blocksOf(board.dependencies, 1), [3]);
  assert.deepEqual(core.blocksOf(board.dependencies, 2), []);
});

test("topoOrder: blockers come before the cards they block", () => {
  let board = boardWithCards(4);
  board = link(board, 1, 2);
  board = link(board, 1, 3);
  board = link(board, 2, 4);

  const order = core.topoOrder(board.dependencies, [1, 2, 3, 4]);
  assert.equal(order.length, 4);
  const at = (id) => order.indexOf(id);
  assert.ok(at(1) < at(2) && at(1) < at(3) && at(2) < at(4));
  assert.deepEqual([...order].sort((a, b) => a - b), [1, 2, 3, 4]);
});

test("topoOrder: an already cyclic edge list throws CYCLE", () => {
  const deps = [core.makeDependency("proj", 1, 2), core.makeDependency("proj", 2, 1)];
  assert.throws(() => core.topoOrder(deps, [1, 2]), (err) => err.code === "CYCLE");
});

test("timeline factories: composite entity ids, actor and clock overrides", () => {
  const card = { projectId: "proj", id: 7, title: "t", columnId: "doing", priority: 2, closedAt: T1, movedAt: T1, body: "" };
  assert.equal(core.cardEntityId("proj", 7), "proj#7");
  assert.equal(core.cardCreated(card).entityId, "proj#7");
  assert.equal(core.cardCreated(card).actor, "system");
  assert.equal(core.cardCreated(card, { actor: "ui", at: T0 }).actor, "ui");
  assert.equal(core.cardMoved(card, "todo").payload.from, "todo");
  assert.equal(core.cardMoved(card, "todo").payload.to, "doing");
  assert.equal(core.cardMoved(card, "todo").payload.closedAt, T1);
  assert.deepEqual(core.cardUpdated(card, ["title"]).payload.changed, ["title"]);
  assert.equal(core.cardDeleted(card).kind, "card.deleted");

  const project = core.createProject({ slug: "proj", name: "Project" }, { now: T0 });
  assert.equal(core.projectCreated(project).entityId, project.projectId);
  assert.equal(core.projectCreated(project).kind, "project.created");
  assert.deepEqual(core.projectUpdated(project, ["name"]).payload, { changed: ["name"] });

  const dep = core.makeDependency("proj", 1, 2, "relates");
  assert.equal(core.dependencyEntityId(dep), "proj#1->2");
  assert.equal(core.dependencyAdded(dep).payload.type, "relates");
});
