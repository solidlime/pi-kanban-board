// A6 over HTTP: GET/POST/DELETE /api/locks. A5 over HTTP: the sink is off by default and
// writes JSON Lines when KANBAN_NOTIFY_SINK points at a file. Temp home only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./_ts-hooks.mjs";
import { startTestServer } from "../helpers/server.mjs";

test("locks: acquire, refuse the second holder, list, release", async (t) => {
  const { call } = await startTestServer(t, "kb-a6-");
  assert.equal((await call("POST", "/api/projects", { slug: "lk" })).status, 201);

  assert.deepEqual((await call("GET", "/api/locks?project=lk")).data.locks, []);

  const held = await call("POST", "/api/locks", { project: "lk", resource: "board", ttlSeconds: 60 });
  assert.equal(held.status, 201);
  assert.equal(held.data.lock.resource, "board");
  assert.equal(held.data.lock.owner, "ui", "default owner");
  assert.ok(held.data.lock.expiresAt > held.data.lock.at);

  const clash = await call("POST", "/api/locks", { project: "lk", resource: "board", ttlSeconds: 60 });
  assert.equal(clash.status, 409);
  assert.equal(clash.json.error.code, "CONFLICT");
  assert.equal(clash.json.error.details.code, "LOCK_HELD");
  assert.equal(clash.json.error.details.owner, "ui");

  // A named owner is carried through; a second resource is a second lock.
  const other = await call("POST", "/api/locks", { project: "lk", resource: "card:1", owner: "daemon" });
  assert.equal(other.status, 201);
  assert.equal(other.data.lock.owner, "daemon");

  const list = await call("GET", "/api/locks?project=lk");
  assert.deepEqual(list.data.locks.map(l => l.resource), ["board", "card:1"]);
  for (const lock of list.data.locks) {
    assert.deepEqual(Object.keys(lock).sort(), ["at", "expiresAt", "owner", "resource"]);
  }

  assert.equal((await call("DELETE", "/api/locks/board?project=lk")).data.released, true);
  assert.equal((await call("DELETE", "/api/locks/board?project=lk")).data.released, false, "idempotent");
  assert.deepEqual((await call("GET", "/api/locks?project=lk")).data.locks.map(l => l.resource), ["card:1"]);

  // Validation and scope: no project, bad resource, bad ttl, unknown board.
  assert.equal((await call("GET", "/api/locks")).status, 400);
  assert.equal((await call("POST", "/api/locks", { project: "lk", resource: "../x" })).status, 422);
  assert.equal((await call("POST", "/api/locks", { project: "lk", resource: "ok", ttlSeconds: 0 })).status, 422);
  assert.equal((await call("POST", "/api/locks", { project: "nope", resource: "ok" })).status, 404);
});

test("notify sink: off by default, JSON Lines when KANBAN_NOTIFY_SINK is a file", async (t) => {
  const { call } = await startTestServer(t, "kb-a5-");
  await call("POST", "/api/projects", { slug: "n" });
  await call("POST", "/api/cards", { project: "n", title: "late", due: "2000-01-01" });

  const off = await call("GET", "/api/notifications?project=n");
  assert.equal(off.status, 200);
  assert.equal(off.data.notifications.length, 1, "the overdue card is reported");
  assert.equal(off.data.sink, undefined, "off means no sink key at all");

  const dir = mkdtempSync(join(tmpdir(), "kb-sink-http-"));
  const file = join(dir, "notify.jsonl");
  const prev = process.env.KANBAN_NOTIFY_SINK;
  process.env.KANBAN_NOTIFY_SINK = `file:${file}`;
  t.after(() => {
    if (prev === undefined) delete process.env.KANBAN_NOTIFY_SINK;
    else process.env.KANBAN_NOTIFY_SINK = prev;
  });

  const on = await call("GET", "/api/notifications?project=n");
  assert.deepEqual(on.data.sink, { path: file, written: 1, skipped: 0 });
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).notification.kind, "overdue");

  const again = await call("GET", "/api/notifications?project=n");
  assert.deepEqual(again.data.sink, { path: file, written: 0, skipped: 1 }, "24h throttle");
  assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 1);

  // A setting that is neither off nor file:<path> is a visible 422, not a silent fallback.
  process.env.KANBAN_NOTIFY_SINK = "stdout";
  const bad = await call("GET", "/api/notifications?project=n");
  assert.equal(bad.status, 422);
  assert.equal(bad.json.error.code, "VALIDATION");
});
