// The four confirmed holes in the persistence layer + doing-loop:
//   1. WIP=1 on DOING is enforced inside moveCard's transaction, not by a read-then-write.
//   2. the stuck clock is movedAt (createdAt as fallback), never updatedAt.
//   3. a sessionId attach must not bump version / updatedAt (else the user's next write 409s).
//   4. readBoard can skip the lastActors GROUP BY for callers that never read it.
import "./_load.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const P = await import("../../src/persistence/index.ts");
const R = await import("../../src/persistence/repos.ts");
const L = await import("../../src/core/loop.ts");

function freshDb(t) {
  const dir = mkdtempSync(join(tmpdir(), "kbv2-holes-"));
  const db = P.openDb(join(dir, "state.sqlite"));
  P.migrate(db);
  t.after(() => { P.closeDb(db); rmSync(dir, { recursive: true, force: true }); });
  R.createProject(db, { slug: "p" });
  return db;
}

const domainCode = (fn) => { try { fn(); return null; } catch (err) { return err.code ?? String(err); } };

test("moveCard: a second card cannot enter DOING, whatever the caller read first", (t) => {
  const db = freshDb(t);
  R.createCard(db, { projectId: "p", columnId: "todo", title: "occupant" });
  R.createCard(db, { projectId: "p", columnId: "todo", title: "challenger" });
  R.moveCard(db, "p", 1, "doing");

  assert.equal(domainCode(() => R.moveCard(db, "p", 2, "doing")), "WIP_LIMIT");
  const rejected = R.getCard(db, "p", 2);
  assert.equal(rejected.columnId, "todo", "the rejected move left the card where it was");
  assert.equal(rejected.version, 1, "and did not bump its version");
  assert.equal(R.listCards(db, "p", { columnId: "doing" }).length, 1, "DOING holds one card");

  R.moveCard(db, "p", 1, "done");
  assert.equal(R.moveCard(db, "p", 2, "doing").columnId, "doing", "DOING is free again once it empties");
});

test("moveCard: re-entering DOING with the card already there is still a no-op, not a WIP error", (t) => {
  const db = freshDb(t);
  R.createCard(db, { projectId: "p", columnId: "doing", title: "already here" });
  const cur = R.getCard(db, "p", 1);
  const same = R.moveCard(db, "p", 1, "doing");
  assert.equal(same.version, cur.version);
  assert.equal(same.movedAt, cur.movedAt);
});

test("DOING takes one card by default, and only DOING has that default", (t) => {
  const db = freshDb(t);
  assert.equal(R.getColumn(db, "p", "doing").wipLimit, null, "the shipped doing column stores no limit");
  R.createCard(db, { projectId: "p", columnId: "doing", title: "first" });
  assert.equal(domainCode(() => R.createCard(db, { projectId: "p", columnId: "doing", title: "second" })), "WIP_LIMIT",
    "one card is what makes a board a board, not a setting");

  // A column that sets a limit outranks the default, so two can be in flight on purpose.
  R.updateColumn(db, "p", "doing", { wipLimit: 2 });
  assert.equal(R.createCard(db, { projectId: "p", columnId: "doing", title: "second" }).columnId, "doing");

  // Every other column stays unlimited unless it asks.
  R.createCard(db, { projectId: "p", columnId: "todo", title: "a" });
  assert.equal(domainCode(() => R.createCard(db, { projectId: "p", columnId: "todo", title: "b" })), null);
  assert.equal(R.listCards(db, "p", { columnId: "todo" }).length, 2, "todo has no default limit");
});

const card = (id, columnId, movedAt, updatedAt) => ({
  projectId: "p", id, columnId, title: `c${id}`, body: "", priority: 0,
  owner: null, due: null, estimate: null, blockedReason: null, labels: [],
  sessionId: null, commit: null, ref: null, createdAt: "2026-01-01T00:00:00.000Z",
  movedAt, updatedAt, closedAt: null, version: 1,
});

const NOW = "2026-01-10T00:00:00.000Z";
const daysAgo = (n) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();

test("stuckDoingCard: the clock is movedAt, so a touched card stays stuck", () => {
  // Seven days in DOING, but the wake wrote sessionId today: updatedAt is fresh, movedAt is not.
  const cards = [card(1, "doing", daysAgo(7), NOW)];
  const stuck = L.stuckDoingCard(cards, "doing", NOW, 7);
  assert.equal(stuck?.card.id, 1, "a DOING card that only had its fields touched is still stuck");
  assert.equal(stuck?.days, 7);
  assert.equal(L.stuckDoingCard([card(1, "doing", daysAgo(6), NOW)], "doing", NOW, 7), null, "6 days is not 7");
});

test("stuckDoingCard: a card that moved today is not stuck however old updatedAt is", () => {
  const cards = [card(1, "doing", NOW, daysAgo(30))];
  assert.equal(L.stuckDoingCard(cards, "doing", NOW, 7), null);
});

test("updateCard({ touch: false }) writes sessionId without bumping version or updatedAt", (t) => {
  const db = freshDb(t);
  const before = R.createCard(db, { projectId: "p", columnId: "todo", title: "woken" });
  const attached = R.updateCard(db, "p", before.id, { sessionId: "sess-1" }, { actor: "loop", touch: false });
  assert.equal(attached.sessionId, "sess-1");
  assert.equal(attached.version, before.version, "a wake must not invalidate the version the user holds");
  assert.equal(attached.updatedAt, before.updatedAt, "and must not claim the card was edited");

  // The default still touches: an ordinary patch keeps the optimistic lock moving.
  const edited = R.updateCard(db, "p", before.id, { title: "renamed" }, { actor: "user" });
  assert.equal(edited.version, before.version + 1);
  assert.notEqual(edited.updatedAt, before.updatedAt);
});

test("readBoard({ withActors: false }) never runs the actor GROUP BY", (t) => {
  const db = freshDb(t);
  R.createCard(db, { projectId: "p", columnId: "todo", title: "a" }, "tester");

  const statements = [];
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => { statements.push(String(sql)); return prepare(sql); };

  const quiet = R.readBoard(db, "p", { withActors: false });
  assert.equal(quiet.cards.length, 1);
  assert.equal(quiet.cards[0].lastActor, undefined, "no actor map means no lastActor");
  assert.equal(statements.filter(s => /GROUP BY/i.test(s)).length, 0, "the actors query must not be prepared");

  const loud = R.readBoard(db, "p");
  assert.equal(statements.filter(s => /GROUP BY/i.test(s)).length, 1, "the default still fills lastActor");
  assert.equal(loud.cards[0].lastActor, "tester");
});

test("tickLoop: a tick with nothing ready says nothing halted", () => {
  const running = L.startLoop(L.initialLoopState("p", NOW), NOW);
  const result = L.tickLoop(running, { columns: [], cards: [], deps: [], now: NOW });
  assert.equal(result.nextCardId, null);
  assert.equal(result.reason, null);
  assert.equal(result.state.status, "running");
  assert.equal(result.state.haltedAt, null);
});
