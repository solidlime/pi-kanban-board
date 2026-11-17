// GET/PATCH /api/loop/settings: the three loop thresholds, one partial-update door.
// intervalAppliesOnRestart says out loud that a running supervisor keeps its cadence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupServer } from "./_harness.mjs";

test("loop settings: defaults, partial patch, and the restart caveat", async (t) => {
  const { req } = await setupServer(t);
  const g = await req("GET", "/api/loop/settings");
  assert.equal(g.status, 200);
  assert.deepEqual(g.json.data, { intervalMs: 15000, stuckDays: 7, maxLoops: 0, intervalAppliesOnRestart: true });

  const p = await req("PATCH", "/api/loop/settings", { stuckDays: 3 });
  assert.equal(p.status, 200);
  assert.deepEqual(p.json.data, { intervalMs: 15000, stuckDays: 3, maxLoops: 0, intervalAppliesOnRestart: true });

  const again = await req("GET", "/api/loop/settings");
  assert.deepEqual(again.json.data, p.json.data, "the patch is persisted, not echoed");

  const both = await req("PATCH", "/api/loop/settings", { intervalMs: 60000, maxLoops: 10 });
  assert.deepEqual(both.json.data, { intervalMs: 60000, stuckDays: 3, maxLoops: 10, intervalAppliesOnRestart: true });
});

test("loop settings: an out-of-range value is 422 and nothing is written", async (t) => {
  const { req } = await setupServer(t);
  for (const body of [{ intervalMs: 999 }, { stuckDays: 366 }, { maxLoops: -1 }, { maxLoops: 1.5 }]) {
    const bad = await req("PATCH", "/api/loop/settings", body);
    assert.equal(bad.status, 422, JSON.stringify(body));
    assert.equal(bad.json.error.code, "VALIDATION");
  }
  assert.deepEqual((await req("GET", "/api/loop/settings")).json.data,
    { intervalMs: 15000, stuckDays: 7, maxLoops: 0, intervalAppliesOnRestart: true });
});
