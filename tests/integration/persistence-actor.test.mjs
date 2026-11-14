// A2: lastActor is the newest timeline writer, not the first or a constant. The HTTP layer
// writes as "ui" only, so this drives the repository directly with two distinct actors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./_ts-hooks.mjs";

const P = await import("../../src/persistence/index.ts");

function tempDb(t) {
  const dir = mkdtempSync(join(tmpdir(), "kbv2-actor-"));
  const db = P.openDb(join(dir, "state.sqlite"));
  P.migrate(db);
  t.after(() => {
    P.closeDb(db);
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return db;
}

const actorOf = (db, projectId, id) =>
  P.readBoard(db, projectId).cards.find(c => c.id === id)?.lastActor;

test("lastActor: the newest event wins, and a different actor actually replaces the old one", (t) => {
  const db = tempDb(t);
  const project = P.createProject(db, { slug: "who" });
  const card = P.createCard(db, { projectId: project.projectId, columnId: "todo", title: "watched" }, "system");
  assert.equal(actorOf(db, project.projectId, card.id), "system", "the creating actor is the first writer");

  P.updateCard(db, project.projectId, card.id, { title: "renamed" }, { actor: "alpha" });
  assert.equal(actorOf(db, project.projectId, card.id), "alpha");

  // Back to the first actor: proves MAX(seq) ordering, not "last distinct value" or set order.
  P.moveCard(db, project.projectId, card.id, "doing", { actor: "system" });
  assert.equal(actorOf(db, project.projectId, card.id), "system");
  P.updateCard(db, project.projectId, card.id, { owner: "herta" }, { actor: "beta" });
  assert.equal(actorOf(db, project.projectId, card.id), "beta", "the newest event is the answer");

  // Another card keeps its own writer: the projection is per card, not per board.
  const other = P.createCard(db, { projectId: project.projectId, columnId: "todo", title: "other" }, "gamma");
  assert.equal(actorOf(db, project.projectId, other.id), "gamma");
  assert.equal(actorOf(db, project.projectId, card.id), "beta");
});
