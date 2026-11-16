// Waking a card: prompt shape, session id persistence, spawn arguments, and one child per
// board. A memory DB plus a fake spawn — no real `pi` process is ever started here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import "./_load.mjs";

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

test("wakeCardSession mints a UUID session id and stores it on the card", (t) => {
  const db = memDb(t);
  const { project, card } = board(db, "uuid-board");
  const { spawn } = fakeSpawn();
  const out = wakeCardSession(db, project, card, { spawn });
  assert.match(out.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(getCard(db, project.projectId, card.id).sessionId, out.sessionId);
});

test("spawn gets -p, the session id, a name and the board cwd", (t) => {
  const db = memDb(t);
  const { project, card } = board(db, "args-board", { cwd: "/tmp/kb-args" });
  const { calls, spawn } = fakeSpawn();
  const out = wakeCardSession(db, project, card, { spawn });

  assert.equal(calls.length, 1);
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

test("an existing card session is resumed with --session, not re-minted", (t) => {
  const db = memDb(t);
  const { project } = board(db, "resume-board");
  const card = createCard(db, { projectId: project.projectId, columnId: "todo", title: "続きをやる" });
  const sid = "b7c1d2e3-1111-2222-3333-444455556666";
  const { updateCard } = repos;
  updateCard(db, project.projectId, card.id, { sessionId: sid }, { actor: "test" });
  const stored = getCard(db, project.projectId, card.id);
  const { calls, spawn } = fakeSpawn();
  const out = wakeCardSession(db, project, stored, { spawn });

  assert.equal(out.sessionId, sid, "the card's own session id is reused");
  const { args } = calls[0];
  assert.equal(args[args.indexOf("--session") + 1], sid);
  assert.equal(args.includes("--session-id"), false, "--session and --session-id cannot be combined");
  assert.equal(args.includes("--name"), false, "a resumed session keeps its existing name");
  assert.equal(getCard(db, project.projectId, card.id).sessionId, sid);
});

test("a second wake on the same board is refused while the child is alive", (t) => {
  const db = memDb(t);
  const { project, card } = board(db, "busy-board");
  const { calls, spawn } = fakeSpawn();
  assert.notEqual(wakeCardSession(db, project, card, { spawn }), null);
  assert.equal(wakeCardSession(db, project, card, { spawn }), null);
  assert.equal(calls.length, 1, "no second process");
});
