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
  const wake = async (_db, p, c) => { woke.push(`${p.slug}#${c.id}`); return { sessionId: "s", pid: undefined, via: "pi-web" }; };
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

  const moved = [];
  const wake = async (_db, p, c) => { moved.push(`${p.slug}#${c.id}`); return { sessionId: "s", pid: undefined, via: "pi-web" }; };
  const log = new Map();

  await tickAllLoops(db, at(0), wake, log);
  assert.deepEqual(moved, [`moved#${first.id}`]);
  // The card left DOING, so the next pass moves the second one — a move never waits for the retry.
  R.moveCard(db, project.projectId, first.id, "done");
  await tickAllLoops(db, at(1), wake, log);
  assert.deepEqual(moved, [`moved#${first.id}`, `moved#${second.id}`], "a fresh move is woken immediately");
});

// #26: busy/in-flight means the session has a writer and the card moves when that turn ends, so
// the retry belongs on the next pass (15s) — not after WAKE_RETRY_MS, and not never.
test("busy で見送ったカードは WAKE_RETRY_MS を待たずに次の tick で再試行される", async (t) => {
  const db = memDb(t);
  const base = Date.now();
  const at = (min) => new Date(base + min * 60_000).toISOString();
  const project = R.createProject(db, { slug: "busy-retry" });
  R.saveLoop(db, L.startLoop(L.initialLoopState(project.projectId), at(0)));
  const card = R.createCard(db, { projectId: project.projectId, columnId: "todo", title: "run" });
  R.createCard(db, { projectId: project.projectId, columnId: "todo", title: "behind it" });

  const woke = [];
  const wake = async (_db, p, c) => { woke.push(`${p.slug}#${c.id}`); return { refused: "busy" }; };
  const log = new Map();

  await tickAllLoops(db, at(0), wake, log);
  assert.deepEqual(woke, [`busy-retry#${card.id}`]);
  // 15s later — far below WAKE_RETRY_MS.
  await tickAllLoops(db, at(0.25), wake, log);
  assert.equal(woke.length, 2, "a busy card is retried on the next tick");
  await tickAllLoops(db, at(0.5), wake, log);
  assert.equal(woke.length, 3, "and again, for as long as the session is busy");
});

test("in-flight も同じく次の tick で再試行される", async (t) => {
  const db = memDb(t);
  const base = Date.now();
  const at = (min) => new Date(base + min * 60_000).toISOString();
  const project = R.createProject(db, { slug: "in-flight-retry" });
  R.saveLoop(db, L.startLoop(L.initialLoopState(project.projectId), at(0)));
  const card = R.createCard(db, { projectId: project.projectId, columnId: "todo", title: "run" });
  R.createCard(db, { projectId: project.projectId, columnId: "todo", title: "behind it" });

  let calls = 0;
  const wake = async () => { calls += 1; return { refused: "in-flight" }; };
  const log = new Map();

  await tickAllLoops(db, at(0), wake, log);
  await tickAllLoops(db, at(0.25), wake, log);
  assert.equal(calls, 2, "the wake in flight is attempted again next pass");
  assert.ok(card.id > 0);
});

test("unclear / not-doing は 5 分待つ（POST ストームを防ぐ）", async (t) => {
  const base = Date.now();
  const at = (min) => new Date(base + min * 60_000).toISOString();
  for (const reason of ["unclear", "not-doing"]) {
    // One board per reason: a pass ticks every project, so a shared db would count its neighbour.
    const db = memDb(t);
    const project = R.createProject(db, { slug: `no-retry-${reason}` });
    R.saveLoop(db, L.startLoop(L.initialLoopState(project.projectId), at(0)));
    R.createCard(db, { projectId: project.projectId, columnId: "todo", title: "run" });
    R.createCard(db, { projectId: project.projectId, columnId: "todo", title: "behind it" });

    let calls = 0;
    const wake = async () => { calls += 1; return { refused: reason }; };
    const log = new Map();

    await tickAllLoops(db, at(0), wake, log);
    assert.equal(calls, 1, `${reason}: woken once`);
    await tickAllLoops(db, at(1), wake, log);
    assert.equal(calls, 1, `${reason}: the 5 minute wait still applies`);
    await tickAllLoops(db, at(WAKE_RETRY_MS / 60_000 + 1), wake, log);
    assert.equal(calls, 2, `${reason}: past WAKE_RETRY_MS it is retried`);
  }
});

test("配送成功したカードは 5 分呼ばれない", async (t) => {
  const db = memDb(t);
  const base = Date.now();
  const at = (min) => new Date(base + min * 60_000).toISOString();
  const project = R.createProject(db, { slug: "delivered" });
  R.saveLoop(db, L.startLoop(L.initialLoopState(project.projectId), at(0)));
  R.createCard(db, { projectId: project.projectId, columnId: "todo", title: "run" });
  R.createCard(db, { projectId: project.projectId, columnId: "todo", title: "behind it" });

  let calls = 0;
  const wake = async () => { calls += 1; return { sessionId: "s", pid: undefined, via: "pi-web" }; };
  const log = new Map();

  await tickAllLoops(db, at(0), wake, log);
  await tickAllLoops(db, at(1), wake, log);
  assert.equal(calls, 1, "a delivered wake is not repeated inside WAKE_RETRY_MS");
  await tickAllLoops(db, at(WAKE_RETRY_MS / 60_000 + 1), wake, log);
  assert.equal(calls, 2, "the level trigger still retries after it");
});

// The one test that kills `at: clock` on the busy path: advancing the timestamp would push the
// busy card onto the 5 minute wait, and its wake would land behind the turn it is waiting for.
test("busy で見送っても at は据え置き: 5 分経過後の busy は 15 秒後に再試行される", async (t) => {
  const db = memDb(t);
  const base = Date.now();
  const at = (min) => new Date(base + min * 60_000).toISOString();
  const at_ = (min, sec) => new Date(base + min * 60_000 + sec * 1_000).toISOString();
  const project = R.createProject(db, { slug: "busy-keeps-at" });
  R.saveLoop(db, L.startLoop(L.initialLoopState(project.projectId), at(0)));
  R.createCard(db, { projectId: project.projectId, columnId: "todo", title: "run" });
  R.createCard(db, { projectId: project.projectId, columnId: "todo", title: "behind it" });

  let calls = 0;
  // Delivered at t0, busy once the 5 minute retry comes round.
  const wake = async () => { calls += 1; return calls === 1 ? { sessionId: "s", pid: undefined, via: "pi-web" } : { refused: "busy" }; };
  const log = new Map();

  await tickAllLoops(db, at(0), wake, log);
  assert.equal(calls, 1, "t0: delivered");
  assert.equal(log.get(project.projectId).at, Date.parse(at(0)), "t0 is the timestamp that has to survive");

  await tickAllLoops(db, at(6), wake, log);
  assert.equal(calls, 2, "t0+6m: past WAKE_RETRY_MS, so the standing card is asked again");
  assert.equal(log.get(project.projectId).at, Date.parse(at(0)), "a busy refusal must not move `at` to t0+6m");
  assert.equal(log.get(project.projectId).busy, true, "the streak is recorded so the next pass is due");

  await tickAllLoops(db, at_(6, 15), wake, log);
  assert.equal(calls, 3, "t0+6m15s: the busy card is retried on the next pass, not 5 minutes later");
});

// An unexpected throw is a wait, not a reason to hammer pi-web every 15s.
// §6: a busy streak is visible once. Without an entry for the first refusal there is no streak
// to compare against, and the error repeats every pass (15s) for as long as the turn runs.
test("busy 連続の console.error は最初の 1 回だけ", async (t) => {
  const db = memDb(t);
  const base = Date.now();
  const at = (min) => new Date(base + min * 60_000).toISOString();
  const project = R.createProject(db, { slug: "busy-log-once" });
  R.saveLoop(db, L.startLoop(L.initialLoopState(project.projectId), at(0)));
  R.createCard(db, { projectId: project.projectId, columnId: "todo", title: "run" });
  R.createCard(db, { projectId: project.projectId, columnId: "todo", title: "behind it" });

  const logged = [];
  const real = console.error;
  console.error = (...a) => { logged.push(a.join(" ")); };
  t.after(() => { console.error = real; });
  const wake = async () => ({ refused: "busy" });
  const log = new Map();

  for (const min of [0, 0.25, 0.5, 0.75]) await tickAllLoops(db, at(min), wake, log);
  assert.equal(log.get(project.projectId).busy, true, "the refusal leaves a streak marker behind");
  assert.equal(log.get(project.projectId).at, Date.parse(at(0)), "the first refusal's timestamp is kept");
  assert.equal(logged.filter((l) => l.includes("busy")).length, 1, `one line per streak, got ${logged.length}`);
});

test("wake が throw したら 5 分待つ", async (t) => {
  const db = memDb(t);
  const base = Date.now();
  const at = (min) => new Date(base + min * 60_000).toISOString();
  const project = R.createProject(db, { slug: "throw-waits" });
  R.saveLoop(db, L.startLoop(L.initialLoopState(project.projectId), at(0)));
  R.createCard(db, { projectId: project.projectId, columnId: "todo", title: "run" });
  R.createCard(db, { projectId: project.projectId, columnId: "todo", title: "behind it" });

  let calls = 0;
  const wake = async () => { calls += 1; throw new Error("boom"); };
  const log = new Map();

  await tickAllLoops(db, at(0), wake, log);
  assert.equal(calls, 1, "the throw is contained by the pass");
  await tickAllLoops(db, at(1), wake, log);
  await tickAllLoops(db, at(4), wake, log);
  assert.equal(calls, 1, "a throwing wake is not retried inside WAKE_RETRY_MS");
  await tickAllLoops(db, at(WAKE_RETRY_MS / 60_000 + 1), wake, log);
  assert.equal(calls, 2, "past WAKE_RETRY_MS it is retried");
});
