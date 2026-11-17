// A tick honours the two stopping thresholds from loop.settings: maxLoops (a tick budget,
// 0 = unlimited, v1 #67) and stuckDays (a DOING card nobody moved, v1's stuck halt).
import "./_ts-hooks.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const P = await import("../../src/persistence/index.ts");
const R = await import("../../src/persistence/repos.ts");
const L = await import("../../src/core/loop.ts");
const { tickProject } = await import("../../src/loop-runner.ts");

function freshDb(t) {
  const dir = mkdtempSync(join(tmpdir(), "kbv2-limits-"));
  const db = P.openDb(join(dir, "state.sqlite"));
  P.migrate(db);
  t.after(() => { P.closeDb(db); rmSync(dir, { recursive: true, force: true }); });
  return db;
}

/** A running loop on one board, plus `n` TODO cards. */
function board(t, n) {
  const db = freshDb(t);
  R.createProject(db, { slug: "p" });
  for (let i = 1; i <= n; i++) R.createCard(db, { projectId: "p", columnId: "todo", title: `c${i}` });
  R.saveLoop(db, L.startLoop(L.initialLoopState("p", at(0)), new Date().toISOString()));
  return db;
}

/** `mins` minutes from now, so the boards never look stale by accident. */
const at = (mins) => new Date(Date.now() + mins * 60_000).toISOString();

/** The last loop row. `seq` is what tells "this tick wrote a row" from "a row was already there";
 *  the entity filter keeps a card row written by moveCard earlier in the same tick out of it. */
const latest = (db) => db.prepare("SELECT seq, kind FROM timeline_event WHERE project_id = 'p' AND entity_type = 'loop' ORDER BY seq DESC LIMIT 1").get();

test("maxLoops: the loop halts on the tick after its budget is spent", (t) => {
  const db = board(t, 3);
  R.saveLoopSettings(db, { maxLoops: 2 });
  // The kind is the audit trail: a budget stop must not be filed as a plain tick.
  const seed = latest(db).seq; // board() seeds the loop with one loop.tick row
  const first = tickProject(db, "p", at(1));
  assert.equal(first.loop.status, "running");
  assert.equal(first.loop.ticks, 1);
  assert.ok(latest(db).seq > seed, "a tick that moved a card writes a row");
  assert.equal(latest(db).kind, "loop.tick", "a tick that moved a card is a tick");
  const afterFirst = latest(db).seq;
  const second = tickProject(db, "p", at(2));
  assert.equal(second.loop.status, "running", "two ticks were allowed");
  assert.equal(second.loop.ticks, 2);
  // DOING is occupied by card 1, so tick 2 named a card and moved nothing: quiet, no row.
  assert.equal(latest(db).seq, afterFirst, "a tick that moved nothing writes no row");
  const third = tickProject(db, "p", at(3));
  assert.equal(third.loop.status, "halted");
  assert.equal(third.loop.ticks, 2, "a halted tick does not spend a third one");
  assert.match(third.loop.haltReason, /maxLoops/);
  assert.equal(third.moved, null);
  assert.equal(third.nextCardId, null);
  assert.equal(latest(db).seq, afterFirst + 1, "a halt writes exactly one row");
  assert.equal(latest(db).kind, "loop.halted", "a budget halt is a halt, not a tick");
});

test("maxLoops 0 is unlimited: the same board keeps ticking", (t) => {
  const db = board(t, 3);
  assert.equal(R.getLoopSettings(db).maxLoops, 0);
  for (let i = 1; i <= 3; i++) assert.equal(tickProject(db, "p", at(i)).loop.status, "running", `tick ${i}`);
});

test("stuckDays: a DOING card nobody touched halts the loop and names it", (t) => {
  const db = freshDb(t);
  R.createProject(db, { slug: "p" });
  R.createCard(db, { projectId: "p", columnId: "doing", title: "stuck one" });
  R.createCard(db, { projectId: "p", columnId: "todo", title: "waiting" });
  R.saveLoop(db, L.startLoop(L.initialLoopState("p", at(0)), at(0)));
  const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
  db.prepare("UPDATE card SET updated_at = ?, moved_at = ? WHERE project_id = 'p' AND id = 1").run(old, old);
  R.saveLoopSettings(db, { stuckDays: 7 });

  const result = tickProject(db, "p", at(0));
  assert.equal(result.loop.status, "halted");
  assert.equal(result.loop.haltReason, "DOING の #1 が 10 日動いていない");
  assert.equal(latest(db).kind, "loop.halted", "a stuck halt is filed as a halt too");
  assert.equal(result.moved, null);
  assert.equal(result.nextCardId, null, "a stuck board is not asked for its next card");
});

test("stuckDays: the default 7 days already halts a 10-day-old card", (t) => {
  const db = freshDb(t);
  R.createProject(db, { slug: "p" });
  R.createCard(db, { projectId: "p", columnId: "doing", title: "busy" });
  R.createCard(db, { projectId: "p", columnId: "todo", title: "waiting" });
  R.saveLoop(db, L.startLoop(L.initialLoopState("p", at(0)), at(0)));
  const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
  db.prepare("UPDATE card SET updated_at = ?, moved_at = ? WHERE project_id = 'p' AND id = 1").run(old, old);
  assert.equal(tickProject(db, "p", at(0)).loop.status, "halted", "no saved settings means 7 days");
});

test("stuckDays 0 turns the check off", (t) => {
  const db = freshDb(t);
  R.createProject(db, { slug: "p" });
  R.createCard(db, { projectId: "p", columnId: "doing", title: "old but not stuck" });
  R.createCard(db, { projectId: "p", columnId: "todo", title: "waiting" });
  R.saveLoop(db, L.startLoop(L.initialLoopState("p", at(0)), at(0)));
  const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
  db.prepare("UPDATE card SET updated_at = ?, moved_at = ? WHERE project_id = 'p' AND id = 1").run(old, old);
  R.saveLoopSettings(db, { stuckDays: 0 });
  const off = tickProject(db, "p", at(1));
  assert.equal(off.loop.status, "running", "0 disables the stuck halt");
  assert.equal(off.nextCardId, 2, "the TODO card was named while DOING stayed occupied");
});

test("a quiet tick is state, not an event: an empty board writes no loop.tick row", (t) => {
  const db = board(t, 0);
  const ticks = () => db.prepare("SELECT COUNT(*) AS n FROM timeline_event WHERE project_id = 'p' AND kind = 'loop.tick'").get().n;
  const before = ticks(); // board() seeds the loop, which is one real event
  for (const m of [1, 2, 3]) assert.equal(tickProject(db, "p", at(m)).loop.status, "running");
  assert.equal(ticks(), before, "three empty ticks saved three clocks but wrote no timeline rows");
  R.createCard(db, { projectId: "p", columnId: "todo", title: "now ready" });
  const moved = tickProject(db, "p", at(4));
  assert.equal(moved.moved?.title, "now ready");
  assert.equal(ticks(), before + 1, "a tick that moved a card is still an event");
});
