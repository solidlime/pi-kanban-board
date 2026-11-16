// Cross-board doing-loop supervisor: one timer, every running loop ticked, and no board
// able to stop another's. Temp home + temp DB; ~/.pi/kanban is never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import "./_ts-hooks.mjs";

const { executeInit, planInit } = await import("../../src/persistence/init.ts");
const { startServer } = await import("../../src/api/start.ts");
const { tickAllLoops } = await import("../../src/supervisor.ts");

async function boot(t, opts = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "kb-loop-"));
  const home = path.join(dir, ".pi", "kanban");
  await executeInit(planInit(new Date(), home), { confirmed: true });
  const run = await startServer({ home, port: 0, wake: () => null, ...opts });
  t.after(() => run.close());
  const base = run.url.replace(/\/$/, "");
  const call = async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), authorization: `Bearer ${run.token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = JSON.parse(await res.text());
    return { status: res.status, data: json.data, error: json.error };
  };
  return { run, base, home, call };
}

test("one pass ticks every running board and leaves idle ones alone", async (t) => {
  const { run, call } = await boot(t);
  for (const slug of ["alpha", "beta", "gamma"]) await call("POST", "/api/projects", { slug });
  await call("POST", "/api/cards", { project: "alpha", title: "a1" });
  await call("POST", "/api/cards", { project: "beta", title: "b1" });
  await call("POST", "/api/loop/start", { project: "alpha" });
  await call("POST", "/api/loop/start", { project: "beta" });

  const reports = tickAllLoops(run.db, undefined, () => null);
  assert.deepEqual(reports.map(r => r.slug).sort(), ["alpha", "beta"], "gamma was never started, so it is not ticked");
  for (const r of reports) {
    assert.equal(r.status, "running");
    assert.equal(r.ticks, 1);
    assert.ok(Number.isInteger(r.nextCardId), `${r.slug} named a card`);
  }
  // Card ids are project-local, so #1 exists on both boards. The mapping must still point
  // at a card of the SAME board — a cross-board pick would look identical here.
  for (const r of reports) {
    const cards = (await call("GET", `/api/board?project=${r.slug}`)).data.cards;
    assert.ok(cards.some(c => c.id === r.nextCardId), `${r.slug} named a card that is not on its board`);
  }
});

test("a board that drains halts, and the other board keeps ticking", async (t) => {
  const { run, call } = await boot(t);
  await call("POST", "/api/projects", { slug: "busy" });
  await call("POST", "/api/projects", { slug: "drained" });
  await call("POST", "/api/cards", { project: "busy", title: "keep going" });
  // "drained": one card, and it is done — nothing ready.
  const only = await call("POST", "/api/cards", { project: "drained", title: "finished" });
  const board = await call("GET", "/api/board?project=drained");
  assert.equal(board.status, 200, "the done column exists");
  await call("POST", "/api/cards/drained/" + only.data.card.id + "/move", { columnId: "done", version: only.data.card.version });
  await call("POST", "/api/loop/start", { project: "busy" });
  await call("POST", "/api/loop/start", { project: "drained" });

  const first = tickAllLoops(run.db, undefined, () => null);
  const drained = first.find(r => r.slug === "drained");
  const busy = first.find(r => r.slug === "busy");
  assert.equal(drained.status, "halted");
  assert.match(drained.haltReason, /ready/);
  assert.equal(busy.status, "running");

  const second = tickAllLoops(run.db, undefined, () => null);
  assert.equal(second.some(r => r.slug === "drained"), false, "a halted loop is not ticked again");
  assert.equal(second.find(r => r.slug === "busy").ticks, 2, "the halted board did not stop this one");
});

test("the timer runs the pass, and stop() ends it", async (t) => {
  const { run, call } = await boot(t, { loop: { intervalMs: 20 } });
  await call("POST", "/api/projects", { slug: "timed" });
  await call("POST", "/api/cards", { project: "timed", title: "t1" });
  await call("POST", "/api/loop/start", { project: "timed" });
  assert.ok(run.supervisor, "startServer opened a supervisor when asked");

  const waitFor = async (pred, ms = 3000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await pred()) return true;
      await new Promise(r => setTimeout(r, 20));
    }
    return false;
  };
  assert.equal(await waitFor(async () => (await call("GET", "/api/loop?project=timed")).data.loop.ticks > 0), true,
    "the interval ticked the board without anyone calling /api/loop/tick");

  run.supervisor.stop();
  const after = (await call("GET", "/api/loop?project=timed")).data.loop.ticks;
  await new Promise(r => setTimeout(r, 120));
  assert.equal((await call("GET", "/api/loop?project=timed")).data.loop.ticks, after, "stop() really stopped it");
});

test("no supervisor unless asked, and none without a database", async (t) => {
  const quiet = await boot(t);
  assert.equal(quiet.run.supervisor, null);
  const explicit = await boot(t, { loop: false });
  assert.equal(explicit.run.supervisor, null);
});

test("overview rows carry each board's loop status", async (t) => {
  const { call } = await boot(t);
  await call("POST", "/api/projects", { slug: "looping" });
  await call("POST", "/api/projects", { slug: "sleeping" });
  await call("POST", "/api/cards", { project: "looping", title: "work" });
  await call("POST", "/api/loop/start", { project: "looping" });
  const rows = (await call("GET", "/api/overview")).data.projects;
  assert.equal(rows.find(r => r.projectId === "looping").loop, "running");
  assert.equal(rows.find(r => r.projectId === "sleeping").loop, "idle");
});
