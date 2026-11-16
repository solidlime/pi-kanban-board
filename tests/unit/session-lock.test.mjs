// Session lock: at most one writer per pi session JSONL. HOME is a temp dir, so the real
// ~/.pi/kanban is never touched, and pi-web is never called: the socket is pointed at port 1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import "./_load.mjs";

const { acquireSessionLock } = await import("../../src/agent/session-lock.ts");

/** A throwaway HOME plus the session folder a board's cwd would name. */
function sandbox(t) {
  const home = mkdtempSync(path.join(tmpdir(), "kb-lock-"));
  const before = process.env.HOME;
  process.env.HOME = home; // os.homedir() reads HOME on POSIX
  // Nothing here may talk to a real pi-web: port 1 refuses instantly, so the mtime fallback runs.
  const beforeUrl = process.env.KANBAN_PIWEB_URL;
  process.env.KANBAN_PIWEB_URL = "http://127.0.0.1:1";
  t.after(() => {
    if (before === undefined) delete process.env.HOME;
    else process.env.HOME = before;
    if (beforeUrl === undefined) delete process.env.KANBAN_PIWEB_URL;
    else process.env.KANBAN_PIWEB_URL = beforeUrl;
  });
  const sessionDir = path.join(home, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  const lockPath = (sessionId) => path.join(home, ".pi", "kanban", "locks", `${sessionId}.lock`);
  return { home, sessionDir, lockPath };
}

/** A fetch that answers /api/agent/running with the given ids, and counts its calls. */
function fakePiWeb(runningSessionIds) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ runningSessionIds, subagentsActiveSessionIds: [], awaitingInputSessionIds: [] }) };
  };
  return { calls, fetch };
}

test("同じ sessionId の 2 回目は null（生きている持ち主がいる）", async (t) => {
  const { sessionDir, lockPath } = sandbox(t);
  const first = await acquireSessionLock("sid-taken", sessionDir);
  assert.ok(first, "the first acquire wins");
  assert.equal(await acquireSessionLock("sid-taken", sessionDir), null, "the second is refused");
  assert.equal(Number(readFileSync(lockPath("sid-taken"), "utf8")), process.pid, "the lock names the owner");
});

test("release の後は同じ sessionId をもう一度取れる", async (t) => {
  const { sessionDir } = sandbox(t);
  const first = await acquireSessionLock("sid-release", sessionDir);
  assert.ok(first);
  first.release();
  const second = await acquireSessionLock("sid-release", sessionDir);
  assert.ok(second, "a released lock is free again");
  second.release();
});

test("死んだ pid のロックは奪う", async (t) => {
  const { sessionDir, lockPath } = sandbox(t);
  mkdirSync(path.dirname(lockPath("sid-dead")), { recursive: true });
  writeFileSync(lockPath("sid-dead"), String(process.pid + 999999));
  const lock = await acquireSessionLock("sid-dead", sessionDir);
  assert.ok(lock, "a lock whose owner is gone does not block a wake");
  assert.equal(Number(readFileSync(lockPath("sid-dead"), "utf8")), process.pid, "the new owner is written in");
});

test("直近に書かれた JSONL があれば null（見えない書き手が居る）", async (t) => {
  const { sessionDir } = sandbox(t);
  writeFileSync(path.join(sessionDir, "sid-live.jsonl"), '{"type":"message"}\n');
  assert.equal(await acquireSessionLock("sid-live", sessionDir), null);
});

test("古い JSONL は止めない（新規セッションは素通し）", async (t) => {
  const { sessionDir } = sandbox(t);
  const file = path.join(sessionDir, "sid-old.jsonl");
  writeFileSync(file, '{"type":"message"}\n');
  const old = new Date(Date.now() - 60 * 60 * 1000);
  utimesSync(file, old, old);
  const lock = await acquireSessionLock("sid-old", sessionDir);
  assert.ok(lock, "a session nobody has written to for an hour is free");
  lock.release();
  const fresh = await acquireSessionLock("sid-none", sessionDir);
  assert.ok(fresh, "no JSONL at all is a brand new session");
  fresh.release();
});

test("pi-web の runningSessionIds に居たら null（mtime に関係なく）", async (t) => {
  const { sessionDir } = sandbox(t);
  const piweb = fakePiWeb(["sid-piweb"]);
  const taken = await acquireSessionLock("sid-piweb", sessionDir, { fetch: piweb.fetch });
  assert.equal(taken, null);
  assert.deepEqual(piweb.calls, ["http://127.0.0.1:1/api/agent/running"], "one query to the one endpoint, nothing else");

  const free = await acquireSessionLock("sid-other", sessionDir, { fetch: piweb.fetch });
  assert.ok(free, "a session pi-web is not running is free when the JSONL is quiet");
  free.release();
});

test("pi-web が落ちていれば mtime フォールバックだけが止める", async (t) => {
  const { sessionDir } = sandbox(t);
  writeFileSync(path.join(sessionDir, "sid-quiet.jsonl"), '{"type":"message"}\n');
  const down = async () => { throw new Error("ECONNREFUSED"); };
  assert.equal(await acquireSessionLock("sid-quiet", sessionDir, { fetch: down }), null, "fresh JSONL still blocks");
  const dead = async () => ({ ok: false, status: 502, json: async () => ({}) });
  assert.ok(await acquireSessionLock("sid-never-seen", sessionDir, { fetch: dead }), "no JSONL means a new session");
});
