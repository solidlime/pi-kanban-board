// W3 e2e: the v2 surface end to end — a temp home, a real init, a real HTTP server
// (in-process and as the `serve:v2` CLI process), and the wire contract behind it.
//
// Hard rules for this file:
//   - every home is `<mkdtemp>/.pi/kanban`; `~/.pi/kanban` is never read, never written
//   - ports are 0 (ephemeral) so a parallel suite cannot collide with 8789
//   - assertions are on the documented contract (docs/W0_DECISIONS.md, docs/W2_API.md),
//     not on incidental internals
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// A relative `./x.js` specifier must resolve to the sibling `./x.ts` for src/**; the
// integration suite already owns that hook, so this file reuses it instead of copying it.
import "../integration/_ts-hooks.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { detectState, executeInit, inspectInit, planInit, InitRefused } = await import("../../src/persistence/init.ts");
const { startServer } = await import("../../src/api/start.ts");
const { createColumn } = await import("../../src/persistence/repos.ts");

// --------------------------------------------------------------------- helpers

/** A sandbox whose kanban home is <sandbox>/.pi/kanban — the only shape init accepts.
 *  Cleanup is a callback, not a hook: the caller must close any server *before* removing
 *  the tree (win32 refuses to unlink an open sqlite file), so hook order is explicit. */
function sandbox(prefix = "kbv2-e2e-") {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  const home = path.join(root, ".pi", "kanban");
  const cleanup = () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  return { root, home, cleanup };
}

/** A believable v1 layout: no state.sqlite, but json + media the v1 board owned. */
function makeV1Home(home) {
  mkdirSync(path.join(home, "media", ".trash"), { recursive: true });
  writeFileSync(path.join(home, "board.json"), JSON.stringify({ cards: [{ id: 1, text: "legacy" }] }));
  writeFileSync(path.join(home, "media", "pic.bin"), Buffer.alloc(2048, 7));
  writeFileSync(path.join(home, "token"), "v1-token-not-a-v2-token\n");
}

/** In-process server on an ephemeral port, with a tiny fetch wrapper for the envelope.
 *  Registers its own teardown in the one order that works: close, then remove the tree. */
async function boot(t, { box, init = true } = {}) {
  const b = box ?? sandbox();
  if (init) executeInit(planInit(new Date(), b.home), { confirmed: true });
  const run = await startServer({ home: b.home, port: 0, host: "127.0.0.1" });
  t.after(() => run.close());
  t.after(b.cleanup);
  const base = run.url.replace(/\/$/, "");

  /** @returns {Promise<{status:number, json:any, text:string, headers:Headers}>} */
  async function call(method, p, body, opts = {}) {
    const token = "token" in opts ? opts.token : run.token;
    const headers = {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    };
    const res = await fetch(base + p, {
      method,
      headers,
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* static asset */ }
    return { status: res.status, json, text, headers: res.headers };
  }

  /** Unwraps `{ok:true,data}` and fails loudly on anything else, so a broken
   *  envelope can never be mistaken for a passing test. */
  async function data(method, p, body, opts) {
    const r = await call(method, p, body, opts);
    assert.equal(r.json?.ok, true, `${method} ${p} → ${r.status} ${r.text.slice(0, 300)}`);
    return { ...r, data: r.json.data };
  }

  return { run, base, home: b.home, call, data, token: run.token };
}

const code = (r) => r.json?.error?.code;

// ------------------------------------------------------------------ init flow

test("init: detect → plan → inspect → execute(backup) on a temp home", (t) => {
  const { root, home, cleanup } = sandbox();
  t.after(cleanup);

  // Detection is read-only: a missing home stays missing.
  const missing = detectState(home);
  assert.equal(missing.status, "missing");
  assert.equal(missing.initialized, false);
  assert.equal(existsSync(home), false, "detectState must not create the home");

  makeV1Home(home);
  const v1 = detectState(home);
  assert.equal(v1.status, "v1");
  assert.equal(v1.initialized, false);
  assert.ok(v1.v1Paths.some((p) => p.endsWith(".json")), "the v1 json files are reported");
  assert.ok(v1.v1Paths.some((p) => p.endsWith("media")), "the v1 media tree is reported");

  // Planning is pure: inspect and plan agree, nothing is created or moved.
  const when = new Date("2026-01-02T03:04:05.006Z");
  const plan = planInit(when, home);
  assert.equal(plan.backupDir, `${home}.v1.bak-2026-01-02T03-04-05-006Z`);
  const inspection = inspectInit(plan);
  assert.equal(inspection.homeExists, true);
  assert.equal(inspection.existing.length > 0, true);
  assert.ok(inspection.totalBytes >= 2048, `media size is counted (got ${inspection.totalBytes})`);
  assert.ok(inspection.existing.some((p) => p.name === "board.json" && p.kind === "file"));
  assert.ok(inspection.willCreate.some((p) => p.endsWith("state.sqlite")));
  assert.equal(existsSync(`${home}.v1.bak-2026-01-02T03-04-05-006Z`), false, "planning creates no backup");

  // The gate: no confirmation, no destruction.
  assert.throws(() => executeInit(plan, { confirmed: false }), /confirmation/i);
  assert.throws(() => executeInit(plan), /confirmation/i);
  assert.equal(detectState(home).status, "v1", "a refused init leaves the v1 home untouched");
  assert.equal(readFileSync(path.join(home, "board.json"), "utf8").includes("legacy"), true);

  // A home that is not <...>/.pi/kanban is refused before anything is moved.
  const wrong = path.join(root, "somewhere-else");
  mkdirSync(wrong, { recursive: true });
  assert.throws(
    () => executeInit(planInit(new Date(), wrong), { confirmed: true }),
    (err) => err instanceof InitRefused,
  );
  assert.equal(existsSync(path.join(wrong, "state.sqlite")), false);

  // Real run: the whole v1 home is moved aside, then the v2 layout is built.
  const res = executeInit(plan, { confirmed: true, mode: "backup" });
  assert.equal(res.home, home);
  assert.equal(res.mode, "backup");
  assert.equal(res.backupDir, plan.backupDir);
  assert.deepEqual(res.moved, [home]);
  assert.ok(res.schemaVersion >= 1);

  // v1 survives verbatim inside the backup (the whole point of backup mode).
  assert.equal(readFileSync(path.join(plan.backupDir, "board.json"), "utf8").includes("legacy"), true);
  assert.equal(readFileSync(path.join(plan.backupDir, "media", "pic.bin")).length, 2048);

  // v2 layout: token (0600 / private), db, media, log.
  const token = readFileSync(path.join(home, "token"), "utf8").trim();
  assert.match(token, /^[0-9a-f]{64}$/, "init replaces the v1 token with a fresh 256-bit one");
  assert.notEqual(token, "v1-token-not-a-v2-token");
  assert.ok(existsSync(path.join(home, "state.sqlite")));
  assert.ok(existsSync(path.join(home, "media", ".trash")));
  assert.ok(existsSync(path.join(home, "server.log")));
  // POSIX mode is only meaningful where chmod is: on win32 the token file is private by ACL.
  if (process.platform !== "win32") {
    assert.equal(statSync(path.join(home, "token")).mode & 0o077, 0, "token is not group/world readable");
  }

  const after = detectState(home);
  assert.equal(after.status, "v2");
  assert.equal(after.initialized, true);
  assert.equal(after.schemaVersion, res.schemaVersion);
});

test("init: backup refuses to overwrite an existing backup dir", (t) => {
  const { home, cleanup } = sandbox();
  t.after(cleanup);
  makeV1Home(home);
  const plan = planInit(new Date("2026-02-03T00:00:00.000Z"), home);
  executeInit(plan, { confirmed: true, mode: "backup" });
  // Re-running the same dated plan must not silently eat the previous backup.
  const again = planInit(new Date("2026-02-03T00:00:00.000Z"), home);
  assert.throws(() => executeInit(again, { confirmed: true, mode: "backup" }), (err) => err instanceof InitRefused);
  assert.ok(existsSync(path.join(plan.backupDir, "board.json")), "the first backup is still intact");
});

test("init: execute also accepts an uninitialized-but-present home (delete mode)", (t) => {
  const { home, cleanup } = sandbox();
  t.after(cleanup);
  makeV1Home(home);
  const plan = planInit(new Date(), home);
  const res = executeInit(plan, { confirmed: true, mode: "delete" });
  assert.equal(res.mode, "delete");
  assert.equal(res.backupDir, null);
  assert.ok(res.removed.length > 0, "delete mode reports what it removed");
  assert.deepEqual(res.moved, []);
  assert.equal(readFileSync(path.join(home, "token"), "utf8").trim().length, 64);
  assert.equal(detectState(home).initialized, true);
});

// ------------------------------------------------------------- process / CLI

test("serve:v2 CLI: boots on port 0, honours KANBAN_HOME, reports the build", async (t) => {
  const { home, cleanup } = sandbox();
  t.after(cleanup);
  const init = executeInit(planInit(new Date(), home), { confirmed: true });
  const child = spawn(process.execPath, ["src/api/serve.ts"], {
    cwd: repoRoot,
    env: { ...process.env, KANBAN_HOME: home, KANBAN_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });

  const exited = new Promise((resolve) => child.once("exit", (c, s) => resolve({ code: c, signal: s })));
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });

  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CLI never reported a url\nstdout:${out}\nstderr:${err}`)), 20000);
    const scan = () => {
      // Both banner lines, because the assertions below read the home line too.
      const m = /listening on (http:\/\/[^\s/]+)/.exec(out);
      if (m && /^\s{2}home\s+\S/m.test(out)) { clearTimeout(timer); resolve(m[1]); }
    };
    child.stdout.on("data", scan);
    child.once("exit", () => { clearTimeout(timer); reject(new Error(`CLI exited early\nstdout:${out}\nstderr:${err}`)); });
    scan();
  });

  // The printed url is the contract: ephemeral port, loopback host, temp home.
  const parsed = new URL(url);
  assert.equal(parsed.hostname, "127.0.0.1");
  assert.ok(Number(parsed.port) > 0, `expected an ephemeral port, got ${parsed.port}`);
  assert.match(out, new RegExp(`home\\s+${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.doesNotMatch(out, /warn\s+no token file/, "init wrote a token, so no warning is due");
  assert.equal(statSync(path.join(home, "token")).isFile(), true);

  const token = readFileSync(path.join(home, "token"), "utf8").trim();
  const auth = { authorization: `Bearer ${token}` };
  const meta = await (await fetch(`${url}/api/meta`, { headers: auth })).json();
  assert.equal(meta.ok, true);

  // The build hash the server reports is the one the build actually wrote.
  const built = JSON.parse(readFileSync(path.join(repoRoot, "web", "dist", "meta.json"), "utf8"));
  assert.equal(meta.data.buildHash, built.buildHash, "server build hash must match web/dist/meta.json");

  const st = await (await fetch(`${url}/api/selftest`, { headers: auth })).json();
  assert.equal(st.data.ok, true);
  assert.equal(st.data.db.ok, true);
  assert.equal(st.data.home.path, home);
  assert.equal(st.data.home.initialized, true);
  assert.equal(st.data.schemaVersion, init.schemaVersion);
  assert.equal(st.data.schema.ok, true);
  assert.equal(st.data.buildHash, meta.data.buildHash);

  child.kill("SIGTERM");
  const exit = await exited;
  // POSIX runs the SIGTERM handler and exits 0. On win32 there are no signals: kill() calls
  // TerminateProcess, so the handler never runs and the process dies by "signal" instead.
  if (process.platform === "win32") {
    assert.ok(exit.code === 0 || exit.signal === "SIGTERM", `unexpected exit ${JSON.stringify(exit)}`);
  } else {
    assert.equal(exit.code, 0, "SIGTERM is a clean shutdown");
  }
  // Whatever the path, the ephemeral port must be gone once the process is.
  await assert.rejects(() => fetch(`${url}/api/meta`, { headers: auth }), "the port is released on exit");
});

// ---------------------------------------------------------------------- auth

test("auth: cookie, bearer, 401 without a token, cross-origin writes refused", async (t) => {
  const s = await boot(t);
  const project = { slug: "auth", name: "Auth" };

  // No carrier → 401 with the envelope, not an HTML error page.
  const anon = await s.call("GET", "/api/meta", undefined, { token: null });
  assert.equal(anon.status, 401);
  assert.equal(code(anon), "UNAUTHORIZED");
  assert.match(anon.json.error.message, /token/i);

  // A wrong token is 401 even in the right shape.
  const wrong = await s.call("GET", "/api/meta", undefined, { token: "0".repeat(64) });
  assert.equal(wrong.status, 401);
  assert.equal(code(wrong), "UNAUTHORIZED");

  // Bearer works.
  const bearer = await s.call("GET", "/api/meta", undefined, { token: s.token });
  assert.equal(bearer.status, 200);
  assert.equal(bearer.json.ok, true);
  // ...and so does the cookie it hands out.
  const cookie = await s.call("GET", "/api/meta", undefined, { token: null, headers: { cookie: `kb_auth=${s.token}` } });
  assert.equal(cookie.status, 200);

  // `?token=` is a bootstrap carrier on GET / only: it sets the cookie and serves the shell.
  const boot0 = await s.call("GET", `/?token=${s.token}`, undefined, { token: null });
  assert.equal(boot0.status, 200);
  assert.match(boot0.text, /<html/i);
  const setCookie = boot0.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /kb_auth=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Path=\//);

  // A bad bootstrap token gets neither the shell nor a cookie.
  const badBoot = await s.call("GET", "/?token=nope", undefined, { token: null });
  assert.equal(badBoot.status, 401);
  assert.equal(badBoot.headers.get("set-cookie"), null);

  // Cross-origin writes are refused; the same origin is allowed.
  const evil = await s.call("POST", "/api/projects", project, { headers: { origin: "http://evil.example" } });
  assert.equal(evil.status, 403);
  assert.equal(code(evil), "FORBIDDEN");
  const crossSite = await s.call("POST", "/api/projects", project, { headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(crossSite.status, 403);
  const same = await s.call("POST", "/api/projects", project, { headers: { origin: s.base } });
  assert.equal(same.status, 201, "a same-origin write is not blocked by the origin guard");
});

// ------------------------------------------------------- project / board / card

test("projects + board: create, list, read, and the 404/422 edges", async (t) => {
  const s = await boot(t);

  const created = await s.data("POST", "/api/projects", { slug: "alpha", name: "Alpha" });
  assert.equal(created.status, 201);
  assert.equal(created.data.project.slug, "alpha");
  assert.equal(created.data.project.name, "Alpha");
  assert.deepEqual(created.data.columns.map((c) => c.id), ["todo", "doing", "done"]);

  const dup = await s.call("POST", "/api/projects", { slug: "alpha", name: "Again" });
  assert.equal(dup.status, 409);
  assert.equal(code(dup), "CONFLICT");

  const badSlug = await s.call("POST", "/api/projects", { slug: "Not A Slug" });
  assert.equal(badSlug.status, 422, "slug validation is a domain error, not a crash");

  await s.data("POST", "/api/projects", { slug: "beta", name: "Beta" });
  const list = await s.data("GET", "/api/projects");
  assert.deepEqual(list.data.projects.map((p) => p.slug).sort(), ["alpha", "beta"]);

  const board = await s.data("GET", "/api/board?project=alpha");
  assert.equal(board.data.project.projectId, "alpha");
  assert.deepEqual(board.data.columns.map((c) => c.id), ["todo", "doing", "done"]);
  assert.deepEqual(board.data.cards, []);

  // Boards are keyed by project: beta must not see alpha's cards.
  const other = await s.data("GET", "/api/board?project=beta");
  assert.deepEqual(other.data.cards, []);

  assert.equal((await s.call("GET", "/api/board?project=nope")).status, 404);
  assert.equal((await s.call("GET", "/api/board")).status, 400, "project is required, not optional");
});

test("cards: create/patch/move/delete with optimistic version (409 STALE_VERSION)", async (t) => {
  const s = await boot(t);
  await s.data("POST", "/api/projects", { slug: "flow", name: "Flow" });

  const add = await s.data("POST", "/api/cards", { project: "flow", title: "first" });
  assert.equal(add.status, 201);
  const card = add.data.card;
  assert.equal(card.id, 1);
  assert.equal(card.columnId, "todo", "an omitted column defaults to the leftmost todo column");
  assert.equal(card.version, 1);

  // Patch bumps the version and keeps the rest of the card intact.
  const patched = await s.data("PATCH", "/api/cards/flow/1", { version: 1, title: "renamed", priority: 3 });
  assert.equal(patched.data.card.title, "renamed");
  assert.equal(patched.data.card.priority, 3);
  assert.equal(patched.data.card.version, 2);

  // A stale version is 409 with the current one in the details.
  const stale = await s.call("PATCH", "/api/cards/flow/1", { version: 1, title: "stale" });
  assert.equal(stale.status, 409);
  assert.equal(code(stale), "STALE_VERSION");
  assert.equal(stale.json.error.details?.current, 2, "the 409 carries the version the client must reload");

  // A missing version is a request error, not a silent last-write-wins.
  const noVersion = await s.call("PATCH", "/api/cards/flow/1", { title: "no version" });
  assert.equal(noVersion.status, 422);

  const moved = await s.data("POST", "/api/cards/flow/1/move", { columnId: "doing", version: 2 });
  assert.equal(moved.data.card.columnId, "doing");
  assert.equal(moved.data.card.version, 3);
  assert.equal((await s.call("POST", "/api/cards/flow/1/move", { columnId: "doing", version: 2 })).status, 409);

  // Unknown column / unknown card / unknown project are 422 / 404 / 404.
  assert.equal((await s.call("POST", "/api/cards/flow/1/move", { columnId: "nope", version: 3 })).status, 422);
  assert.equal((await s.call("POST", "/api/cards/flow/99/move", { columnId: "done", version: 1 })).status, 404);
  assert.equal((await s.call("POST", "/api/cards", { project: "nope", title: "x" })).status, 404);
  assert.equal((await s.call("POST", "/api/cards", { project: "flow", title: "x", columnId: "nope" })).status, 422);
  assert.equal((await s.call("POST", "/api/cards", { project: "flow" })).status, 422, "title is required");

  // Deleting with a stale version is refused; the card is still there.
  const staleDelete = await s.call("DELETE", "/api/cards/flow/1", { version: 1 });
  assert.equal(staleDelete.status, 409);
  assert.equal(code(staleDelete), "STALE_VERSION");
  assert.equal((await s.data("GET", "/api/board?project=flow")).data.cards.length, 1);

  const del = await s.data("DELETE", "/api/cards/flow/1", { version: 3 });
  assert.deepEqual(del.data.deleted, { projectId: "flow", id: 1 });
  assert.deepEqual((await s.data("GET", "/api/board?project=flow")).data.cards, []);
  assert.equal((await s.call("DELETE", "/api/cards/flow/1", { version: 3 })).status, 404, "a second delete is 404");
});

test("malformed requests: bad JSON and non-object bodies are 400", async (t) => {
  const s = await boot(t);
  await s.data("POST", "/api/projects", { slug: "bad", name: "Bad" });
  const notJson = await s.call("POST", "/api/cards", "{not json");
  assert.equal(notJson.status, 400);
  assert.equal(code(notJson), "BAD_REQUEST");
  const arrayBody = await s.call("POST", "/api/cards", "[1,2,3]");
  assert.equal(arrayBody.status, 400);
});

test("WIP limits: a capped column refuses one card too many, on add and on move", async (t) => {
  const s = await boot(t);
  await s.data("POST", "/api/projects", { slug: "wip", name: "Wip" });
  createColumn(s.run.db, { projectId: "wip", id: "focus", name: "Focus", kind: "doing", ord: 4, wipLimit: 1 });

  assert.equal((await s.call("POST", "/api/cards", { project: "wip", title: "one", columnId: "focus" })).status, 201);
  const over = await s.call("POST", "/api/cards", { project: "wip", title: "two", columnId: "focus" });
  assert.equal(over.status, 409);
  assert.equal(code(over), "WIP_LIMIT");

  // The same cap applies to a move into the column...
  const mover = (await s.data("POST", "/api/cards", { project: "wip", title: "mover" })).data.card;
  const blocked = await s.call("POST", `/api/cards/wip/${mover.id}/move`, { columnId: "focus", version: mover.version });
  assert.equal(blocked.status, 409);
  assert.equal(code(blocked), "WIP_LIMIT");

  // ...but a card already inside the column may move to itself (it does not count twice).
  const inside = (await s.data("GET", "/api/board?project=wip")).data.cards.find((c) => c.columnId === "focus");
  const self = await s.call("POST", `/api/cards/wip/${inside.id}/move`, { columnId: "focus", version: inside.version });
  assert.equal(self.status, 200);
});

// ---------------------------------------------------------------- dependencies

test("dependencies: add/list/remove over HTTP, with duplicate, self and cycle refused", async (t) => {
  const s = await boot(t);
  await s.data("POST", "/api/projects", { slug: "dep", name: "Dep" });
  const mk = async (title) => (await s.data("POST", "/api/cards", { project: "dep", title })).data.card;

  const a = await mk("a");
  const b = await mk("b");
  const c = await mk("c");

  const added = await s.data("POST", "/api/dependencies", { project: "dep", fromCard: a.id, toCard: b.id });
  assert.equal(added.status, 201);
  assert.deepEqual(
    { from: added.data.dependency.fromCard, to: added.data.dependency.toCard, type: added.data.dependency.type },
    { from: a.id, to: b.id, type: "blocks" },
  );

  // b blocks c, so a → b → c is a valid DAG.
  await s.data("POST", "/api/dependencies", { project: "dep", fromCard: b.id, toCard: c.id });

  // An edge that closes the loop is refused with CYCLE, and nothing is written.
  const cycle = await s.call("POST", "/api/dependencies", { project: "dep", fromCard: c.id, toCard: a.id });
  assert.equal(cycle.status, 409);
  assert.equal(code(cycle), "CYCLE");
  assert.equal((await s.data("GET", "/api/dependencies?project=dep")).data.dependencies.length, 2);

  // Self edges and duplicates are refused too.
  const self = await s.call("POST", "/api/dependencies", { project: "dep", fromCard: a.id, toCard: a.id });
  assert.equal(self.status, 422);
  const dup = await s.call("POST", "/api/dependencies", { project: "dep", fromCard: a.id, toCard: b.id });
  assert.equal(dup.status, 409);
  assert.equal(code(dup), "CONFLICT");

  // "relates" is not part of the DAG: it may mirror an existing edge and never cycles.
  await s.data("POST", "/api/dependencies", { project: "dep", fromCard: a.id, toCard: b.id, type: "relates" });
  await s.data("POST", "/api/dependencies", { project: "dep", fromCard: b.id, toCard: a.id, type: "relates" });
  const all = (await s.data("GET", "/api/dependencies?project=dep")).data.dependencies;
  assert.equal(all.length, 4);

  // Per-card filtering lives in persistence (repos.listDependencies(cardId)); the HTTP route
  // lists the whole project, so that is what the wire contract promises here.
  const { listDependencies } = await import("../../src/persistence/repos.ts");
  const forA = listDependencies(s.run.db, "dep", a.id);
  assert.equal(forA.length, 3, "a card sees exactly the edges that touch it");
  assert.equal(forA.every((d) => d.fromCard === a.id || d.toCard === a.id), true);

  // Removal is exact (from, to, type) and a missing edge is 404.
  await s.data("DELETE", `/api/dependencies?project=dep&from=${a.id}&to=${b.id}`);
  assert.equal((await s.data("GET", "/api/dependencies?project=dep")).data.dependencies.length, 3);
  assert.equal((await s.call("DELETE", `/api/dependencies?project=dep&from=${a.id}&to=${b.id}`)).status, 404);

  // Deleting a card takes its edges with it instead of leaving dangling rows.
  await s.data("DELETE", `/api/cards/dep/${c.id}`);
  const left = (await s.data("GET", "/api/dependencies?project=dep")).data.dependencies;
  assert.equal(left.every((d) => d.fromCard !== c.id && d.toCard !== c.id), true, "no edge survives its card");
});

// --------------------------------------------------------------------- timeline

test("timeline: every write lands as an event, in order, with since/limit", async (t) => {
  const s = await boot(t);
  await s.data("POST", "/api/projects", { slug: "tl", name: "Timeline" });
  const card = (await s.data("POST", "/api/cards", { project: "tl", title: "one" })).data.card;
  const patched = (await s.data("PATCH", "/api/cards/tl/1", { version: card.version, title: "two" })).data.card;
  await s.data("POST", "/api/cards/tl/1/move", { columnId: "done", version: patched.version });

  const events = (await s.data("GET", "/api/timeline?project=tl")).data.events;
  assert.ok(events.length >= 4, `project + card events are recorded (got ${events.length})`);
  assert.deepEqual(
    events.filter((e) => e.entityType === "card" && e.kind !== "card.deleted").map((e) => e.kind),
    ["card.created", "card.updated", "card.moved"],
  );

  // Sequence is strictly ascending within a project, which is what a UI poll relies on.
  const seqs = events.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y));
  assert.equal(new Set(seqs).size, seqs.length);

  const since = events[1].seq;
  const tail = (await s.data("GET", `/api/timeline?project=tl&since=${since}`)).data.events;
  assert.equal(tail.every((e) => e.seq > since), true);

  const limited = (await s.data("GET", "/api/timeline?project=tl&limit=2")).data.events;
  assert.equal(limited.length, 2);
  assert.equal((await s.call("GET", "/api/timeline?project=tl&limit=abc")).status, 400);
  assert.equal((await s.call("GET", "/api/timeline?project=nope")).status, 404);
});

// ------------------------------------------------------------------ uninitialized

test("uninitialized home: diagnostics answer, writes name the init and refuse", async (t) => {
  const s = await boot(t, { init: false });
  assert.equal(s.run.db, null, "an uninitialized home must not be opened");

  const meta = await s.call("GET", "/api/meta", undefined, { token: null });
  assert.equal(meta.status, 200, "diagnostics stay open so the UI can say 'run init'");
  assert.equal(meta.json.data.schemaVersion, 0);

  const st = await s.call("GET", "/api/selftest", undefined, { token: null });
  assert.equal(st.status, 200);
  assert.equal(st.json.data.ok, false);
  assert.equal(st.json.data.home.initialized, false);
  assert.equal(st.json.data.schema.ok, false, "an uninitialized home cannot match the schema");
  assert.match(st.json.data.db.error, /not initialized/i);

  const write = await s.call("POST", "/api/projects", { slug: "x" }, { token: null });
  assert.equal(write.status, 401);
  assert.match(write.json.error.message, /init/);
  assert.match(write.json.error.message, /confirm/i, "the refusal must ask for explicit confirmation");
  assert.equal(existsSync(path.join(s.home, "state.sqlite")), false, "a refused write initializes nothing");
});

// ---------------------------------------------------------------- selftest shape

test("selftest: reports db, schema, home, build and capabilities", async (t) => {
  const s = await boot(t);
  const st = (await s.data("GET", "/api/selftest")).data;
  assert.equal(st.ok, true);
  assert.equal(st.db.ok, true);
  assert.equal(st.db.error, null);
  assert.equal(st.db.integrity, "ok", "the db reports a real integrity check, not just SELECT 1");
  assert.ok(st.schemaVersion >= 1);
  // The invariant, not a literal: what the db reports is what this build expects.
  assert.deepEqual(st.schema, { version: st.schemaVersion, expected: st.schemaVersion, ok: true });
  assert.equal(st.home.path, s.home);
  assert.equal(st.home.status, "v2");
  assert.match(st.version, /^\d+\.\d+\.\d+/, "an api version is reported");
  assert.match(st.buildHash, /^[0-9a-f]{6,}$/);
  for (const cap of ["meta", "selftest", "projects", "board", "timeline", "cards", "card.move", "card.delete"]) {
    assert.ok(st.capabilities.includes(cap), `capabilities advertise ${cap}`);
  }

  // meta and selftest must not disagree about the build or the schema.
  const meta = (await s.data("GET", "/api/meta")).data;
  assert.equal(meta.buildHash, st.buildHash);
  assert.equal(meta.schemaVersion, st.schemaVersion);
});
