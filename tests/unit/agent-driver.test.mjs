// Waking a card: prompt shape, session id persistence, spawn arguments, and one child per
// board. A memory DB plus a fake spawn — no real `pi` process is ever started here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import "./_load.mjs";

// The session lock writes under $HOME/.pi/kanban and asks pi-web what is running, so both are
// sandboxed here: a temp home, and a fetch that always fails ("no pi-web, spawn pi yourself").
process.env.HOME = mkdtempSync(path.join(tmpdir(), "kb-driver-"));
const noPiWeb = async () => { throw new Error("ECONNREFUSED"); };

const { openDb } = await import("../../src/persistence/db.ts");
const { migrate } = await import("../../src/persistence/migrations.ts");
const repos = await import("../../src/persistence/repos.ts");
const { createProject, createCard, getCard } = repos;
const { buildCardPrompt, sessionCwd, wakeCardSession } = await import("../../src/agent/driver.ts");

function memDb(t) {
  const db = openDb(":memory:", { wal: false });
  migrate(db);
  t.after(() => db.close());
  return db;
}

function board(db, slug, settings) {
  const project = createProject(db, { slug, settings });
  const card = createCard(db, { projectId: project.projectId, columnId: "todo", title: "配線を直す", body: "右パネルが落ちる" });
  return { project, card };
}

/** Fake child: exposes the surface driver.ts touches, never exits on its own. */
function fakeSpawn() {
  const calls = [];
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = { resume() {} };
  child.stderr = new EventEmitter();
  return { calls, child, spawn: (bin, args, opts) => { calls.push({ bin, args, opts }); return child; } };
}

/** A pi-web that answers the running list and the wake POST; records every request body. */
function fakePiWeb(runningIds = [], mintedId = null) {
  const calls = [];
  const fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body ? JSON.parse(init.body) : null });
    if (u.endsWith("/api/agent/running")) return { ok: true, status: 200, json: async () => ({ runningSessionIds: runningIds }) };
    return { ok: true, status: 200, json: async () => ({ success: true, sessionId: mintedId }) };
  };
  return { calls, fetch };
}

test("buildCardPrompt names the board, the card, its title and the done step", (t) => {
  const db = memDb(t);
  const project = createProject(db, { slug: "prompt-board" });
  const card = createCard(db, {
    projectId: project.projectId, columnId: "todo", title: "配線を直す",
    body: "右パネルが落ちる\n- [ ] タブが切り替わる",
  });
  const prompt = buildCardPrompt(project, card);
  for (const needle of ["prompt-board", "1", "配線を直す", "右パネルが落ちる", "タブが切り替わる", "done"]) {
    assert.ok(prompt.includes(needle), `prompt is missing "${needle}"`);
  }
  assert.ok(prompt.split("\n").length <= 20, "prompt stays short");
});

test("wakeCardSession mints a UUID session id and stores it on the card", async (t) => {
  const db = memDb(t);
  const { project, card } = board(db, "uuid-board");
  const { spawn } = fakeSpawn();
  const out = await wakeCardSession(db, project, card, { spawn, fetch: noPiWeb });
  assert.match(out.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(getCard(db, project.projectId, card.id).sessionId, out.sessionId);
});

test("spawn gets -p, the session id, a name and the board cwd", async (t) => {
  const db = memDb(t);
  const { project, card } = board(db, "args-board", { cwd: "/tmp/kb-args" });
  const { calls, spawn } = fakeSpawn();
  const out = await wakeCardSession(db, project, card, { spawn, fetch: noPiWeb });

  assert.equal(calls.length, 1);
  assert.equal(out.via, "pi");
  const { bin, args, opts } = calls[0];
  assert.equal(bin, "pi");
  assert.equal(args[0], "-p");
  assert.ok(args.includes("--session-id") && args.includes(out.sessionId), "--session-id <uuid>");
  assert.equal(args[args.indexOf("--name") + 1], "kanban #1");
  assert.equal(opts.cwd, "/tmp/kb-args");
  assert.deepEqual(opts.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(sessionCwd(project), "/tmp/kb-args");
  assert.equal(sessionCwd({ ...project, settings: {} }), process.cwd());
});

test("an existing card session is resumed with --session, not re-minted", async (t) => {
  const db = memDb(t);
  const { project } = board(db, "resume-board");
  const card = createCard(db, { projectId: project.projectId, columnId: "todo", title: "続きをやる" });
  const sid = "b7c1d2e3-1111-2222-3333-444455556666";
  const { updateCard } = repos;
  updateCard(db, project.projectId, card.id, { sessionId: sid }, { actor: "test" });
  const stored = getCard(db, project.projectId, card.id);
  const { calls, spawn } = fakeSpawn();
  const out = await wakeCardSession(db, project, stored, { spawn, fetch: noPiWeb });

  assert.equal(out.sessionId, sid, "the card's own session id is reused");
  const { args } = calls[0];
  assert.equal(args[args.indexOf("--session") + 1], sid);
  assert.equal(args.includes("--session-id"), false, "--session and --session-id cannot be combined");
  assert.equal(args.includes("--name"), false, "a resumed session keeps its existing name");
  assert.equal(getCard(db, project.projectId, card.id).sessionId, sid);
});

test("a second wake on the same board is refused while the child is alive", async (t) => {
  const db = memDb(t);
  const { project, card } = board(db, "busy-board");
  const { calls, spawn } = fakeSpawn();
  assert.notEqual(await wakeCardSession(db, project, card, { spawn, fetch: noPiWeb }), null);
  assert.equal(await wakeCardSession(db, project, card, { spawn, fetch: noPiWeb }), null);
  assert.equal(calls.length, 1, "no second process");
});

test("an existing card session is handed to pi-web and no process is spawned", async (t) => {
  const db = memDb(t);
  const { project, card } = board(db, "piweb-existing");
  const sid = "c1d2e3f4-1111-2222-3333-444455556666";
  repos.updateCard(db, project.projectId, card.id, { sessionId: sid }, { actor: "test" });
  const stored = getCard(db, project.projectId, card.id);
  const { calls: spawned, spawn } = fakeSpawn();
  const { calls, fetch } = fakePiWeb([], null);

  const out = await wakeCardSession(db, project, stored, { spawn, fetch });

  assert.equal(out.via, "pi-web");
  assert.equal(out.sessionId, sid, "pi-web resumed the card's own session");
  assert.equal(spawned.length, 0, "pi-web took it, so pi is not spawned");
  // pi-web forwards the body to the session as an RPC command: `prompt` is what starts a turn.
  const post = calls.find(c => c.url.endsWith(`/api/agent/${sid}`));
  assert.equal(post.body.type, "prompt");
  assert.equal(post.body.cwd, undefined, "an existing session keeps its own cwd");
  assert.ok(post.body.message.includes("カードを実装してください"));
});

test("a new card takes the session id pi-web minted and stores it", async (t) => {
  const db = memDb(t);
  const { project, card } = board(db, "piweb-new", { cwd: "/tmp/kb-piweb" });
  const { calls: spawned, spawn } = fakeSpawn();
  const minted = "9f8e7d6c-1111-2222-3333-444455556666";
  const { calls, fetch } = fakePiWeb([], minted);

  const out = await wakeCardSession(db, project, card, { spawn, fetch });

  assert.equal(out.via, "pi-web");
  assert.equal(out.sessionId, minted);
  assert.equal(spawned.length, 0);
  assert.equal(getCard(db, project.projectId, card.id).sessionId, minted, "the card remembers pi-web's id");
  const post = calls.find(c => c.url.endsWith("/api/agent/new"));
  assert.equal(post.body.type, "prompt");
  assert.equal(post.body.cwd, "/tmp/kb-piweb");
  assert.equal(post.body.sessionId, undefined, "pi-web mints the id; we do not pass one");
});

test("two concurrent wakes start one session, not two", async (t) => {
  const db = memDb(t);
  const { project, card } = board(db, "race-board");
  const { spawn } = fakeSpawn();
  const { calls, fetch } = fakePiWeb([], "piweb-race");

  const both = await Promise.all([
    wakeCardSession(db, project, card, { spawn, fetch }),
    wakeCardSession(db, project, card, { spawn, fetch }),
  ]);

  assert.equal(both.filter(x => x !== null).length, 1, "one caller wins, the other is refused");
  assert.equal(calls.filter(c => c.url.endsWith("/api/agent/new")).length, 1, "one session requested");
});
