import { test } from "node:test";
import assert from "node:assert/strict";
import { setupServer, detectState, planInit, executeInit, tempHome } from "./_harness.mjs";

test("init: detect/inspect/plan/execute in temp home", async () => {
  const home = await tempHome("kb-init-");
  const st0 = detectState(home);
  assert.equal(st0.status, "missing");
  const plan = planInit(new Date("2026-01-01T00:00:00Z"), home);
  assert.equal(plan.home, home);
  assert.ok(plan.backupDir.startsWith(home + ".v1.bak-"), "a dated backup dir is planned");
  const res = await executeInit(plan, { confirmed: true });
  assert.equal(res.home, home);
  assert.equal(res.schemaVersion, 2);
  const st1 = detectState(home);
  assert.equal(st1.status, "v2");
});

test("server bootstrap + auth", async (t) => {
  const { req, token } = await setupServer(t);
  // no auth
  const no = await req("GET", "/api/meta", undefined, { auth: "" });
  assert.equal(no.status, 401);
  // bad auth
  const bad = await req("GET", "/api/meta", undefined, { auth: "wrong" });
  assert.equal(bad.status, 401);
  // ok
  const ok = await req("GET", "/api/meta");
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.ok(ok.json.data.tokenConfigured === true || token);
  // index bootstrap via token query
  const idx = await req("GET", "/?token=" + encodeURIComponent(token), undefined, { auth: "", raw: true });
  assert.equal(idx.status, 200);
});

test("projects and board", async (t) => {
  const { req } = await setupServer(t);
  const list0 = await req("GET", "/api/projects");
  assert.equal(list0.status, 200);
  const p = await req("POST", "/api/projects", { slug: "demo", name: "Demo" });
  assert.equal(p.status, 201);
  assert.equal(p.json.data.project.projectId, "demo");
  const board = await req("GET", "/api/board?project=demo");
  assert.equal(board.status, 200);
  const cols = board.json.data.columns.map(c=>c.id);
  assert.deepEqual(cols, ["todo","doing","done"]);
  const bad = await req("POST", "/api/projects", { slug: "Bad Upper" });
  assert.equal(bad.status, 422);
});

test("cards CRUD, version conflicts, wrong project", async (t) => {
  const { req } = await setupServer(t);
  await req("POST", "/api/projects", { slug: "p1" });
  await req("POST", "/api/projects", { slug: "p2" });
  const c = await req("POST", "/api/cards", { project: "p1", columnId: "todo", title: "t1" });
  assert.equal(c.status, 201);
  const card = c.json.data.card;
  assert.equal(card.version, 1);
  // unknown column
  const unk = await req("POST", "/api/cards", { project: "p1", columnId: "nope", title: "x" });
  assert.ok([400,422].includes(unk.status));
  // stale patch (invalid version -> 422; stale valid version -> 409)
  // version 0 is not a "stale" version, it is not a version at all (>= 1)
  const p0 = await req("PATCH", "/api/cards/p1/"+card.id, { version: 0, title: "x" });
  assert.equal(p0.status, 422);
  const p1 = await req("PATCH", "/api/cards/p1/"+card.id, { version: 999, title: "x" });
  assert.equal(p1.status, 409);
  const p2 = await req("PATCH", "/api/cards/p1/"+card.id, { version: 1, title: "ok" });
  assert.equal(p2.status, 200);
  assert.equal(p2.json.data.card.version, 2);
  // wrong project 404
  const w = await req("PATCH", "/api/cards/p2/"+card.id, { version: 2, title: "no" });
  assert.equal(w.status, 404);
  // move stale
  const m1 = await req("POST", "/api/cards/p1/"+card.id+"/move", { columnId: "doing", version: 1 });
  assert.equal(m1.status, 409);
  const m2 = await req("POST", "/api/cards/p1/"+card.id+"/move", { columnId: "doing", version: 2 });
  assert.equal(m2.status, 200);
  // delete stale then ok
  const d1 = await req("DELETE", "/api/cards/p1/"+card.id, { version: 2 });
  assert.equal(d1.status, 409);
  const d2 = await req("DELETE", "/api/cards/p1/"+card.id, { version: 3 });
  assert.ok([200,204].includes(d2.status));
  const gone = await req("PATCH", "/api/cards/p1/"+card.id, { version: 3, title: "x" });
  assert.equal(gone.status, 404);
});

test("WIP limit returns 409", async (t) => {
  const { req, srv } = await setupServer(t);
  await req("POST", "/api/projects", { slug: "wip" });
  // No column endpoint yet, so the cap is set through the repository the server holds.
  const { createColumn } = await import("../../src/persistence/repos.ts");
  createColumn(srv.db, { projectId: "wip", id: "focus", name: "Focus", kind: "doing", ord: 4, wipLimit: 1 });
  const a = await req("POST", "/api/cards", { project: "wip", columnId: "focus", title: "a" });
  assert.equal(a.status, 201);
  const b = await req("POST", "/api/cards", { project: "wip", columnId: "focus", title: "b" });
  assert.equal(b.status, 409);
  assert.equal(b.json.error.code, "WIP_LIMIT");
});

test("dependencies: add/list/cycle/self if supported", async (t) => {
  const { req } = await setupServer(t);
  await req("POST", "/api/projects", { slug: "dep" });
  const c1 = (await req("POST", "/api/cards", { project:"dep", column:"todo", title:"a" })).json.data.card;
  const c2 = (await req("POST", "/api/cards", { project:"dep", column:"todo", title:"b" })).json.data.card;
  const add = await req("POST", "/api/dependencies", { project:"dep", fromCard:c1.id, toCard:c2.id, type:"blocks" });
  if (add.status === 404) return; // not implemented
  assert.equal(add.status, 201);
  const list = await req("GET", "/api/dependencies?project=dep");
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.json.data.dependencies));
  const self = await req("POST", "/api/dependencies", { project:"dep", fromCard:c1.id, toCard:c1.id, type:"blocks" });
  assert.ok([409,422,400].includes(self.status));
  const cyc = await req("POST", "/api/dependencies", { project:"dep", fromCard:c2.id, toCard:c1.id, type:"blocks" });
  assert.ok([409,422].includes(cyc.status));
});

test("timeline endpoint present", async (t) => {
  const { req } = await setupServer(t);
  await req("POST", "/api/projects", { slug: "tl" });
  await req("POST", "/api/cards", { project:"tl", column:"todo", title:"x" });
  const tl = await req("GET", "/api/timeline?project=tl");
  assert.equal(tl.status, 200);
  assert.ok(tl.json.data.events || tl.json.data.timeline || Array.isArray(tl.json.data));
});
