// W2 API integration: real server, temp home, temp DB. No ~/.pi/kanban is touched.
// Every assertion is over HTTP because the point of W2 is the wire contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import "./_ts-hooks.mjs";
const { executeInit, planInit } = await import("../../src/persistence/init.ts");
const { createColumn } = await import("../../src/persistence/repos.ts");
const { startServer } = await import("../../src/api/start.ts");

async function tempHome(prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  return path.join(dir, ".pi", "kanban");
}

async function initializedServer(t) {
  const home = await tempHome("kb-api-");
  await executeInit(planInit(new Date(), home), { confirmed: true });
  const run = await startServer({ home, port: 0 });
  t.after(() => run.close());
  const base = run.url.replace(/\/$/, "");
  const call = async (method, p, body, token = run.token) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  return { run, base, call };
}

test("auth: token gate on the API and the shell", async (t) => {
  const { run, base, call } = await initializedServer(t);

  const bare = await call("GET", "/api/meta", null, null);
  assert.equal(bare.status, 401);
  assert.equal(bare.json.ok, false);
  assert.equal(bare.json.error.code, "UNAUTHORIZED");

  assert.equal((await call("GET", "/api/meta", null, "wrong")).status, 401);
  assert.equal((await call("GET", "/api/meta")).status, 200);
  assert.equal((await call("GET", "/", null, null)).status, 401, "the shell is behind the token too");

  // ?token= bootstraps a cookie on GET / only.
  const boot = await call("GET", `/?token=${run.token}`, null, null);
  assert.equal(boot.status, 200);
  assert.match(boot.text, /<html/i);
  const cookie = boot.headers.get("set-cookie") ?? "";
  assert.match(cookie, /kb_auth=/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=\d+/);

  // A bad query token is not a bootstrap: it must not hand out the shell or a cookie.
  const bad = await fetch(`${run.url}?token=nope`);
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get("set-cookie"), null);

  // The cookie alone authenticates.
  const viaCookie = await fetch(`${base}/api/meta`, { headers: { cookie: `kb_auth=${run.token}` } });
  assert.equal(viaCookie.status, 200);

  // ?token= is a bootstrap carrier on GET / only. Anywhere else it is not a credential, or the
  // token ends up in history, Referer headers and proxy logs for nothing.
  const queryApi = await fetch(`${base}/api/meta?token=${run.token}`);
  assert.equal(queryApi.status, 401, "query token must not authenticate an /api path");
  const queryShell = await fetch(`${base}/?token=${run.token}`);
  assert.equal(queryShell.status, 200, "GET / is the one place a query token still works");
  assert.ok(queryShell.headers.get("set-cookie")?.includes("kb_auth="), "and it becomes the cookie");
});

test("meta + selftest report build, schema and home state", async (t) => {
  const { call, run } = await initializedServer(t);
  const meta = (await call("GET", "/api/meta")).json.data;
  assert.equal(meta.version, "2.0.0-dev");
  assert.equal(meta.buildHash, run.buildHash);
  assert.equal(meta.schemaVersion, 2);
  assert.ok(meta.capabilities.includes("card.move"));

  const st = (await call("GET", "/api/selftest")).json.data;
  assert.equal(st.ok, true);
  assert.equal(st.db.ok, true);
  assert.equal(st.db.error, null);
  assert.equal(st.home.initialized, true);
  assert.equal(st.home.path, run.home);
});

test("vertical slice: project -> board -> card add/patch/move/delete", async (t) => {
  const { call, run } = await initializedServer(t);

  const created = await call("POST", "/api/projects", { slug: "smoke", name: "Smoke" });
  assert.equal(created.status, 201);
  assert.deepEqual(created.json.data.columns.map((c) => c.id), ["todo", "doing", "done"]);
  assert.equal((await call("POST", "/api/projects", { slug: "smoke" })).status, 409);

  // The shell posts only a name: the slug is derived from it.
  const named = await call("POST", "/api/projects", { name: "My Board 2" });
  assert.equal(named.status, 201);
  assert.equal(named.json.data.project.slug, "my-board-2");
  assert.equal((await call("POST", "/api/projects", {})).status, 422, "needs a slug or a name");

  const projects = (await call("GET", "/api/projects")).json.data.projects;
  assert.deepEqual(projects.map((p) => p.projectId).sort(), ["my-board-2", "smoke"]);

  const board = (await call("GET", "/api/board?project=smoke")).json.data;
  assert.equal(board.project.projectId, "smoke");
  assert.deepEqual(board.columns.map((c) => c.id), ["todo", "doing", "done"]);
  assert.deepEqual(board.cards, []);
  assert.equal((await call("GET", "/api/board?project=nope")).status, 404);

  const add = await call("POST", "/api/cards", { project: "smoke", title: "first" });
  assert.equal(add.status, 201);
  const card = add.json.data.card;
  assert.equal(card.id, 1);
  assert.equal(card.columnId, "todo", "defaults to the leftmost todo column");
  assert.equal(card.version, 1);

  // unknown project/column are 404 / 422, not 500
  assert.equal((await call("POST", "/api/cards", { project: "nope", title: "x" })).status, 404);
  assert.equal((await call("POST", "/api/cards", { project: "smoke", title: "x", columnId: "nope" })).status, 422);
  assert.equal((await call("POST", "/api/cards", { project: "smoke" })).status, 422, "title is required");

  const patched = await call("PATCH", "/api/cards/smoke/1", { version: 1, title: "renamed", priority: 5 });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.data.card.title, "renamed");
  assert.equal(patched.json.data.card.version, 2);

  const stale = await call("PATCH", "/api/cards/smoke/1", { version: 1, title: "stale" });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error.code, "STALE_VERSION");

  const moved = await call("POST", "/api/cards/smoke/1/move", { columnId: "doing", version: 2 });
  assert.equal(moved.status, 200);
  assert.equal(moved.json.data.card.columnId, "doing");
  assert.equal(moved.json.data.card.version, 3);
  assert.equal((await call("POST", "/api/cards/smoke/1/move", { columnId: "doing", version: 2 })).status, 409);
  assert.equal((await call("POST", "/api/cards/smoke/1/move", { columnId: "nope", version: 3 })).status, 422);

  // timeline: add + patch + move all landed as events
  const tl = (await call("GET", "/api/timeline?project=smoke")).json.data.events;
  assert.deepEqual(tl.filter((e) => e.entityType === "card").map((e) => e.kind), ["card.created", "card.updated", "card.moved"]);

  const del = await call("DELETE", "/api/cards/smoke/1", { version: 3 });
  assert.equal(del.status, 200);
  assert.deepEqual(del.json.data.deleted, { projectId: "smoke", id: 1 });
  assert.equal((await call("PATCH", "/api/cards/smoke/1", { version: 1, title: "ghost" })).status, 404);

  // WIP is a core rule: a capped column refuses one card too many, on add and on move.
  createColumn(run.db, { projectId: "smoke", id: "wip", name: "WIP", kind: "doing", ord: 4, wipLimit: 1 });
  assert.equal((await call("POST", "/api/cards", { project: "smoke", title: "w1", columnId: "wip" })).status, 201);
  const over = await call("POST", "/api/cards", { project: "smoke", title: "w2", columnId: "wip" });
  assert.equal(over.status, 409);
  assert.equal(over.json.error.code, "WIP_LIMIT");
  const mover = (await call("POST", "/api/cards", { project: "smoke", title: "mv" })).json.data.card;
  const blocked = await call("POST", `/api/cards/smoke/${mover.id}/move`, { columnId: "wip", version: mover.version });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.error.code, "WIP_LIMIT");
});

test("static: shell, assets, mime, and no traversal", async (t) => {
  const { call, base, run } = await initializedServer(t);
  const html = await call("GET", "/index.html");
  assert.equal(html.status, 200);
  assert.match(html.headers.get("content-type"), /text\/html/);
  assert.equal(html.headers.get("cache-control"), "no-store");

  const js = await call("GET", "/app.js");
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type"), /javascript/);

  assert.equal((await call("GET", "/nope.js")).status, 404);
  // The check runs after auth, so send the token to prove the path guard, not the auth guard, answers.
  const auth = { headers: { authorization: `Bearer ${run.token}` } };
  for (const p of ["/../package.json", "/%2e%2e/package.json", "/..%2fpackage.json"]) {
    const res = await fetch(base + p, auth);
    assert.equal(res.status, 404, `${p} must not escape the web root`);
    assert.doesNotMatch(await res.text(), /"name":\s*"pi-kanban-board"/);
  }
});

test("uninitialized home: diagnostics answer, writes name the init", async (t) => {
  const home = await tempHome("kb-api-empty-");
  const run = await startServer({ home, port: 0 });
  t.after(() => run.close());
  assert.equal(run.db, null, "an uninitialized home must not be opened");

  const meta = await fetch(`${run.url}api/meta`);
  assert.equal(meta.status, 200);
  const metaJson = await meta.json();
  assert.equal(metaJson.data.schemaVersion, 0);

  const st = await fetch(`${run.url}api/selftest`);
  const stJson = await st.json();
  assert.equal(st.status, 200);
  assert.equal(stJson.data.ok, false, "selftest reports the uninitialized home");

  const write = await fetch(`${run.url}api/projects`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: "x" }),
  });
  const wj = await write.json();
  assert.equal(write.status, 401);
  assert.match(wj.error.message, /init/, "the refusal must tell the user to run init");
  assert.match(wj.error.message, /confirm/i);
  assert.equal((await fetch(`${run.url}api/meta`)).status, 200, "diagnostics stay readable");
});

test("dependencies: project-scoped edges, cycle/duplicate/self guards, snapshot carries them", async (t) => {
  const { call } = await initializedServer(t);
  for (const slug of ["graph", "other"]) await call("POST", "/api/projects", { slug });
  const mk = async (project, title) => (await call("POST", "/api/cards", { project, title })).json.data.card;
  const a = await mk("graph", "a");
  const b = await mk("graph", "b");
  const c = await mk("graph", "c");
  // Same numeric id in another project: ids are project-local and must never resolve across.
  const foreign = await mk("other", "foreign");
  assert.equal(foreign.id, a.id);

  const add = await call("POST", "/api/dependencies", { project: "graph", fromCard: a.id, toCard: b.id });
  assert.equal(add.status, 201);
  assert.deepEqual(add.json.data.dependency, { projectId: "graph", fromCard: a.id, toCard: b.id, type: "blocks" });

  const relates = await call("POST", "/api/dependencies", { project: "graph", fromCard: b.id, toCard: a.id, type: "relates" });
  assert.equal(relates.status, 201, "relates is not part of the blocking graph, so a mutual edge is fine");

  const listed = (await call("GET", "/api/dependencies?project=graph")).json.data.dependencies;
  assert.equal(listed.length, 2);
  const board = (await call("GET", "/api/board?project=graph")).json.data;
  assert.equal(board.dependencies.length, 2, "the board snapshot must carry the edges the UI badges");

  const dup = await call("POST", "/api/dependencies", { project: "graph", fromCard: a.id, toCard: b.id });
  assert.equal(dup.status, 409);
  const self = await call("POST", "/api/dependencies", { project: "graph", fromCard: a.id, toCard: a.id });
  assert.equal(self.status, 422);
  assert.equal(self.json.error.code, "VALIDATION");
  const cyc = await call("POST", "/api/dependencies", { project: "graph", fromCard: b.id, toCard: a.id });
  assert.equal(cyc.status, 409);
  assert.equal(cyc.json.error.code, "CYCLE");
  // A chain a->b->c then c->a is still a cycle.
  assert.equal((await call("POST", "/api/dependencies", { project: "graph", fromCard: b.id, toCard: c.id })).status, 201);
  assert.equal((await call("POST", "/api/dependencies", { project: "graph", fromCard: c.id, toCard: a.id })).status, 409);

  // Cross-project: card `a.id` exists in `other` too, but the call names `graph`.
  const cross = await call("POST", "/api/dependencies", { project: "other", fromCard: a.id + 99, toCard: b.id });
  assert.equal(cross.status, 404);

  const rm = await call("DELETE", `/api/dependencies?project=graph&from=${a.id}&to=${b.id}`);
  assert.equal(rm.status, 200);
  assert.deepEqual(rm.json.data.removed, { projectId: "graph", fromCard: a.id, toCard: b.id, type: "blocks" });
  assert.equal((await call("GET", "/api/dependencies?project=graph")).json.data.dependencies.length, 2);
  assert.equal((await call("DELETE", `/api/dependencies?project=graph&from=${a.id}&to=${b.id}`)).status, 404);

  const tl = (await call("GET", "/api/timeline?project=graph")).json.data.events;
  assert.ok(tl.some((e) => e.kind === "dependency.added" && e.entityType === "dependency"));
  assert.ok(tl.some((e) => e.kind === "dependency.removed"));
});

test("deliverables: create/link/list/filter/delete inside one project", async (t) => {
  const { call } = await initializedServer(t);
  await call("POST", "/api/projects", { slug: "deliv" });
  const card = (await call("POST", "/api/cards", { project: "deliv", title: "has output" })).json.data.card;

  const made = await call("POST", "/api/deliverables", { project: "deliv", title: "build log", kind: "log", cardId: card.id });
  assert.equal(made.status, 201);
  const d = made.json.data.deliverable;
  assert.equal(d.title, "build log");
  assert.equal(d.kind, "log");
  assert.equal(d.cardId, card.id);
  assert.equal(d.projectId, "deliv");

  const loose = await call("POST", "/api/deliverables", { project: "deliv", title: "project-wide note" });
  assert.equal(loose.status, 201);
  assert.equal(loose.json.data.deliverable.cardId, null);
  assert.equal(loose.json.data.deliverable.kind, "note", "kind defaults to note");

  assert.equal((await call("GET", "/api/deliverables?project=deliv")).json.data.deliverables.length, 2);
  const filtered = (await call("GET", `/api/deliverables?project=deliv&cardId=${card.id}`)).json.data.deliverables;
  assert.deepEqual(filtered.map((x) => x.id), [d.id]);

  assert.equal((await call("POST", "/api/deliverables", { project: "deliv" })).status, 422, "title is required");
  assert.equal((await call("POST", "/api/deliverables", { project: "deliv", title: "ghost", cardId: 999 })).status, 404);

  assert.equal((await call("DELETE", `/api/deliverables/deliv/${d.id}`)).status, 200);
  assert.equal((await call("GET", "/api/deliverables?project=deliv")).json.data.deliverables.length, 1);
  assert.equal((await call("DELETE", `/api/deliverables/deliv/${d.id}`)).status, 404);

  const tl = (await call("GET", "/api/timeline?project=deliv")).json.data.events;
  assert.ok(tl.some((e) => e.kind === "deliverable.created" && e.entityType === "deliverable"));
  assert.ok(tl.some((e) => e.kind === "deliverable.deleted"));
});

test("deleting a card keeps its deliverable but drops the link (ON DELETE SET NULL)", async (t) => {
  const { call } = await initializedServer(t);
  await call("POST", "/api/projects", { slug: "cascade" });
  const card = (await call("POST", "/api/cards", { project: "cascade", title: "tmp" })).json.data.card;
  const d = (await call("POST", "/api/deliverables", { project: "cascade", title: "kept", cardId: card.id })).json.data.deliverable;
  assert.equal((await call("DELETE", `/api/cards/cascade/${card.id}`, { version: card.version })).status, 200);
  const after = (await call("GET", "/api/deliverables?project=cascade")).json.data.deliverables;
  assert.equal(after.length, 1);
  assert.equal(after[0].id, d.id);
  assert.equal(after[0].cardId, null);
});
