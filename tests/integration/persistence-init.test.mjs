// Integration: v2 home initialization. Every case runs in a temp fake home
// (`<tmp>/.pi/kanban`), never ~/.pi/kanban — the destructiveness is the point of the test,
// so the target must be a tree this test owns.
import "./_ts-hooks.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

const P = await import("../../src/persistence/index.ts");

const isWin = process.platform === "win32";

/** A temp sandbox whose kanban home is <sandbox>/.pi/kanban (the shape init insists on). */
function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), "kbv2-init-"));
  const home = join(root, ".pi", "kanban");
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return { root, home };
}

/** A believable v1 layout: db, json files, media tree, token. */
function makeV1Home(home) {
  mkdirSync(join(home, "media", ".trash"), { recursive: true });
  mkdirSync(join(home, "projects"), { recursive: true });
  writeFileSync(join(home, "boards.sqlite"), "v1-db-contents");
  writeFileSync(join(home, "global.json"), "{}");
  writeFileSync(join(home, "board.json"), "[]");
  writeFileSync(join(home, "token"), "v1token");
  writeFileSync(join(home, "media", "shot.png"), "png-bytes");
  writeFileSync(join(home, "projects", "alpha.json"), "{}");
}

const fixedNow = new Date("2026-01-02T03:04:05.000Z");
const expectedStamp = "2026-01-02T03-04-05-000Z";

test("planInit: paths stay inside the home, backup name is timestamped", (t) => {
  const { root, home } = sandbox(t);

  // the default home is the real one, but planInit touches nothing
  assert.equal(P.planInit().home, join(P.kanbanHome()));
  assert.ok(P.kanbanHome().endsWith(join(".pi", "kanban")));

  const plan = P.planInit(fixedNow, home);
  assert.equal(plan.home, home);
  assert.equal(plan.backupDir, `${home}.v1.bak-${expectedStamp}`);
  assert.equal(plan.targets.length, P.MANAGED_CONTENTS.length);
  for (const target of plan.targets) assert.ok(target.startsWith(home + sep), `stray target ${target}`);
  for (const created of plan.willCreate) assert.ok(created.startsWith(home), `stray create ${created}`);
  // planning is read-only
  assert.equal(existsSync(home), false);
  assert.equal(existsSync(plan.backupDir), false);
  assert.ok(root.length > 0);
});

test("inspectInit: reports what actually exists, with kind and size", (t) => {
  const { home } = sandbox(t);

  const emptyPlan = P.planInit(fixedNow, home);
  const before = P.inspectInit(emptyPlan);
  assert.equal(before.homeExists, false);
  assert.equal(before.existing.length, 0);
  assert.equal(before.totalBytes, 0);
  assert.equal(before.targets.every(t2 => t2.kind === "missing" && !t2.exists), true);

  makeV1Home(home);
  const after = P.inspectInit(P.planInit(fixedNow, home));
  assert.equal(after.homeExists, true);
  const names = after.existing.map(p => p.name);
  for (const expected of ["boards.sqlite", "global.json", "board.json", "token", "media", "projects"]) {
    assert.ok(names.includes(expected), `inspect missed ${expected}`);
  }
  const media = after.existing.find(p => p.name === "media");
  assert.equal(media.kind, "dir");
  assert.equal(media.size, "png-bytes".length, "dir size counts its children");
  const db = after.existing.find(p => p.name === "boards.sqlite");
  assert.equal(db.kind, "file");
  assert.equal(db.size, "v1-db-contents".length);
  assert.ok(after.totalBytes >= media.size + db.size);
  // a v2-only name is not in v1's report
  assert.equal(after.existing.some(p => p.name === "state.sqlite"), false);
});

test("executeInit refuses without confirmed:true and changes nothing", (t) => {
  const { home } = sandbox(t);
  makeV1Home(home);
  const plan = P.planInit(fixedNow, home);

  assert.throws(() => P.executeInit(plan, { mode: "backup" }), /explicit confirmation/);
  assert.throws(() => P.executeInit(plan, { confirmed: false, mode: "delete" }), /explicit confirmation/);
  assert.throws(() => P.executeInit(plan, { confirmed: "true", mode: "backup" }), /explicit confirmation/);
  assert.throws(() => P.executeInit(plan, { confirmed: true, mode: "nuke" }), /unknown init mode/);

  // the v1 tree is untouched and no v2 artifact appeared
  assert.equal(readFileSync(join(home, "boards.sqlite"), "utf8"), "v1-db-contents");
  assert.equal(existsSync(join(home, "state.sqlite")), false);
  assert.equal(existsSync(plan.backupDir), false);
});

test("executeInit backup mode moves the whole home and recreates a working v2 one", (t) => {
  const { home } = sandbox(t);
  makeV1Home(home);
  const plan = P.planInit(fixedNow, home);

  const result = P.executeInit(plan, { confirmed: true, mode: "backup" });
  assert.equal(result.mode, "backup");
  assert.equal(result.backupDir, plan.backupDir);
  assert.deepEqual(result.moved, [home]);
  assert.deepEqual(result.removed, []);
  assert.equal(result.schemaVersion, P.LATEST_SCHEMA_VERSION);

  // the v1 data survived, verbatim, in the backup
  for (const name of ["boards.sqlite", "global.json", "board.json", "token", "projects/alpha.json", "media/shot.png"]) {
    assert.equal(existsSync(join(plan.backupDir, name)), true, `backup lost ${name}`);
  }
  assert.equal(readFileSync(join(plan.backupDir, "boards.sqlite"), "utf8"), "v1-db-contents");

  // and the new home is a clean v2 layout
  assert.equal(existsSync(join(home, "boards.sqlite")), false, "v1 db must not be left in place");
  assert.equal(existsSync(join(home, "state.sqlite")), true);
  assert.equal(existsSync(join(home, "media", ".trash")), true);
  assert.equal(existsSync(join(home, "server.log")), true);
  assert.equal(existsSync(join(home, "token")), true);

  const token = readFileSync(join(home, "token"), "utf8");
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(P.readToken(home), token);
  if (!isWin) {
    assert.equal(statSync(join(home, "token")).mode & 0o777, 0o600, "token must be 0600");
    assert.equal(statSync(home).mode & 0o777, 0o700, "home must be 0700");
  }

  // the new db is migrated and usable
  const state = P.detectState(home);
  assert.equal(state.status, "v2");
  assert.equal(state.initialized, true);
  assert.equal(state.schemaVersion, P.LATEST_SCHEMA_VERSION);

  const opened = P.openHomeDatabase(home);
  try {
    const project = P.createProject(opened.db, { slug: "alpha" });
    assert.equal(project.slug, "alpha");
    assert.equal(P.listColumns(opened.db, "alpha").length, 3);
  } finally {
    P.closeDb(opened.db);
  }

  // re-running on a real backup target refuses instead of clobbering it
  assert.throws(() => P.executeInit(plan, { confirmed: true, mode: "backup" }), /backup target already exists/);
});

test("executeInit delete mode removes the targets in place and recreates", (t) => {
  const { root, home } = sandbox(t);
  makeV1Home(home);
  writeFileSync(join(home, "inbox-seen.json"), "{}");
  const plan = P.planInit(fixedNow, home);

  const result = P.executeInit(plan, { confirmed: true, mode: "delete" });
  assert.equal(result.mode, "delete");
  assert.equal(result.backupDir, null);
  assert.deepEqual(result.moved, []);
  assert.ok(result.removed.length >= 6, `expected removals, got ${result.removed.length}`);
  for (const p of result.removed) assert.ok(p.startsWith(home), `removed outside the home: ${p}`);
  assert.ok(result.removed.includes(join(home, "boards.sqlite")));
  assert.ok(result.removed.includes(join(home, "projects")));

  for (const name of ["boards.sqlite", "global.json", "board.json", "projects", "inbox-seen.json", "media/shot.png"]) {
    assert.equal(existsSync(join(home, name)), false, `${name} survived delete mode`);
  }
  assert.equal(existsSync(home), true);
  assert.equal(existsSync(join(home, "state.sqlite")), true);
  assert.equal(existsSync(join(home, "media", ".trash")), true);
  assert.match(readFileSync(join(home, "token"), "utf8"), /^[0-9a-f]{64}$/);
  assert.equal(P.detectState(home).status, "v2");
  // nothing escaped the sandbox
  assert.equal(existsSync(join(root, "kanban.v1.bak")), false);
});

test("init refuses a path that is not a .pi/kanban home", (t) => {
  const { root, home } = sandbox(t);
  makeV1Home(home);

  assert.throws(() => P.executeInit(P.planInit(fixedNow, tmpdir()), { confirmed: true, mode: "delete" }), /refusing to init/);
  assert.throws(() => P.executeInit(P.planInit(fixedNow, root), { confirmed: true, mode: "delete" }), /refusing to init/);
  assert.throws(() => P.executeInit(P.planInit(fixedNow, join(root, ".pi", "notkanban")), { confirmed: true, mode: "backup" }), /refusing to init/);

  // the near-miss path is untouched
  mkdirSync(join(root, ".pi", "notkanban"), { recursive: true });
  assert.equal(existsSync(join(home, "boards.sqlite")), true);
});

test("detectState / ensureInitialized classify without ever destroying", (t) => {
  const { home } = sandbox(t);

  // missing
  let state = P.detectState(home);
  assert.deepEqual([state.status, state.initialized], ["missing", false]);

  // empty
  mkdirSync(home, { recursive: true });
  state = P.detectState(home);
  assert.deepEqual([state.status, state.initialized], ["empty", false]);

  // v1
  makeV1Home(home);
  state = P.detectState(home);
  assert.deepEqual([state.status, state.initialized], ["v1", false]);
  assert.ok(state.v1Paths.includes(join(home, "boards.sqlite")));

  let ensure = P.ensureInitialized(home, fixedNow);
  assert.equal(ensure.initialized, false);
  assert.match(ensure.reason, /v1/);
  assert.equal(ensure.plan.home, home);
  assert.equal(ensure.plan.backupDir, `${home}.v1.bak-${expectedStamp}`);
  // the refusal path is a read
  assert.equal(existsSync(join(home, "boards.sqlite")), true);
  assert.equal(existsSync(join(home, "state.sqlite")), false);

  // opening an uninitialized home throws instead of initializing it
  assert.throws(() => P.openHomeDatabase(home), /not initialized/);
  assert.equal(existsSync(join(home, "state.sqlite")), false);

  // v2 after a confirmed init
  P.executeInit(P.planInit(fixedNow, home), { confirmed: true, mode: "backup" });
  state = P.detectState(home);
  assert.deepEqual([state.status, state.initialized, state.schemaVersion], ["v2", true, P.LATEST_SCHEMA_VERSION]);
  ensure = P.ensureInitialized(home, fixedNow);
  assert.equal(ensure.initialized, true);
  assert.equal(ensure.plan, undefined);

  const opened = P.openHomeDatabase(home);
  P.closeDb(opened.db);
  assert.equal(opened.schemaVersion, P.LATEST_SCHEMA_VERSION);
});

test("a half-written home (state.sqlite without kv_meta) counts as v1, not v2", (t) => {
  const { home } = sandbox(t);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "state.sqlite"), "not a database");
  const state = P.detectState(home);
  assert.equal(state.status, "v1");
  assert.equal(state.initialized, false);
});

test("detectState: token, server.log and stray files are not v1 data", (t) => {
  const { home } = sandbox(t);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "token"), "deadbeef");
  writeFileSync(join(home, "server.log"), "");
  writeFileSync(join(home, ".DS_Store"), "junk");
  const state = P.detectState(home);
  // v2 writes token/server.log too, so treating them as v1 data made a fresh machine demand a
  // confirmation it had no reason to. Only board data counts.
  assert.deepEqual([state.status, state.initialized, state.v1Paths.length], ["empty", false, 0]);
});

test("initHomeIfNeeded: a v1 home is migrated on boot, whole home kept in a backup", (t) => {
  const { home } = sandbox(t);
  makeV1Home(home);
  const init = P.initHomeIfNeeded(home, fixedNow);
  assert.ok(init, "a v1 home is initialized without asking");
  assert.equal(init.mode, "backup", "never delete: the old home is moved, not removed");
  assert.equal(init.backupDir, `${home}.v1.bak-${expectedStamp}`);
  assert.equal(existsSync(join(init.backupDir, "boards.sqlite")), true);
  assert.equal(existsSync(join(init.backupDir, "media", "shot.png")), true);
  const state = P.detectState(home);
  assert.deepEqual([state.status, state.initialized], ["v2", true]);
  assert.equal(P.initHomeIfNeeded(home, fixedNow), null, "already v2: nothing to do");
});
