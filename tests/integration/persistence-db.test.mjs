// Integration: v2 persistence on a temp SQLite file (never the real ~/.pi/kanban).
// The src modules are .ts with NodeNext .js specifiers; _ts-hooks bridges that at load time,
// so they must be imported dynamically AFTER the hook module has been evaluated.
import "./_ts-hooks.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const P = await import("../../src/persistence/index.ts");

/** One temp DB per test, migrated, plus a cleanup that always runs. */
function freshDb(t) {
  const dir = mkdtempSync(join(tmpdir(), "kbv2-persist-"));
  const path = join(dir, "state.sqlite");
  const db = P.openDb(path);
  const migrated = P.migrate(db);
  t.after(() => {
    P.closeDb(db);
    // win32 can still hold the file handle for a moment after close
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { db, dir, path, migrated };
}

const domainCode = (fn) => {
  try { fn(); } catch (err) { return err.code; }
  return "NO_THROW";
};

test("open+migrate: WAL, foreign_keys on, schema v4, idempotent", (t) => {
  const { db, migrated } = freshDb(t);

  assert.equal(P.journalMode(db), "wal");
  const fk = db.prepare("PRAGMA foreign_keys").get();
  assert.equal(Number(fk.foreign_keys), 1);
  assert.deepEqual(migrated.applied, [1, 2, 3, 4]);
  assert.equal(P.schemaVersion(db), 4);

  // second run is a no-op, not a duplicate-table error
  assert.deepEqual(P.migrate(db).applied, []);
  assert.equal(P.schemaVersion(db), 4);

  for (const table of ["kv_meta", "project", "column_def", "card", "dependency", "deliverable", "attachment", "timeline_event", "saved_view", "counters", "card_template", "loop_state", "card_lock"]) {
    assert.equal(P.tableExists(db, table), true, `missing table ${table}`);
  }
  // optimistic-lock column and no bare-id primary key on card
  assert.ok(P.columnsOf(db, "card").includes("version"));
  assert.deepEqual(db.prepare("PRAGMA table_info(card)").all().filter(r => r.pk > 0).map(r => r.name).sort(), ["id", "project_id"]);
});

test("project + default columns + board snapshot", (t) => {
  const { db } = freshDb(t);
  const p = P.createProject(db, { slug: "alpha", name: "Alpha" });

  assert.equal(p.projectId, "alpha");
  assert.equal(p.slug, "alpha");
  assert.deepEqual(P.listColumns(db, "alpha").map(c => [c.id, c.kind, c.ord]), [["todo", "todo", 1], ["doing", "doing", 2], ["done", "done", 3]]);
  assert.equal(P.getProject(db, "alpha").name, "Alpha");
  assert.equal(P.getProject(db, "nope"), null);

  assert.equal(domainCode(() => P.createProject(db, { slug: "alpha" })), "CONFLICT");

  const snapshot = P.readBoard(db, "alpha");
  assert.equal(snapshot.project.slug, "alpha");
  assert.equal(snapshot.columns.length, 3);
  assert.deepEqual(snapshot.cards, []);
  assert.equal(P.readBoard(db, "nope"), null);

  assert.deepEqual(P.listTimeline(db, "alpha").map(e => e.kind), ["project.created"]);
});

test("card CRUD: version bumps, stale version refuses, timeline rides along", (t) => {
  const { db } = freshDb(t);
  P.createProject(db, { slug: "alpha" });

  const card = P.createCard(db, { projectId: "alpha", columnId: "todo", title: "write tests", priority: 2, labels: ["x"] }, "tester");
  assert.equal(card.id, 1);
  assert.equal(card.version, 1);
  assert.equal(card.labels[0], "x");
  assert.equal(card.closedAt, null);

  const updated = P.updateCard(db, "alpha", 1, { title: "write more tests", body: "b" }, { expectedVersion: 1, actor: "tester" });
  assert.equal(updated.title, "write more tests");
  assert.equal(updated.version, 2);
  // untouched fields survive a partial patch
  assert.equal(updated.priority, 2);
  assert.deepEqual(updated.labels, ["x"]);

  // stale write must not change the row
  assert.equal(domainCode(() => P.updateCard(db, "alpha", 1, { title: "stale" }, { expectedVersion: 1 })), "STALE_VERSION");
  assert.equal(P.getCard(db, "alpha", 1).title, "write more tests");
  assert.equal(P.getCard(db, "alpha", 1).version, 2);

  const moved = P.moveCard(db, "alpha", 1, "doing", { expectedVersion: 2, actor: "tester" });
  assert.equal(moved.columnId, "doing");
  assert.equal(moved.version, 3);
  assert.notEqual(moved.movedAt, card.movedAt);
  assert.equal(moved.closedAt, null);

  // done closes, leaving done reopens
  assert.ok(P.moveCard(db, "alpha", 1, "done").closedAt);
  assert.equal(P.moveCard(db, "alpha", 1, "todo").closedAt, null);

  // unknown target column is a validation error, not a silent no-op
  assert.equal(domainCode(() => P.moveCard(db, "alpha", 1, "ghost")), "VALIDATION");
  assert.equal(domainCode(() => P.createCard(db, { projectId: "alpha", columnId: "ghost", title: "x" })), "VALIDATION");
  assert.equal(domainCode(() => P.createCard(db, { projectId: "alpha", columnId: "todo", title: "  " })), "VALIDATION");

  P.deleteCard(db, "alpha", 1);
  assert.equal(P.getCard(db, "alpha", 1), null);
  assert.equal(domainCode(() => P.deleteCard(db, "alpha", 1)), "NOT_FOUND");

  assert.deepEqual(P.listTimeline(db, "alpha").map(e => e.kind), [
    "project.created", "card.created", "card.updated", "card.moved", "card.moved", "card.moved", "card.deleted"
  ]);
  const moveEvent = P.listTimeline(db, "alpha").find(e => e.kind === "card.moved");
  assert.deepEqual([moveEvent.payload.from, moveEvent.payload.to], ["todo", "doing"]);
  assert.equal(moveEvent.entityId, "alpha#1");
});

test("ids are project-local sequences; nothing resolves a bare id across projects", (t) => {
  const { db } = freshDb(t);
  P.createProject(db, { slug: "p1" });
  P.createProject(db, { slug: "p2" });

  assert.equal(P.createCard(db, { projectId: "p1", columnId: "todo", title: "a" }).id, 1);
  assert.equal(P.createCard(db, { projectId: "p1", columnId: "todo", title: "b" }).id, 2);
  assert.equal(P.createCard(db, { projectId: "p2", columnId: "todo", title: "c" }).id, 1, "sequence restarts per project");

  assert.equal(P.peekNextId(db, "p1", "card"), 3);
  assert.equal(P.peekNextId(db, "p2", "card"), 2);
  // peek must not consume
  assert.equal(P.createCard(db, { projectId: "p2", columnId: "todo", title: "d" }).id, 2);

  // the same numeric id lives in both projects, and lookups are project-scoped
  assert.equal(P.getCard(db, "p1", 1).title, "a");
  assert.equal(P.getCard(db, "p2", 1).title, "c");
  assert.equal(P.getCard(db, "p1", 9), null);

  // a column of another project is not reachable through a bare column id
  P.createColumn(db, { projectId: "p2", id: "only-p2", name: "P2", kind: "custom" });
  assert.equal(domainCode(() => P.moveCard(db, "p1", 1, "only-p2")), "VALIDATION");

  assert.deepEqual(P.listCards(db, "p1").map(c => c.id), [1, 2]);
  assert.deepEqual(P.listCards(db, "p2").map(c => c.id), [1, 2]);
});

test("a rolled back write leaves neither state nor timeline behind", (t) => {
  const { db } = freshDb(t);
  P.createProject(db, { slug: "alpha" });
  P.createCard(db, { projectId: "alpha", columnId: "todo", title: "a" });
  const before = P.listTimeline(db, "alpha").length;

  // real path: a stale move must not add a card.moved event
  assert.equal(domainCode(() => P.moveCard(db, "alpha", 1, "doing", { expectedVersion: 99 })), "STALE_VERSION");
  assert.equal(P.getCard(db, "alpha", 1).columnId, "todo");
  assert.equal(P.listTimeline(db, "alpha").length, before);

  // mechanical path: throw after the event was written inside the same tx
  assert.throws(() => P.withTx(db, () => {
    P.appendTimeline(db, { projectId: "alpha", entityType: "card", entityId: "alpha#1", kind: "card.updated", actor: "t" });
    P.run(db, "UPDATE card SET title = 'ghost' WHERE project_id = 'alpha' AND id = 1");
    throw new Error("boom");
  }), /boom/);
  assert.equal(P.listTimeline(db, "alpha").length, before);
  assert.equal(P.getCard(db, "alpha", 1).title, "a");

  // timeline is append-only at the sqlite level, not just by convention
  assert.throws(() => P.run(db, "UPDATE timeline_event SET kind = 'x' WHERE project_id = 'alpha'"), /append-only/);
  assert.throws(() => P.run(db, "DELETE FROM timeline_event WHERE project_id = 'alpha'"), /append-only/);
  assert.equal(P.listTimeline(db, "alpha").length, before);
});

test("dependencies: composite FK, uniqueness, self-reference, cascade", (t) => {
  const { db } = freshDb(t);
  P.createProject(db, { slug: "alpha" });
  P.createCard(db, { projectId: "alpha", columnId: "todo", title: "a" });
  P.createCard(db, { projectId: "alpha", columnId: "todo", title: "b" });

  P.addDependency(db, { projectId: "alpha", fromCard: 1, toCard: 2, type: "blocks" });
  assert.deepEqual(P.listDependencies(db, "alpha").map(d => [d.fromCard, d.toCard, d.type]), [[1, 2, "blocks"]]);
  assert.deepEqual(P.listDependencies(db, "alpha", 2).length, 1);
  assert.equal(domainCode(() => P.addDependency(db, { projectId: "alpha", fromCard: 1, toCard: 2, type: "blocks" })), "CONFLICT");
  assert.equal(domainCode(() => P.addDependency(db, { projectId: "alpha", fromCard: 1, toCard: 1, type: "blocks" })), "VALIDATION");
  assert.equal(domainCode(() => P.addDependency(db, { projectId: "alpha", fromCard: 1, toCard: 77, type: "blocks" })), "NOT_FOUND");

  // a different type is a different row, and the same pair does not exist across projects
  P.addDependency(db, { projectId: "alpha", fromCard: 1, toCard: 2, type: "relates" });
  assert.equal(P.listDependencies(db, "alpha").length, 2);
  P.createProject(db, { slug: "beta" });
  P.createCard(db, { projectId: "beta", columnId: "todo", title: "beta card 1" });
  assert.equal(domainCode(() => P.addDependency(db, { projectId: "beta", fromCard: 1, toCard: 2, type: "blocks" })), "NOT_FOUND",
    "card 2 exists in alpha, not beta");

  // the raw table refuses a dangling (project_id, card) pair too
  assert.throws(() => P.run(db, "INSERT INTO dependency (project_id, from_card, to_card, type) VALUES ('alpha', 1, 999, 'blocks')"),
    /FOREIGN KEY constraint failed/);

  // card delete cascades its edges away
  P.deleteCard(db, "alpha", 2);
  assert.deepEqual(P.listDependencies(db, "alpha"), []);

  P.createCard(db, { projectId: "alpha", columnId: "todo", title: "c" }); // id 3
  P.addDependency(db, { projectId: "alpha", fromCard: 1, toCard: 3, type: "blocks" });
  P.removeDependency(db, { projectId: "alpha", fromCard: 1, toCard: 3, type: "blocks" });
  assert.deepEqual(P.listDependencies(db, "alpha"), []);
  assert.equal(domainCode(() => P.removeDependency(db, { projectId: "alpha", fromCard: 1, toCard: 3, type: "blocks" })), "NOT_FOUND");
});

test("two connections on one file both see committed writes (WAL + busy_timeout)", (t) => {
  const { db, path } = freshDb(t);
  P.createProject(db, { slug: "alpha" });

  const second = P.openDb(path);
  try {
    assert.equal(P.getProject(second, "alpha").slug, "alpha");

    P.createCard(db, { projectId: "alpha", columnId: "todo", title: "visible" });
    assert.deepEqual(P.listCards(second, "alpha").map(c => c.title), ["visible"]);
  } finally {
    P.closeDb(second);
  }
});
