// WIP limits are counted per column from the cards currently in it.
import "./_load.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const core = await import("../../src/core/index.ts");

const T0 = "2026-01-01T00:00:00.000Z";

function boardWithLimits(limits) {
  const project = core.createProject({ slug: "proj", name: "Project" }, { now: T0 });
  const columns = core.defaultColumns("proj").map(c => (limits[c.id] === undefined ? c : { ...c, wipLimit: limits[c.id] }));
  return core.makeBoard(project, columns);
}

test("wipStatus: raw occupancy, limit and remaining", () => {
  const board = boardWithLimits({ doing: 2 });
  const status = core.wipStatus(board, "doing");
  assert.deepEqual(status, { columnId: "doing", limit: 2, count: 0, full: false, remaining: 2 });

  const one = core.addCard(board, { title: "a", columnId: "doing" }, { now: T0 }).state;
  const two = core.addCard(one, { title: "b", columnId: "doing" }, { now: T0 }).state;
  assert.deepEqual(core.wipStatus(two, "doing"), { columnId: "doing", limit: 2, count: 2, full: true, remaining: 0 });
  assert.equal(core.wipStatus(two, "todo").limit, null);
  assert.equal(core.wipStatus(two, "todo").full, false);
  assert.equal(core.wipStatus(two, "todo").remaining, null);
});

test("wipError: returns a DomainError (never throws) once the column is full", () => {
  const board = boardWithLimits({ doing: 1 });
  assert.equal(core.wipError(board, "doing"), null);

  const one = core.addCard(board, { title: "a", columnId: "doing" }, { now: T0 }).state;
  const err = core.wipError(one, "doing");
  assert.equal(err.name, "DomainError");
  assert.equal(err.code, "WIP_LIMIT");
  assert.deepEqual(err.details, { columnId: "doing", limit: 1, count: 1 });
  assert.equal(core.wipError(one, "doing", { excludeCardId: 1 }), null);
  assert.throws(() => core.assertWip(one, "doing"), (e) => e.code === "WIP_LIMIT");
});

test("addCard: the third card into a limit-2 column is rejected with WIP_LIMIT", () => {
  let board = boardWithLimits({ doing: 2 });
  board = core.addCard(board, { title: "a", columnId: "doing" }, { now: T0 }).state;
  board = core.addCard(board, { title: "b", columnId: "doing" }, { now: T0 }).state;
  assert.throws(() => core.addCard(board, { title: "c", columnId: "doing" }, { now: T0 }), (err) => {
    assert.equal(err.code, "WIP_LIMIT");
    assert.deepEqual(err.details, { columnId: "doing", limit: 2, count: 2 });
    return true;
  });
  // Untouched state after the rejection.
  assert.equal(board.cards.length, 2);
});

test("moveCardIn: moving into a full column is rejected, moving out frees a slot", () => {
  let board = boardWithLimits({ doing: 1 });
  board = core.addCard(board, { title: "todo card" }, { now: T0 }).state; // #1 in todo
  board = core.addCard(board, { title: "doing card", columnId: "doing" }, { now: T0 }).state; // #2

  assert.throws(() => core.moveCardIn(board, 1, "doing", { now: T0 }), (err) => err.code === "WIP_LIMIT");

  const out = core.moveCardIn(board, 2, "todo", { now: T0 }).state;
  const moved = core.moveCardIn(out, 1, "doing", { now: T0 });
  assert.equal(moved.value.columnId, "doing");
  assert.equal(core.wipStatus(moved.state, "doing").full, true);
});

test("moveCardIn: a no-op move inside a full column is not a WIP violation", () => {
  let board = boardWithLimits({ doing: 1 });
  board = core.addCard(board, { title: "only", columnId: "doing" }, { now: T0 }).state;
  const res = core.moveCardIn(board, 1, "doing", { now: T0 });
  assert.equal(res.value.version, 1);
  assert.deepEqual(res.events, []);
});

test("moving a card out of a full column and back is allowed (card is excluded from its own count)", () => {
  let board = boardWithLimits({ doing: 1 });
  board = core.addCard(board, { title: "x", columnId: "doing" }, { now: T0 }).state;
  const todo = core.moveCardIn(board, 1, "todo", { now: T0 }).state;
  assert.equal(core.wipStatus(todo, "doing").count, 0);
  assert.doesNotThrow(() => core.moveCardIn(todo, 1, "doing", { now: T0 }));
});
