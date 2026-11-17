// The supervisor's two guards, tested through its own seams: a pass that outlives the interval
// is not started twice (`inFlight`), and a DOING card with no writer is woken again only after
// WAKE_RETRY_MS (level trigger, not edge). No timer runs for real and no `pi` is spawned.
import "./_load.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const { openDb } = await import("../../src/persistence/db.ts");
const { migrate } = await import("../../src/persistence/migrations.ts");
const R = await import("../../src/persistence/repos.ts");
const L = await import("../../src/core/loop.ts");
const { startSupervisor, tickAllLoops, WAKE_RETRY_MS } = await import("../../src/supervisor.ts");

function memDb(t) {
  const db = openDb(":memory:", { wal: false });
  migrate(db);
  t.after(() => db.close());
  return db;
}

test("a pass that outlives the interval is never started twice", async (t) => {
  const db = memDb(t);
  let timer = null;
  let calls = 0;
  let release = null;
  const supervisor = startSupervisor(db, {
    setInterval: (fn) => { timer = fn; return 0; },
    clearInterval: () => {},
    // A pass that does not return until the test says so: the overlap is the point.
    tickOnce: () => {
      calls += 1;
      return new Promise((resolve) => { release = () => resolve([]); });
    },
  });
  assert.equal(typeof timer, "function", "the seam captured the timer callback");

  timer();
  timer();
  assert.equal(calls, 1, "a second tick while the first is in flight is dropped, not queued");

  release();
  await new Promise((r) => setTimeout(r, 0));
  timer();
  assert.equal(calls, 2, "once the first pass settled the timer runs again");
  release();
  await new Promise((r) => setTimeout(r, 0));
  supervisor.stop();
});

test("a DOING card already in place is woken once, then not again until WAKE_RETRY_MS", async (t) => {
  const db = memDb(t);
  const base = Date.now();
  const at = (min) => new Date(base + min * 60_000).toISOString();
  const project = R.createProject(db, { slug: "level" });
  R.saveLoop(db, L.startLoop(L.initialLoopState(project.projectId), at(0)));
  const card = R.createCard(db, { projectId: project.projectId, columnId: "todo", title: "run once" });
  // A second TODO keeps the loop running: with nothing ready behind DOING the loop halts and
  // there is no later pass left to test the retry with.
  R.createCard(db, { projectId: project.projectId, columnId: "todo", title: "behind it" });

  const woke = [];
  const wake = async (_db, p, c) => { woke.push(`${p.slug}#${c.id}`); return null; };
  const log = new Map();

  const first = await tickAllLoops(db, at(0), wake, log);
  assert.equal(first[0].nextCardId, card.id);
  assert.deepEqual(woke, [`level#${card.id}`], "the card this tick moved is woken at once");

  await tickAllLoops(db, at(1), wake, log);
  assert.equal(woke.length, 1, "the same card one minute later is not woken again");

  await tickAllLoops(db, at(WAKE_RETRY_MS / 60_000 + 1), wake, log);
  assert.equal(woke.length, 2, "past WAKE_RETRY_MS the standing card is retried");
});

test("a card the tick actually moved is woken at once even when the log holds an older card", async (t) => {
  const db = memDb(t);
  const base = Date.now();
  const at = (min) => new Date(base + min * 60_000).toISOString();
  const project = R.createProject(db, { slug: "moved" });
  R.saveLoop(db, L.startLoop(L.initialLoopState(project.projectId), at(0)));
  const first = R.createCard(db, { projectId: project.projectId, columnId: "todo", title: "first" });
  const second = R.createCard(db, { projectId: project.projectId, columnId: "todo", title: "second" });

  const woke = [];
  const wake = async (_db, p, c) => { woke.push(`${p.slug}#${c.id}`); return null; };
  const log = new Map();

  await tickAllLoops(db, at(0), wake, log);
  assert.deepEqual(woke, [`moved#${first.id}`]);
  // The card left DOING, so the next pass moves the second one — a move never waits for the retry.
  R.moveCard(db, project.projectId, first.id, "done");
  await tickAllLoops(db, at(1), wake, log);
  assert.deepEqual(woke, [`moved#${first.id}`, `moved#${second.id}`], "a fresh move is woken immediately");
});
