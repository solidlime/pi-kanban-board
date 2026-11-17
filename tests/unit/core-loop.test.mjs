// The doing-loop picks its next card from a TODO column only: a card already in DOING is not
// "next" (v1 autoPick semantics), and a board with no ready TODO keeps running with nothing named.
import "./_load.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const core = await import("../../src/core/index.ts");
const { initialLoopState, startLoop, stopLoop, tickLoop } = await import("../../src/core/loop.ts");

const T0 = "2026-01-01T00:00:00.000Z";

/** A board with the default columns and one card per specs entry, in order (#1, #2, ...). */
function boardWith(specs = []) {
  let state = core.makeBoard(core.createProject({ slug: "p", name: "P" }, { now: T0 }));
  for (const spec of specs) state = core.addCard(state, spec, { now: T0 }).state;
  return { columns: state.columns, cards: state.cards, deps: [], now: T0 };
}

const running = () => startLoop(initialLoopState("p", T0), T0);

test("tickLoop: a card already in DOING is never the next card", () => {
  const input = boardWith([{ title: "in flight", columnId: "doing" }, { title: "queued" }]);
  const result = tickLoop(running(), input);
  assert.equal(result.nextCardId, 2, "the TODO card wins even though #1 has the lower id");
  assert.equal(result.state.status, "running");

  // Only a DOING card left -> nothing is ready, so the tick names nothing and stays running.
  const onlyDoing = boardWith([{ title: "in flight", columnId: "doing" }]);
  const empty = tickLoop(running(), onlyDoing);
  assert.equal(empty.nextCardId, null);
  assert.equal(empty.state.status, "running");
  assert.equal(empty.state.haltReason, null);
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

test("tickLoop: no ready card keeps the loop running and only counts the tick", () => {
  const result = tickLoop(running(), boardWith([]));
  assert.equal(result.reason, null);
  assert.equal(result.nextCardId, null);
  assert.equal(result.state.status, "running");
  assert.equal(result.state.haltReason, null);
  assert.equal(result.state.ticks, 1);
  assert.equal(result.state.lastTickAt, T0);
  assert.equal(result.state.nextCardId, null);
});

test("tickLoop: three empty ticks in a row stay running, ticks climb, nextCardId stays null", () => {
  let state = running();
  for (let i = 1; i <= 3; i++) {
    const result = tickLoop(state, boardWith([]));
    assert.equal(result.state.status, "running", `tick ${i}`);
    assert.equal(result.state.ticks, i, `tick ${i}`);
    assert.equal(result.state.nextCardId, null, `tick ${i}`);
    state = result.state;
  }
  assert.equal(state.haltReason, null);
  assert.equal(state.haltedAt, null);
});

test("tickLoop: ticking a halted loop is a CONFLICT, not a silent no-op", () => {
  const halted = stopLoop(initialLoopState("p", T0), T0);
  assert.throws(() => tickLoop(halted, boardWith([])), (err) => err.code === "CONFLICT");
});

test("initialLoopState: a new board is born started, not waiting", () => {
  const fresh = initialLoopState("p", T0);
  assert.equal(fresh.status, "running");
  assert.equal(fresh.startedAt, T0);
  assert.equal(fresh.ticks, 0);
});

test("tickLoop: an empty tick spends the budget, like every other heartbeat", () => {
  // `ticks` is the heartbeat, so a board that never had a card still burns maxLoops down. This is
  // the deliberate reading of the budget (see src/core/loop.ts); a separate counter would be v5.
  const empty = boardWith([]);
  const counted = tickLoop({ ...running(), ticks: 2 }, { ...empty, maxLoops: 3 });
  assert.equal(counted.state.ticks, 3);
  assert.equal(counted.state.status, "running");
  const spent = tickLoop(counted.state, { ...empty, maxLoops: 3 });
  assert.equal(spent.reason, "halted");
  assert.equal(spent.state.status, "halted");
  assert.match(String(spent.state.haltReason), /maxLoops/);
});
