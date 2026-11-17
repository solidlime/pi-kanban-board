// v4 makes running the default: the two reasons the loop used to halt itself are undone, an
// idle row starts running, and an explicit stop stays stopped (the row is the record of why).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./_ts-hooks.mjs";

const P = await import("../../src/persistence/index.ts");

function tempDb(t) {
  const dir = mkdtempSync(join(tmpdir(), "kbv2-mig4-"));
  const db = P.openDb(join(dir, "state.sqlite"));
  P.migrate(db, 3);
  t.after(() => {
    P.closeDb(db);
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return db;
}

const AT = "2026-01-10T00:00:00.000Z";

test("migration 4: auto-halts and idle rows go back to running, manual stops stay halted", (t) => {
  const db = tempDb(t);
  const seed = (slug, patch) => {
    const project = P.createProject(db, { slug }, "system");
    const base = P.getLoop(db, project.projectId);
    return P.saveLoop(db, { ...base, ...patch }, "system", "loop.halted").projectId;
  };
  const ready = seed("m-ready", { status: "halted", haltedAt: AT, haltReason: "ready なカードが無い" });
  const capped = seed("m-cap", { status: "halted", haltedAt: AT, haltReason: "maxLoops に達した" });
  const manual = seed("m-manual", { status: "halted", haltedAt: AT, haltReason: "stopped manually" });
  const typed = seed("m-typed", { status: "halted", haltedAt: AT, haltReason: "done for today" });
  const idle = seed("m-idle", { status: "idle", startedAt: null });
  const fresh = P.createProject(db, { slug: "m-fresh" }, "system").projectId; // no loop_state row

  assert.deepEqual(P.migrate(db).applied, [4], "only the new version runs");

  for (const id of [ready, capped]) {
    const loop = P.getLoop(db, id);
    assert.deepEqual([loop.status, loop.haltedAt, loop.haltReason], ["running", null, null], `auto halt ${id}`);
  }
  assert.equal(P.getLoop(db, idle).status, "running", "an idle row starts running");
  assert.equal(P.getLoop(db, fresh).status, "running", "a board with no row is born started");
  for (const id of [manual, typed]) {
    const loop = P.getLoop(db, id);
    assert.deepEqual([loop.status, loop.haltedAt, loop.haltReason], ["halted", AT, loop.haltReason], `manual stop ${id}`);
    assert.notEqual(loop.haltReason, null);
  }
  assert.equal(P.schemaVersion(db), 4);
});
