// Card create / patch / move / close rules + acceptance-derived completion.
import "./_load.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const core = await import("../../src/core/index.ts");

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-02T00:00:00.000Z";
const T2 = "2026-01-03T00:00:00.000Z";
const T3 = "2026-01-04T00:00:00.000Z";

function freshBoard() {
  const project = core.createProject({ slug: "proj", name: "Project" }, { now: T0 });
  return core.makeBoard(project);
}

function withCard(title = "card", extra = {}) {
  const res = core.addCard(freshBoard(), { title, ...extra }, { now: T0 });
  return res;
}

test("addCard: defaults, normalized fields and a card.created event", () => {
  const { state, value: card, events } = withCard("  Fix the thing  ", {
    labels: ["api", " api ", "ui"], body: "  details  ", priority: 3, owner: "  doll  ",
  });

  assert.equal(card.projectId, "proj");
  assert.equal(card.id, 1);
  assert.equal(card.columnId, "todo");
  assert.equal(card.title, "Fix the thing");
  assert.equal(card.body, "details");
  assert.equal(card.priority, 3);
  assert.equal(card.owner, "doll");
  assert.deepEqual(card.labels, ["api", "ui"]);
  assert.equal(card.closedAt, null);
  assert.equal(card.version, 1);
  assert.equal(card.createdAt, T0);
  assert.equal(card.movedAt, T0);
  assert.equal(state.cards.length, 1);

  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "card.created");
  assert.equal(events[0].entityType, "card");
  assert.equal(events[0].entityId, "proj#1");
  assert.equal(events[0].actor, "system");
  assert.equal(events[0].at, T0);
  assert.deepEqual(events[0].payload, { id: 1, title: "Fix the thing", columnId: "todo", priority: 3 });
});

test("addCard: defaults for an unspecified card", () => {
  const card = withCard().value;
  assert.equal(card.priority, 0);
  assert.equal(card.body, "");
  assert.deepEqual(card.labels, []);
  assert.equal(card.owner, null);
  assert.equal(card.due, null);
  assert.equal(card.estimate, null);
  assert.equal(card.blockedReason, null);
});

test("addCard: explicit column, unknown column, id conflict, actor override", () => {
  const { value: card } = withCard("card", { columnId: "doing" });
  assert.equal(card.columnId, "doing");

  assert.throws(() => core.addCard(freshBoard(), { title: "x", columnId: "ghost" }), (err) => err.code === "NOT_FOUND");

  const first = withCard();
  assert.throws(() => core.addCard(first.state, { title: "dupe", id: 1 }), (err) => err.code === "CONFLICT");

  const ui = core.addCard(first.state, { title: "ui card" }, { now: T1, actor: "ui" });
  assert.equal(ui.events[0].actor, "ui");
  assert.equal(ui.events[0].at, T1);
});

test("addCard: validation of title, priority, due, estimate", () => {
  assert.throws(() => core.addCard(freshBoard(), { title: "   " }), (err) => err.code === "VALIDATION");
  assert.throws(() => core.addCard(freshBoard(), { title: "x", priority: 100 }), (err) => err.code === "VALIDATION");
  assert.throws(() => core.addCard(freshBoard(), { title: "x", priority: 1.5 }), (err) => err.code === "VALIDATION");
  assert.throws(() => core.addCard(freshBoard(), { title: "x", due: "2026-02-30" }), (err) => err.code === "VALIDATION");
  assert.throws(() => core.addCard(freshBoard(), { title: "x", due: "28/02/2026" }), (err) => err.code === "VALIDATION");
  assert.throws(() => core.addCard(freshBoard(), { title: "x", estimate: -1 }), (err) => err.code === "VALIDATION");
  assert.equal(core.addCard(freshBoard(), { title: "x", due: "2026-02-28" }).value.due, "2026-02-28");
});

test("patchCardIn: bumps version, emits card.updated with the changed keys", () => {
  const { state } = withCard();
  const res = core.patchCardIn(state, 1, { title: "renamed", priority: 5 }, { now: T1 });
  assert.equal(res.value.title, "renamed");
  assert.equal(res.value.priority, 5);
  assert.equal(res.value.version, 2);
  assert.equal(res.value.updatedAt, T1);
  assert.equal(res.events.length, 1);
  assert.equal(res.events[0].kind, "card.updated");
  assert.deepEqual(res.events[0].payload.changed, ["title", "priority"]);
  assert.equal(res.state.cards[0].title, "renamed");
});

test("patchCardIn: a no-op patch keeps the version and emits nothing", () => {
  const { state } = withCard();
  const res = core.patchCardIn(state, 1, { title: "card", priority: 0 }, { now: T1 });
  assert.equal(res.state, state);
  assert.equal(res.value.version, 1);
  assert.deepEqual(res.events, []);

  assert.throws(() => core.patchCardIn(state, 99, { title: "x" }), (err) => err.code === "NOT_FOUND");
});

test("patchCardIn: optimistic locking rejects a stale version", () => {
  const { state } = withCard();
  assert.throws(() => core.patchCardIn(state, 1, { title: "x" }, { version: 7 }), (err) => err.code === "STALE_VERSION");
  assert.equal(core.patchCardIn(state, 1, { title: "x" }, { version: 1 }).value.version, 2);
});

test("moveCardIn: todo -> doing keeps the card open, sets movedAt, emits card.moved", () => {
  const { state } = withCard();
  const res = core.moveCardIn(state, 1, "doing", { now: T1 });
  assert.equal(res.value.columnId, "doing");
  assert.equal(res.value.closedAt, null);
  assert.equal(res.value.movedAt, T1);
  assert.equal(res.value.updatedAt, T1);
  assert.equal(res.value.version, 2);
  assert.equal(res.events[0].kind, "card.moved");
  assert.equal(res.events[0].payload.from, "todo");
  assert.equal(res.events[0].payload.to, "doing");
  assert.equal(res.events[0].payload.closedAt, null);
});

test("moveCardIn: entering done sets closedAt, leaving done clears it", () => {
  const { state } = withCard();
  const doing = core.moveCardIn(state, 1, "doing", { now: T1 }).state;
  const done = core.moveCardIn(doing, 1, "done", { now: T2 });
  assert.equal(done.value.columnId, "done");
  assert.equal(done.value.closedAt, T2);
  assert.equal(core.isClosed(done.value), true);
  assert.equal(done.events[0].payload.closedAt, T2);

  const reopened = core.moveCardIn(done.state, 1, "doing", { now: T3 });
  assert.equal(reopened.value.closedAt, null);
  assert.equal(core.isClosed(reopened.value), false);

  const reclosed = core.moveCardIn(reopened.state, 1, "done", { now: T3 });
  assert.equal(reclosed.value.closedAt, T3);
});

test("moveCardIn: moving within the same column is a no-op", () => {
  const { state } = withCard();
  const res = core.moveCardIn(state, 1, "todo", { now: T1 });
  assert.equal(res.state, state);
  assert.equal(res.value.version, 1);
  assert.equal(res.value.movedAt, T0);
  assert.deepEqual(res.events, []);
});

test("moveCardIn: unknown column / unknown card are domain errors", () => {
  const { state } = withCard();
  assert.throws(() => core.moveCardIn(state, 1, "ghost"), (err) => err.code === "NOT_FOUND");
  assert.throws(() => core.moveCardIn(state, 42, "doing"), (err) => err.code === "NOT_FOUND");
});

test("achieving done is gated on acceptance criteria only when asked", () => {
  const { state } = withCard("ship it", { body: "notes\n- [ ] tests pass\n- [x] docs" });
  assert.throws(
    () => core.moveCardIn(state, 1, "done", { now: T1, requireAcceptance: true }),
    (err) => err.code === "VALIDATION",
  );
  // Default: the move is allowed, the card is closed but not complete.
  const closed = core.moveCardIn(state, 1, "done", { now: T1 });
  assert.equal(core.isClosed(closed.value), true);
  assert.equal(core.isComplete(closed.value), false);
  assert.equal(core.acceptanceProgress(closed.value.body).done, 1);

  const checked = core.patchCardIn(state, 1, { body: "- [x] tests pass\n- [x] docs" }, { now: T1 }).state;
  const done = core.moveCardIn(checked, 1, "done", { now: T2, requireAcceptance: true });
  assert.equal(core.isComplete(done.value), true);
});

test("isComplete/isClosed/isOverdue", () => {
  assert.equal(core.isComplete({ closedAt: null, body: "" }), false);
  assert.equal(core.isComplete({ closedAt: T1, body: "" }), true);
  assert.equal(core.isComplete({ closedAt: T1, body: "- [ ] not yet" }), false);
  assert.equal(core.isClosed({ closedAt: null }), false);
  assert.equal(core.isOverdue({ due: "2026-01-01", closedAt: null }, new Date(T2)), true);
  assert.equal(core.isOverdue({ due: "2026-01-01", closedAt: T2 }, new Date(T2)), false);
  assert.equal(core.isOverdue({ due: null, closedAt: null }, new Date(T2)), false);
});

test("deleteCardIn: drops the card and every edge touching it", () => {
  let board = freshBoard();
  for (const title of ["a", "b"]) board = core.addCard(board, { title }, { now: T0 }).state;
  const linked = core.addDependencyIn(board, 1, 2, "blocks", { now: T0 }).state;
  assert.equal(linked.dependencies.length, 1);

  const res = core.deleteCardIn(linked, 1, { now: T1 });
  assert.deepEqual(res.value, { id: 1 });
  assert.deepEqual(res.state.cards.map(c => c.id), [2]);
  assert.deepEqual(res.state.dependencies, []);
  assert.equal(res.events[0].kind, "card.deleted");
  assert.equal(res.events[0].entityId, "proj#1");
  assert.throws(() => core.deleteCardIn(res.state, 1), (err) => err.code === "NOT_FOUND");
});

test("sortCards: priority descending then id ascending", () => {
  let board = freshBoard();
  board = core.addCard(board, { title: "low", priority: 1 }, { now: T0 }).state;
  board = core.addCard(board, { title: "high", priority: 9 }, { now: T0 }).state;
  board = core.addCard(board, { title: "mid", priority: 1 }, { now: T0 }).state;
  assert.deepEqual(core.sortCards(board.cards).map(c => c.title), ["high", "low", "mid"]);
  assert.deepEqual(core.cardsInColumn(board, "todo").map(c => c.title), ["high", "low", "mid"]);
});

test("acceptance: checklist parsing ignores fenced code and supports * and [X]", () => {
  const body = [
    "intro",
    "```",
    "- [ ] inside a fence",
    "```",
    "- [ ] open one",
    "* [x] done one",
    "  - [X] nested done",
    "- [ ]no space is not a checkbox",
  ].join("\n");
  assert.deepEqual(core.parseAcceptance(body), [
    { text: "open one", done: false },
    { text: "done one", done: true },
    { text: "nested done", done: true },
  ]);
  assert.deepEqual(core.acceptanceProgress(body), { total: 3, done: 2, complete: false });
  assert.deepEqual(core.parseAcceptance(""), []);
  assert.equal(core.acceptanceProgress(undefined).complete, true);
});

test("acceptance: appendAcceptance keeps a single blank line before the list", () => {
  assert.equal(core.appendAcceptance(undefined, "first"), "- [ ] first");
  assert.equal(core.appendAcceptance("body\n\n", { text: "next", done: true }), "body\n- [x] next");
  assert.equal(core.parseAcceptance(core.appendAcceptance("x", "y")).length, 1);
});
