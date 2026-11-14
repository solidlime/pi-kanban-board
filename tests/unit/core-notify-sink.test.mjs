// A5: the sink is off unless configured, writes JSON Lines, and never repeats the same slot
// inside 24h. Temp dir only — ~/.pi/kanban is never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadShared } from "./_load.mjs";

const sink = await import("../../src/core/notify-sink.ts");
const { parseSinkSetting, deliverNotifications, slotOf, THROTTLE_MS } = sink;
const { DomainError } = await loadShared();

const notice = (over = {}) => ({
  projectId: "p", kind: "overdue", level: "danger", cardId: 1, title: "late", detail: "期限 2026-01-01",
  ...over,
});

test("parseSinkSetting: off by default, file:<path> when asked, anything else is a 422", () => {
  assert.deepEqual(parseSinkSetting(undefined), { kind: "off" });
  assert.deepEqual(parseSinkSetting("  "), { kind: "off" });
  assert.deepEqual(parseSinkSetting("off"), { kind: "off" });
  assert.deepEqual(parseSinkSetting("file:/tmp/n.jsonl"), { kind: "file", path: "/tmp/n.jsonl" });
  assert.deepEqual(parseSinkSetting("file:  C:/tmp/spaced.jsonl "), { kind: "file", path: "C:/tmp/spaced.jsonl" });
  for (const bad of ["file:", "file:   ", "http://x/n", "stdout"]) {
    assert.throws(() => parseSinkSetting(bad), (err) => err instanceof DomainError && err.code === "VALIDATION", bad);
  }
});

test("deliverNotifications: off writes nothing, file mode appends one JSON line per notice", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "kb-sink-"));
  const file = path.join(dir, "nested", "notify.jsonl");
  assert.equal(deliverNotifications([notice()], { kind: "off" }), null);

  const now = new Date("2026-01-10T00:00:00.000Z");
  const first = deliverNotifications([notice(), notice({ cardId: 2, kind: "blocked", level: "warn" })], { kind: "file", path: file }, { now });
  assert.deepEqual(first, { path: file, written: 2, skipped: 0 });

  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  const parsed = lines.map((l) => JSON.parse(l));
  assert.equal(parsed[0].at, "2026-01-10T00:00:00.000Z");
  assert.equal(parsed[0].slot, "p|overdue|1|");
  assert.equal(parsed[0].notification.title, "late", "the notice is carried whole");
  assert.equal(parsed[1].notification.kind, "blocked");
});

test("deliverNotifications: the same slot waits 24h, a new slot goes out at once", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "kb-sink-"));
  const file = path.join(dir, "notify.jsonl");
  const setting = { kind: "file", path: file };
  const t0 = new Date("2026-01-10T00:00:00.000Z");

  assert.equal(deliverNotifications([notice()], setting, { now: t0 }).written, 1);

  const soon = new Date(t0.getTime() + 3_600_000);
  const again = deliverNotifications([notice({ detail: "期限 まだ" })], setting, { now: soon });
  assert.deepEqual(again, { path: file, written: 0, skipped: 1 }, "same slot, 1h later");

  const fresh = deliverNotifications([notice(), notice({ cardId: 9 })], setting, { now: soon });
  assert.deepEqual(fresh, { path: file, written: 1, skipped: 1 }, "a new card still gets through");

  const after = new Date(t0.getTime() + THROTTLE_MS + 1);
  assert.equal(deliverNotifications([notice()], setting, { now: after }).written, 1, "the slot reopens after 24h");
  assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 3);
});

test("deliverNotifications: a corrupt tail line does not swallow the history", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "kb-sink-"));
  const file = path.join(dir, "notify.jsonl");
  const t0 = new Date("2026-01-10T00:00:00.000Z");
  deliverNotifications([notice()], { kind: "file", path: file }, { now: t0 });
  writeFileSync(file, `${readFileSync(file, "utf8")}{"slot":"p|overdue|1|","at":"half`, "utf8");

  const soon = new Date(t0.getTime() + 60_000);
  assert.equal(deliverNotifications([notice()], { kind: "file", path: file }, { now: soon }).skipped, 1);
});

test("slotOf: identity is who/what/where, so a changed detail is not a new notification", () => {
  assert.equal(slotOf(notice({ title: "renamed", detail: "x" })), slotOf(notice()));
  assert.equal(slotOf(notice({ columnId: "done", kind: "wip", cardId: undefined })), "p|wip||done");
  assert.notEqual(slotOf(notice({ projectId: "q" })), slotOf(notice()));
});
