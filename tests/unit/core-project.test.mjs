// Project/column construction and composite-id invariants (pure domain, no IO).
import "./_load.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const core = await import("../../src/core/index.ts");
const shared = await import("../../src/shared/index.ts");

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-02T03:04:05.000Z";

function makeProject(overrides = {}) {
  return core.createProject({ slug: "proj", name: "Project" }, { now: T0, ...overrides });
}

test("createProject: slug is the projectId, name defaults to slug, clock is normalized", () => {
  const p = core.createProject({ slug: "alpha" }, { now: new Date(T0) });
  assert.equal(p.projectId, "alpha");
  assert.equal(p.slug, "alpha");
  assert.equal(p.name, "alpha");
  assert.equal(p.createdAt, T0);
  assert.equal(p.updatedAt, T0);

  const named = core.createProject({ slug: "beta", name: "  Beta  " }, { now: T0 });
  assert.equal(named.name, "Beta");
});

test("createProject: rejects a bad slug or an empty name", () => {
  assert.throws(() => core.createProject({ slug: "" }), (err) => err.code === "VALIDATION");
  assert.throws(() => core.createProject({ slug: "-leading" }), (err) => err.code === "VALIDATION");
  assert.throws(() => core.createProject({ slug: "UPPER" }), (err) => err.code === "VALIDATION");
  assert.throws(() => core.createProject({ slug: "ok", name: "   " }), (err) => err.code === "VALIDATION");
});

test("renameProject/touchProject bump updatedAt but not createdAt", () => {
  const p = makeProject();
  const renamed = core.renameProject(p, "Renamed", { now: T1 });
  assert.equal(renamed.name, "Renamed");
  assert.equal(renamed.createdAt, T0);
  assert.equal(renamed.updatedAt, T1);
  assert.equal(core.touchProject(p, { now: T1 }).updatedAt, T1);
});

test("defaultColumns: todo/doing/done with ord 0..2 bound to the project", () => {
  const columns = core.defaultColumns("proj");
  assert.deepEqual(columns.map(c => c.id), ["todo", "doing", "done"]);
  assert.deepEqual(columns.map(c => c.kind), ["todo", "doing", "done"]);
  assert.deepEqual(columns.map(c => c.ord), [0, 1, 2]);
  assert.ok(columns.every(c => c.projectId === "proj" && c.wipLimit === null));
});

test("createColumn: derives the id from the name and de-duplicates with -2", () => {
  const existing = core.defaultColumns("proj");
  const first = core.createColumn("proj", { name: "Release Gate" }, existing);
  assert.equal(first.id, "release-gate");
  assert.equal(first.kind, "custom");
  assert.equal(first.ord, 3);

  const second = core.createColumn("proj", { name: "Release gate" }, [...existing, first]);
  assert.equal(second.id, "release-gate-2");
  assert.equal(second.ord, 4);
});

test("createColumn: duplicate explicit id is CONFLICT, bad kind/wip is VALIDATION", () => {
  const existing = core.defaultColumns("proj");
  assert.throws(() => core.createColumn("proj", { id: "todo", name: "Again" }, existing), (err) => err.code === "CONFLICT");
  assert.throws(() => core.createColumn("proj", { name: "X", kind: "nope" }, existing), (err) => err.code === "VALIDATION");
  assert.throws(() => core.createColumn("proj", { name: "X", wipLimit: 0 }, existing), (err) => err.code === "VALIDATION");
  assert.doesNotThrow(() => core.createColumn("proj", { name: "X", wipLimit: null }, existing));
});

test("patchColumn: name/kind/wip/ord, invalid ord rejected", () => {
  const [todo] = core.defaultColumns("proj");
  const patched = core.patchColumn(todo, { name: "Backlog", wipLimit: 5, ord: 7 });
  assert.equal(patched.name, "Backlog");
  assert.equal(patched.wipLimit, 5);
  assert.equal(patched.ord, 7);
  assert.equal(todo.name, "TODO");
  assert.throws(() => core.patchColumn(todo, { ord: -1 }), (err) => err.code === "VALIDATION");
});

test("removeColumn: structural columns are refused, custom removal re-indexes ord", () => {
  const base = core.defaultColumns("proj");
  const custom = core.createColumn("proj", { name: "QA" }, base);
  assert.throws(() => core.removeColumn(base, "todo"), (err) => err.code === "CONFLICT");
  assert.throws(() => core.removeColumn(base, "done"), (err) => err.code === "CONFLICT");
  assert.throws(() => core.removeColumn(base, "nope"), (err) => err.code === "NOT_FOUND");

  const kept = core.removeColumn([...base, custom], "doing");
  assert.deepEqual(kept.map(c => c.id), ["todo", "done", "qa"]);
  assert.deepEqual(kept.map(c => c.ord), [0, 1, 2]);
});

test("findColumn/columnsByOrd are deterministic", () => {
  const columns = core.defaultColumns("proj");
  const shuffled = [columns[2], columns[0], columns[1]];
  assert.deepEqual(core.columnsByOrd(shuffled).map(c => c.id), ["todo", "doing", "done"]);
  assert.equal(core.findColumn(columns, "doing").kind, "doing");
  assert.throws(() => core.findColumn(columns, "ghost"), (err) => err.code === "NOT_FOUND");
});

test("composite ids: ids are project-local, never resolved by bare id", () => {
  const a = core.createProject({ slug: "a" }, { now: T0 });
  const b = core.createProject({ slug: "b" }, { now: T0 });
  const boardA = core.makeBoard(a);
  const boardB = core.makeBoard(b);

  const cardA = core.addCard(boardA, { title: "same", id: 1 }, { now: T0 }).value;
  const added = core.addCard(boardB, { title: "same", id: 1 }, { now: T0 }).value;
  assert.equal(cardA.projectId, "a");
  assert.equal(added.projectId, "b");

  const cidA = shared.cid(cardA.projectId, cardA.id);
  const cidB = shared.cid(added.projectId, added.id);
  assert.notEqual(shared.formatCid(cidA), shared.formatCid(cidB));
  assert.deepEqual(shared.parseCid("a#1"), cidA);
  assert.equal(shared.formatCid(cidA), "a#1");
  assert.equal(shared.sameCid(cidA, shared.parseCid("a#1")), true);
  assert.throws(() => shared.parseCid("nohash"));
  assert.throws(() => shared.cid("a", 0));
});

test("addCard: next project-local id follows the board, allocator hook wins", () => {
  const board = core.makeBoard(makeProject());
  const first = core.addCard(board, { title: "one" }, { now: T0 });
  assert.equal(first.value.id, 1);
  assert.equal(core.nextCardId(first.state), 2);

  const second = core.addCard(first.state, { title: "two" }, { now: T0 });
  assert.equal(second.value.id, 2);

  const allocated = core.addCard(second.state, { title: "three" }, { now: T0, allocateId: () => 42 });
  assert.equal(allocated.value.id, 42);
  assert.equal(core.nextCardId(allocated.state), 43);
});
