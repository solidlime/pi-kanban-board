// The card's session picker: a board's cwd maps to one pi session folder, and only the names pi
// itself wrote are listed. The file scan stays in the route; this covers the shaping.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./_load.mjs";

const { sessionDirName, sessionIdOfFile, sessionNameOf, formatSessions, readSessions, isChildChunk } =
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
    { file: "2026-01-01T00-00-00-000Z_older.jsonl", name: "古い", updatedAt: "2026-01-01T00:00:00.000Z", child: false },
    { file: "2026-02-01T00-00-00-000Z_newer.jsonl", name: "新しい", updatedAt: "2026-02-01T00:00:00.000Z", child: false },
    { file: "2026-03-01T00-00-00-000Z_unnamed.jsonl", name: null, updatedAt: "2026-03-01T00:00:00.000Z", child: false },
  ]);
  assert.deepEqual(list.map(s => `${s.id}:${s.name}`), ["newer:新しい", "older:古い"]);
});

test("isChildChunk spots the marker pi-web writes into a session it made for a doll", () => {
  const child = '{"type":"custom","customType":"pi-web:subagent","data":{"id":"x"}}';
  assert.equal(isChildChunk(`{"type":"session","id":"x"}\n${child}\n`), true);
  assert.equal(isChildChunk('{"type":"custom","customType":"pi-web:side"}'), true);
  // The parent gets a custom_message notification whose customType merely STARTS the same way.
  const notice = '{"type":"custom_message","customType":"pi-web:subagent-notification","content":"done"}';
  assert.equal(isChildChunk(notice), false, "a parent's notification is not a child marker");
  assert.equal(isChildChunk('{"type":"custom","customType":["pi-web:subagent"]}'), false, "customType is a string");
  assert.equal(isChildChunk('{"type":"custom","customType":"pi-web:subagent'), false, "a cut line is not a record");
  assert.equal(isChildChunk('{"type":"session","id":"x"}'), false);
});

test("formatSessions drops the sessions pi-web made for a doll or a side pane", () => {
  const list = formatSessions([
    { file: "2026-01-01T00-00-00-000Z_parent.jsonl", name: "親", updatedAt: "2026-01-01T00:00:00.000Z", child: false },
    { file: "2026-02-01T00-00-00-000Z_doll.jsonl", name: "人形", updatedAt: "2026-02-01T00:00:00.000Z", child: true },
    // Which sessions are children is decided in isChildChunk; here only the boolean matters, so this
    // row pins the same branch as the doll and does not test the side marker on its own.
    { file: "2026-03-01T00-00-00-000Z_side.jsonl", name: "脇", updatedAt: "2026-03-01T00:00:00.000Z", child: true },
  ]);
  assert.deepEqual(list.map(s => s.name), ["親"]);
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
  // A doll's session: named, but pi-web marked it as a child, so a card cannot pick it.
  const child = '{"type":"custom","customType":"pi-web:subagent","data":{"id":"x"}}';
  await writeFile(path.join(dir, "2026-04-01T00-00-00-000Z_child.jsonl"), `${head("ルアン・メェイ レビュー")}${child}\n`);
  await writeFile(path.join(dir, "notes.txt"), "not a session");
  await utimes(path.join(dir, "2026-01-01T00-00-00-000Z_older.jsonl"), new Date("2026-01-01"), new Date("2026-01-01"));

  assert.deepEqual((await readSessions(dir)).map(s => `${s.id}:${s.name}`), ["newer:新しい", "older:古い"]);
  assert.deepEqual(await readSessions(path.join(dir, "missing")), [], "a board with no folder has no sessions");
});

test("readSessions finds the board's own sessions behind a pile of newer dolls", async (t) => {
  const { mkdtemp, writeFile, utimes } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(tmpdir(), "kb-sessions-pile-"));
  t.after(() => import("node:fs/promises").then(fs => fs.rm(dir, { recursive: true, force: true })));
  const marker = '{"type":"custom","customType":"pi-web:subagent","data":{"id":"x"}}';
  const session = (name, extra = "") => `{"type":"session","id":"x"}\n{"type":"session_info","id":"a","name":"${name}"}\n${extra}`;

  await writeFile(path.join(dir, "2026-01-01T00-00-00-000Z_board.jsonl"), session("ボードのセッション"));
  // One more doll than the list would ever show: they are written after, so they are the newest.
  for (let i = 0; i < 55; i++) {
    await writeFile(path.join(dir, `2026-02-01T00-00-00-000Z_doll${String(i).padStart(2, "0")}.jsonl`), session(`人形${i}`, `${marker}\n`));
  }
  await utimes(path.join(dir, "2026-01-01T00-00-00-000Z_board.jsonl"), new Date("2026-01-01"), new Date("2026-01-01"));

  assert.deepEqual((await readSessions(dir)).map(s => s.name), ["ボードのセッション"]);
});
