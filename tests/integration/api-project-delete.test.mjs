// DELETE /api/projects/:slug removes the board and everything that hangs off it.
// Real server, temp home, temp DB — ~/.pi/kanban is never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import "./_ts-hooks.mjs";

const { executeInit, planInit } = await import("../../src/persistence/init.ts");
const { startServer } = await import("../../src/api/start.ts");
const { openDb, all, closeDb } = await import("../../src/persistence/db.ts");
const { DB_FILE } = await import("../../src/shared/constants.ts");

// 1x1 transparent PNG: the upload path sniffs magic bytes, so the fixture has to be real.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

async function server(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "kb-projdel-"));
  const home = path.join(dir, ".pi", "kanban");
  await executeInit(planInit(new Date(), home), { confirmed: true });
  const run = await startServer({ home, port: 0 });
  t.after(() => run.close());
  const base = run.url.replace(/\/$/, "");

  const call = async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), authorization: `Bearer ${run.token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* binary or html */ }
    return { status: res.status, json, text, data: json?.data };
  };
  const upload = async (p, bytes) => {
    const res = await fetch(base + p, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", authorization: `Bearer ${run.token}` },
      body: bytes,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, data: json?.data };
  };
  return { run, base, home, call, upload };
}

/** The route leaves no HTTP trace of a gone project, so count the rows in the same DB. */
async function counts(home, projectId) {
  const db = openDb(path.join(home, DB_FILE));
  try {
    const tables = ["project", "column_def", "card", "dependency", "deliverable", "attachment", "saved_view", "card_template", "loop_state", "card_lock", "counters"];
    const out = {};
    for (const table of tables) out[table] = all(db, `SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`, projectId)[0].n;
    return out;
  } finally {
    closeDb(db);
  }
}

test("delete removes the board and cascades its rows, keeping the timeline", async (t) => {
  const { call, upload, home } = await server(t);
  const a = (await call("POST", "/api/projects", { slug: "gone", name: "Gone" })).data.project;
  await call("POST", "/api/projects", { slug: "keep", name: "Keep" });

  const one = (await call("POST", "/api/cards", { project: "gone", title: "first" })).data.card;
  const two = (await call("POST", "/api/cards", { project: "gone", title: "second" })).data.card;
  await call("POST", "/api/dependencies", { project: "gone", fromCard: one.id, toCard: two.id, type: "blocks" });
  const dv = (await call("POST", "/api/deliverables", { project: "gone", title: "artifact", cardId: one.id })).data.deliverable;
  await call("POST", "/api/views", { project: "gone", name: "mine", query: { q: "x" } });
  const up = await upload(`/api/attachments?project=gone&cardId=${one.id}&name=shot.png`, PNG);
  assert.equal(up.status, 201);
  const attachmentId = up.data.attachment.id;
  // The composite FK (project_id, deliverable_id) ON DELETE SET NULL only has a row to fire on
  // when a deliverable actually carries an attachment. These 404s prove nothing by themselves
  // (projectOr404 answers first); the `counts` below are what shows the rows are gone.
  const dvUp = await upload(`/api/attachments?project=gone&deliverableId=${dv.id}&name=dv.png`, PNG);
  assert.equal(dvUp.status, 201);

  const del = await call("DELETE", "/api/projects/gone");
  assert.equal(del.status, 200, del.text);
  assert.equal(del.data.deleted.projectId, a.projectId);
  assert.equal(del.data.deleted.slug, "gone");

  const slugs = (await call("GET", "/api/projects")).data.projects.map(p => p.slug);
  assert.deepEqual(slugs, ["keep"]);
  assert.equal((await call("GET", "/api/board?project=gone")).status, 404);
  assert.equal((await call("GET", `/api/attachments/gone/${attachmentId}`)).status, 404);
  assert.equal((await call("GET", `/api/attachments/gone/${dvUp.data.attachment.id}`)).status, 404);

  const left = await counts(home, a.projectId);
  for (const [table, n] of Object.entries(left)) assert.equal(n, 0, `${table} still has rows`);

  // History is append-only and has no FK: the project.deleted event outlives the board.
  const db = openDb(path.join(home, DB_FILE));
  try {
    const events = all(db, "SELECT kind FROM timeline_event WHERE project_id = ?", a.projectId).map(e => e.kind);
    assert.ok(events.includes("project.deleted"), JSON.stringify(events));
  } finally {
    closeDb(db);
  }
});

test("deleting one board leaves the other board's snapshot alone", async (t) => {
  const { call } = await server(t);
  await call("POST", "/api/projects", { slug: "doomed" });
  await call("POST", "/api/projects", { slug: "survivor" });
  await call("POST", "/api/cards", { project: "doomed", title: "doomed card" });
  await call("POST", "/api/cards", { project: "survivor", title: "kept card" });

  assert.equal((await call("DELETE", "/api/projects/doomed")).status, 200);

  const board = (await call("GET", "/api/board?project=survivor")).data;
  assert.equal(board.cards.length, 1, "card ids are per project: only the survivor's card is here");
  assert.equal(board.cards[0].title, "kept card");
  assert.equal((await call("GET", "/api/board?project=doomed")).status, 404);
});

test("unknown slug is 404, not a silent no-op", async (t) => {
  const { call } = await server(t);
  const res = await call("DELETE", "/api/projects/nope");
  assert.equal(res.status, 404);
  assert.equal(res.json.error.code, "NOT_FOUND");
});

test("the slug is free again after a delete", async (t) => {
  const { call } = await server(t);
  await call("POST", "/api/projects", { slug: "again" });
  assert.equal((await call("DELETE", "/api/projects/again")).status, 200);

  const recreate = await call("POST", "/api/projects", { slug: "again", name: "Again" });
  assert.equal(recreate.status, 201, recreate.text);
  assert.equal(recreate.data.project.slug, "again");
  assert.equal((await call("GET", "/api/board?project=again")).status, 200);
});

// The route has to drop the wake claim the deleted board owned. This runs in the same process as
// the server, so driver's map is the one /api/loop reports; the child is a fake because a real
// wake would spawn pi.
test("delete drops the wake entry the board owned", async (t) => {
  const { EventEmitter } = await import("node:events");
  const { call, home } = await server(t);
  await call("POST", "/api/projects", { slug: "wired", name: "Wired" });
  // A second board keeps a loop to ask after the first one is gone: /api/loop needs a project.
  await call("POST", "/api/projects", { slug: "probe", name: "Probe" });
  const card = (await call("POST", "/api/cards", { project: "wired", title: "走る", columnId: "doing" })).data.card;

  const db = openDb(path.join(home, DB_FILE));
  t.after(() => closeDb(db));
  const repos = await import("../../src/persistence/repos.ts");
  const { wakeCardSession, runningWakes } = await import("../../src/agent/driver.ts");
  const child = new EventEmitter();
  Object.assign(child, { pid: process.pid, exitCode: null, killed: false, stdout: { resume() {} }, stderr: new EventEmitter() });
  const woken = await wakeCardSession(db, repos.getProject(db, "wired"), repos.getCard(db, "wired", card.id), {
    spawn: () => child,
    fetch: async () => { throw new Error("ECONNREFUSED"); },
  });
  assert.ok(woken, "a wake claims the board");
  const claims = async () => (await call("GET", "/api/loop?project=probe")).data.loop.running.filter(e => e.projectId === "wired");
  assert.equal((await claims()).length, 1, "the server reports the claim, so it is the same map");

  assert.equal((await call("DELETE", "/api/projects/wired")).status, 200);
  assert.deepEqual(await claims(), [], "the deleted board no longer owns a wake");
  assert.deepEqual(runningWakes().filter(e => e.projectId === "wired"), []);
});
