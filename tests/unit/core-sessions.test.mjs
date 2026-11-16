// The card's session picker: a board's cwd maps to one pi session folder, and only the names pi
// itself wrote are listed. The file scan stays in the route; this covers the shaping.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./_load.mjs";

const { sessionDirName, sessionIdOfFile, sessionNameOf, formatSessions, readSessions } =
  await import("../../src/core/sessions.ts");

test("sessionDirName maps a cwd to pi's per-directory session folder", () => {
  assert.equal(sessionDirName("/root/workspace/Nous"), "--root-workspace-Nous--");
  assert.equal(sessionDirName("/root/workspace/Nous/"), "--root-workspace-Nous--");
  assert.equal(sessionDirName("D:\\Code\\pi-kanban-board"), "--D--Code-pi-kanban-board--");
});

test("formatSessions keeps named sessions, newest first, and names their id", () => {
  const file = "2026-11-16T11-14-40-739Z_01a1e410-fbe2-77d9-9b3e-091ff3f9fba2.jsonl";
  assert.equal(sessionIdOfFile(file), "01a1e410-fbe2-77d9-9b3e-091ff3f9fba2");
  assert.equal(sessionIdOfFile("notes.txt"), null);

  // A rename appends a second session_info: the last one wins.
  const chunk = [
    '{"type":"session_info","id":"a","name":"old"}',
    '{"type":"message","message":{"role":"user","content":"session_info noise"}}',
    '{"type":"session_info","id":"b","name":"autoPick 復活とパネルタブ実装"}',
    '{"type":"session_info","id":"c","na',
  ].join("\n");
  assert.equal(sessionNameOf(chunk), "autoPick 復活とパネルタブ実装");
  assert.equal(sessionNameOf('{"type":"session_info","id":"a"}'), null, "no name, no session");

  const list = formatSessions([
    { file: "2026-01-01T00-00-00-000Z_older.jsonl", name: "古い", updatedAt: "2026-01-01T00:00:00.000Z" },
    { file: "2026-02-01T00-00-00-000Z_newer.jsonl", name: "新しい", updatedAt: "2026-02-01T00:00:00.000Z" },
    { file: "2026-03-01T00-00-00-000Z_unnamed.jsonl", name: null, updatedAt: "2026-03-01T00:00:00.000Z" },
  ]);
  assert.deepEqual(list.map(s => `${s.id}:${s.name}`), ["newer:新しい", "older:古い"]);
});

test("readSessions reads names from the folder, newest first, and skips unnamed sessions", async (t) => {
  const { mkdtemp, writeFile, utimes } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(tmpdir(), "kb-sessions-"));
  t.after(() => import("node:fs/promises").then(fs => fs.rm(dir, { recursive: true, force: true })));

  const head = (name) => `{"type":"session","id":"x"}\n{"type":"session_info","id":"a","name":"${name}"}\n`;
  await writeFile(path.join(dir, "2026-01-01T00-00-00-000Z_older.jsonl"), head("古い"));
  await writeFile(path.join(dir, "2026-02-01T00-00-00-000Z_unnamed.jsonl"), "{\"type\":\"session\"}\n");
  // Bigger than one chunk, and the name only appears at the END: the tail read has to find it.
  const big = `${head("古い名前")}${"x".repeat(64 * 1024)}\n{"type":"session_info","id":"b","name":"新しい"}\n`;
  await writeFile(path.join(dir, "2026-03-01T00-00-00-000Z_newer.jsonl"), big);
  await writeFile(path.join(dir, "notes.txt"), "not a session");
  await utimes(path.join(dir, "2026-01-01T00-00-00-000Z_older.jsonl"), new Date("2026-01-01"), new Date("2026-01-01"));

  assert.deepEqual((await readSessions(dir)).map(s => `${s.id}:${s.name}`), ["newer:新しい", "older:古い"]);
  assert.deepEqual(await readSessions(path.join(dir, "missing")), [], "a board with no folder has no sessions");
});
