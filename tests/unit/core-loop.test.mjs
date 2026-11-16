// The doing-loop picks its next card from a TODO column only: a card already in DOING is not
// "next" (v1 autoPick semantics), and a board with no ready TODO halts with a reason.
import "./_load.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const core = await import("../../src/core/index.ts");
const { initialLoopState, startLoop, tickLoop } = await import("../../src/core/loop.ts");

const T0 = "2026-01-01T00:00:00.000Z";

/** A board with the default columns and one card per specs entry, in order (#1, #2, ...). */
function boardWith(specs = []) {
  let state = core.makeBoard(core.createProject({ slug: "p", name: "P" }, { now: T0 }));
  for (const spec of specs) state = core.addCard(state, spec, { now: T0 }).state;
  return { columns: state.columns, cards: state.cards, deps: [], now: T0 };
}

const running = () => startLoop(initialLoopState("p"), T0);

test("tickLoop: a card already in DOING is never the next card", () => {
  const input = boardWith([{ title: "in flight", columnId: "doing" }, { title: "queued" }]);
  const result = tickLoop(running(), input);
  assert.equal(result.nextCardId, 2, "the TODO card wins even though #1 has the lower id");
  assert.equal(result.state.status, "running");

  // Only a DOING card left -> nothing is ready, so the loop halts instead of re-naming it.
  const onlyDoing = boardWith([{ title: "in flight", columnId: "doing" }]);
  const halted = tickLoop(running(), onlyDoing);
  assert.equal(halted.nextCardId, null);
  assert.equal(halted.state.status, "halted");
  assert.match(halted.state.haltReason, /ready/);
});

test("tickLoop: TODOs are picked by priority desc, then id asc", () => {
  const input = boardWith([
    { title: "low", priority: 1 },
    { title: "high-a", priority: 5 },
    { title: "mid", priority: 3 },
    { title: "high-b", priority: 5 },
  ]);
  const result = tickLoop(running(), input);
  assert.equal(result.nextCardId, 2, "priority 5, and #2 beats #4 on equal priority");
  assert.equal(result.state.ticks, 1);
  assert.equal(result.state.lastTickAt, T0);
  assert.equal(result.state.nextCardId, 2);
});

test("tickLoop: no ready card halts with a reason and ticks once", () => {
  const result = tickLoop(running(), boardWith([]));
  assert.equal(result.nextCardId, null);
  assert.equal(result.state.status, "halted");
  assert.match(result.state.haltReason, /ready/);
  assert.equal(result.state.ticks, 1);
  assert.equal(result.state.nextCardId, null);
});

test("tickLoop: ticking an idle or halted loop is a CONFLICT, not a silent no-op", () => {
  const idle = initialLoopState("p");
  assert.throws(() => tickLoop(idle, boardWith([])), (err) => err.code === "CONFLICT");
});
