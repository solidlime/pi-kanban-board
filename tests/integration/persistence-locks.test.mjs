// A6: the lock table is migration 3 — an existing v2 database upgrades in place without
// losing rows, applying 1→2→3 twice is a no-op, and the lock itself is expiry-based.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./_ts-hooks.mjs";

const P = await import("../../src/persistence/index.ts");
const L = await import("../../src/persistence/locks.ts");

function tempDb(t, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kbv2-locks-"));
  const db = P.openDb(join(dir, "state.sqlite"));
  if (opts.unmigrated !== true) P.migrate(db);
  t.after(() => {
    P.closeDb(db);
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return db;
}

test("migration 3: a v2 database with rows upgrades in place, and re-running is a no-op", (t) => {
  const db = tempDb(t, { unmigrated: true });
  // Stop at v2, fill it, then let the normal path carry 2 → 3.
  assert.deepEqual(P.migrate(db, 2).applied, [1, 2]);
  assert.equal(P.tableExists(db, "card_lock"), false);
  const project = P.createProject(db, { slug: "legacy" });
  const card = P.createCard(db, { projectId: project.projectId, columnId: "todo", title: "kept" });

  assert.deepEqual(P.migrate(db).applied, [3], "only the new version runs");
  assert.equal(P.schemaVersion(db), 3);
  assert.equal(P.tableExists(db, "card_lock"), true);
  assert.deepEqual(P.migrate(db).applied, []);
  assert.equal(P.schemaVersion(db), 3);
  assert.equal(P.getCard(db, project.projectId, card.id).title, "kept", "existing rows survive");
  assert.deepEqual(L.listLocks(db, project.projectId), []);
});

test("lock: one holder per resource, 409 for the second, expiry frees the slot", (t) => {
  const db = tempDb(t);
  const project = P.createProject(db, { slug: "lk" });
  const t0 = new Date("2026-01-10T00:00:00.000Z");

  const held = L.acquireLock(db, { projectId: project.projectId, resource: "board", owner: "daemon-a", ttlSeconds: 60 }, t0);
  assert.equal(held.owner, "daemon-a");
  assert.equal(held.expiresAt, "2026-01-10T00:01:00.000Z");
  assert.deepEqual(L.listLocks(db, project.projectId, t0), [{ ...held }]);

  const clash = (() => {
    try {
      L.acquireLock(db, { projectId: project.projectId, resource: "board", owner: "daemon-b" }, new Date(t0.getTime() + 1000));
      return null;
    } catch (err) {
      return err;
    }
  })();
  assert.equal(clash?.code, "CONFLICT");
  assert.equal(clash?.details.code, "LOCK_HELD");
  assert.equal(clash?.details.owner, "daemon-a");
  assert.equal(L.listLocks(db, project.projectId, t0).length, 1, "the failed take changed nothing");

  // Another resource is a different lock, not a conflict.
  assert.equal(L.acquireLock(db, { projectId: project.projectId, resource: "card:1", owner: "daemon-b" }, t0).owner, "daemon-b");

  // Past the expiry the row is reclaimed by whoever looks next.
  const later = new Date(t0.getTime() + 60_001);
  assert.deepEqual(L.listLocks(db, project.projectId, later).map(l => l.resource), ["card:1"]);
  assert.equal(L.acquireLock(db, { projectId: project.projectId, resource: "board", owner: "daemon-b" }, later).owner, "daemon-b");

  assert.equal(L.releaseLock(db, project.projectId, "board", later), true);
  assert.equal(L.releaseLock(db, project.projectId, "board", later), false, "release is idempotent");
});

test("lock: resource and ttl validation, and locks die with their project", (t) => {
  const db = tempDb(t);
  const project = P.createProject(db, { slug: "v" });
  const code = (fn) => {
    try { fn(); return "NO_THROW"; } catch (err) { return err.code; }
  };

  assert.equal(code(() => L.acquireLock(db, { projectId: project.projectId, resource: "", owner: "x" })), "VALIDATION");
  assert.equal(code(() => L.acquireLock(db, { projectId: project.projectId, resource: "../etc", owner: "x" })), "VALIDATION");
  assert.equal(code(() => L.acquireLock(db, { projectId: project.projectId, resource: "a/b", owner: "x" })), "VALIDATION");
  assert.equal(code(() => L.acquireLock(db, { projectId: project.projectId, resource: "ok", owner: "x", ttlSeconds: 0 })), "VALIDATION");
  assert.equal(code(() => L.acquireLock(db, { projectId: project.projectId, resource: "ok", owner: "x", ttlSeconds: 86_401 })), "VALIDATION");
  assert.equal(code(() => L.acquireLock(db, { projectId: project.projectId, resource: "ok", owner: "x", ttlSeconds: 1.5 })), "VALIDATION");
  assert.equal(L.acquireLock(db, { projectId: project.projectId, resource: "ok", owner: "x" }).owner, "x", "ttl defaults");

  // The FK cascade only bites with foreign_keys on, which openDb sets.
  db.prepare("DELETE FROM project WHERE project_id = ?").run("v");
  assert.deepEqual(L.listLocks(db, "v"), []);
});
