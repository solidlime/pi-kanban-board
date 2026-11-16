// v2 extras over the wire: columns/saved views/templates/attachments/search/notifications/
// graph/overview/loop. Real server, temp home, temp DB — ~/.pi/kanban is never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import "./_ts-hooks.mjs";

const { executeInit, planInit } = await import("../../src/persistence/init.ts");
const { startServer } = await import("../../src/api/start.ts");

// 1x1 transparent PNG. The upload path sniffs magic bytes, so the fixture has to be real.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

async function server(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "kb-extras-"));
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
    return { status: res.status, json, text, data: json?.data, headers: res.headers };
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
  const getBytes = async (p) => {
    const res = await fetch(base + p, { headers: { authorization: `Bearer ${run.token}` } });
    return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
  };
  return { run, base, home, call, upload, getBytes };
}

test("meta advertises the new capabilities and schema v3", async (t) => {
  const { call } = await server(t);
  const meta = (await call("GET", "/api/meta")).data;
  assert.equal(meta.schemaVersion, 3);
  for (const cap of ["columns.update", "views", "templates", "attachments", "search", "notifications", "graph", "overview", "loop"]) {
    assert.ok(meta.capabilities.includes(cap), `missing capability ${cap}`);
  }
});

test("columns: wip limit and name are editable, bad values are rejected", async (t) => {
  const { call } = await server(t);
  await call("POST", "/api/projects", { slug: "cols" });

  const wip = await call("PATCH", "/api/columns/cols/doing", { wipLimit: 1 });
  assert.equal(wip.status, 200);
  assert.equal(wip.data.column.wipLimit, 1);

  const renamed = await call("PATCH", "/api/columns/cols/doing", { name: "In Progress" });
  assert.equal(renamed.data.column.name, "In Progress");
  assert.equal(renamed.data.column.wipLimit, 1, "a partial patch keeps the other field");

  assert.equal((await call("PATCH", "/api/columns/cols/doing", { wipLimit: -1 })).status, 422);
  assert.equal((await call("PATCH", "/api/columns/cols/doing", { wipLimit: 1.5 })).status, 422);
  assert.equal((await call("PATCH", "/api/columns/cols/doing", { name: "   " })).status, 422);
  assert.equal((await call("PATCH", "/api/columns/cols/nope", { wipLimit: 1 })).status, 404);
  assert.equal((await call("PATCH", "/api/columns/nope/todo", { wipLimit: 1 })).status, 404);

  // null clears the limit again
  const cleared = await call("PATCH", "/api/columns/cols/doing", { wipLimit: null });
  assert.equal(cleared.data.column.wipLimit, null);

  // the timeline records the change (it is a board event, not a silent UPDATE)
  const events = (await call("GET", "/api/timeline?project=cols")).data.events;
  assert.ok(events.some((e) => e.kind === "board.column.updated"));
});

test("saved views: create, list, rename, duplicate name 409, delete", async (t) => {
  const { call } = await server(t);
  await call("POST", "/api/projects", { slug: "views" });

  const created = await call("POST", "/api/views", { project: "views", name: "mine", query: { q: "bug" } });
  assert.equal(created.status, 201);
  assert.equal(created.data.view.name, "mine");
  assert.deepEqual(created.data.view.query, { q: "bug" });

  assert.equal((await call("POST", "/api/views", { project: "views", name: "  " })).status, 422);
  assert.equal((await call("POST", "/api/views", { project: "nope", name: "x" })).status, 404);
  assert.equal((await call("POST", "/api/views", { project: "views", name: "mine" })).status, 409, "names are unique per board");

  const listed = (await call("GET", "/api/views?project=views")).data.views;
  assert.equal(listed.length, 1);

  const renamed = await call("PATCH", `/api/views/views/${created.data.view.id}`, { name: "ours" });
  assert.equal(renamed.data.view.name, "ours");

  const second = await call("POST", "/api/views", { project: "views", name: "other" });
  assert.equal((await call("PATCH", `/api/views/views/${second.data.view.id}`, { name: "ours" })).status, 409);

  assert.equal((await call("DELETE", `/api/views/views/${created.data.view.id}`)).status, 200);
  assert.equal((await call("DELETE", `/api/views/views/${created.data.view.id}`)).status, 404);
  assert.equal((await call("GET", "/api/views?project=views")).data.views.length, 1);
});

test("templates: create, instantiate into a card, reject an unknown column, delete", async (t) => {
  const { call } = await server(t);
  await call("POST", "/api/projects", { slug: "tpl" });

  const made = await call("POST", "/api/templates", {
    project: "tpl", name: "bugfix", title: "fix: ", body: "- [ ] reproduce", columnId: "doing", priority: 3, labels: ["bug"],
  });
  assert.equal(made.status, 201);
  assert.equal(made.data.template.name, "bugfix");
  assert.deepEqual(made.data.template.labels, ["bug"]);

  assert.equal((await call("POST", "/api/templates", { project: "tpl", name: "bad", title: "x", columnId: "nope" })).status, 422);
  assert.equal((await call("POST", "/api/templates", { project: "tpl", name: "", title: "x" })).status, 422);

  const used = await call("POST", `/api/templates/tpl/${made.data.template.id}`, {});
  assert.equal(used.status, 201);
  assert.equal(used.data.card.title, "fix:", "titles are trimmed on the way in");
  assert.equal(used.data.card.columnId, "doing", "the template column wins when the body names none");
  assert.equal(used.data.card.priority, 3);

  const moved = await call("POST", `/api/templates/tpl/${made.data.template.id}`, { columnId: "todo" });
  assert.equal(moved.data.card.columnId, "todo", "an explicit column overrides the template");

  assert.equal((await call("POST", `/api/templates/tpl/${made.data.template.id}`, { columnId: "nope" })).status, 422);
  assert.equal((await call("POST", "/api/templates/tpl/999", {})).status, 404);

  assert.equal((await call("GET", "/api/templates?project=tpl")).data.templates.length, 1);
  assert.equal((await call("DELETE", `/api/templates/tpl/${made.data.template.id}`)).status, 200);
  assert.equal((await call("DELETE", `/api/templates/tpl/${made.data.template.id}`)).status, 404);
});

test("attachments: png is stored and served with nosniff, anything else is 422", async (t) => {
  const { call, upload, getBytes, home } = await server(t);
  await call("POST", "/api/projects", { slug: "att" });
  const card = (await call("POST", "/api/cards", { project: "att", title: "has a picture" })).data.card;

  const up = await upload(`/api/attachments?project=att&cardId=${card.id}&name=screenshot.png`, PNG);
  assert.equal(up.status, 201, JSON.stringify(up.json));
  assert.equal(up.data.attachment.mime, "image/png");
  assert.equal(up.data.attachment.size, PNG.length);
  assert.equal(up.data.attachment.name, "screenshot.png");
  assert.equal(up.data.attachment.cardId, card.id);

  // the bytes are content-addressed under <home>/media/att
  const files = await readdir(path.join(home, "media", "att"));
  assert.equal(files.length, 1);
  assert.match(files[0], /^[a-f0-9]{32}\.png$/);

  const listed = (await call("GET", `/api/attachments?project=att&cardId=${card.id}`)).data.attachments;
  assert.equal(listed.length, 1);

  const id = up.data.attachment.id;
  const bytes = await getBytes(`/api/attachments/att/${id}`);
  assert.equal(bytes.status, 200);
  assert.equal(bytes.headers.get("content-type"), "image/png");
  assert.equal(bytes.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(bytes.bytes, PNG, "the stored bytes are served back unchanged");
  assert.equal((await getBytes("/api/attachments/att/999")).status, 404);

  // A text file must not be stored: an uploaded text/html served from our origin is XSS.
  const bad = await upload(`/api/attachments?project=att&cardId=${card.id}&name=x.html`, Buffer.from("<script>alert(1)</script>"));
  assert.equal(bad.status, 422);
  assert.equal(bad.json.error.code, "VALIDATION");

  assert.equal((await upload("/api/attachments?project=att", PNG)).status, 400, "cardId or deliverableId is required");
  assert.equal((await upload(`/api/attachments?project=att&cardId=999`, PNG)).status, 404);

  assert.equal((await call("DELETE", `/api/attachments/att/${id}`)).status, 200);
  assert.equal((await call("GET", "/api/attachments?project=att")).data.attachments.length, 0);
  assert.equal((await call("DELETE", `/api/attachments/att/${id}`)).status, 404);
});

test("card ref: recorded on PATCH, cleared by null, survives a re-read", async (t) => {
  const { call } = await server(t);
  await call("POST", "/api/projects", { slug: "refs" });
  const card = (await call("POST", "/api/cards", { project: "refs", title: "ref me" })).data.card;
  assert.equal(card.ref, null);

  // PATCH is optimistic-locked: the current version has to come along.
  const set = await call("PATCH", `/api/cards/refs/${card.id}`, { ref: "/tmp/report.html", version: card.version });
  assert.equal(set.data.card.ref, "/tmp/report.html");
  const board = (await call("GET", "/api/board?project=refs")).data;
  assert.equal(board.cards[0].ref, "/tmp/report.html", "ref is persisted, not just echoed");

  const cleared = await call("PATCH", `/api/cards/refs/${card.id}`, { ref: null, version: set.data.card.version });
  assert.equal(cleared.data.card.ref, null);
});

test("search: title, body and #id hits, deliverables included", async (t) => {
  const { call } = await server(t);
  await call("POST", "/api/projects", { slug: "s" });
  const a = (await call("POST", "/api/cards", { project: "s", title: "Board renewal", body: "詳細: 期限は金曜" })).data.card;
  await call("POST", "/api/cards", { project: "s", title: "unrelated" });
  const d = (await call("POST", "/api/deliverables", { project: "s", title: "renewal mock", ref: "/tmp/mock.png" })).data.deliverable;

  const byTitle = (await call("GET", "/api/search?project=s&q=renewal")).data.hits;
  assert.deepEqual(byTitle.map((h) => [h.type, h.id]).sort(), [["card", a.id], ["deliverable", d.id]].sort());
  assert.ok(byTitle.some((h) => h.type === "card" && h.columnId === "todo"), "card hits carry their column");
  assert.ok(byTitle.some((h) => h.type === "deliverable" && h.columnId === undefined), "deliverable hits carry none");

  const byBody = (await call("GET", "/api/search?project=s&q=金曜")).data.hits;
  assert.equal(byBody.length, 1);
  assert.equal(byBody[0].id, a.id);
  assert.match(byBody[0].snippet, /金曜/);

  const byId = (await call("GET", "/api/search?project=s&q=%23" + a.id)).data.hits;
  assert.equal(byId[0].id, a.id, "an id query wins over substring matches");

  assert.deepEqual((await call("GET", "/api/search?project=s&q=")).data.hits, []);
  assert.deepEqual((await call("GET", "/api/search?project=s&q=zzz")).data.hits, []);
  assert.equal((await call("GET", "/api/search?project=nope&q=x")).status, 404);
});

test("notifications: overdue, blocked, deps, wip and acceptance all surface", async (t) => {
  const { call } = await server(t);
  await call("POST", "/api/projects", { slug: "n" });
  const overdue = (await call("POST", "/api/cards", { project: "n", title: "late", due: "2020-01-01" })).data.card;
  const blocked = (await call("POST", "/api/cards", { project: "n", title: "stuck", blockedReason: "waiting for review" })).data?.card;
  assert.ok(blocked, "POST /api/cards accepts blockedReason");
  assert.equal(blocked.blockedReason, "waiting for review");
  const blocker = (await call("POST", "/api/cards", { project: "n", title: "first" })).data.card;
  const dependent = (await call("POST", "/api/cards", { project: "n", title: "second" })).data.card;
  await call("POST", "/api/dependencies", { project: "n", fromCard: blocker.id, toCard: dependent.id });

  // a done card that still has unchecked acceptance items
  const accepted = (await call("POST", "/api/cards", { project: "n", title: "almost", body: "- [x] one\n- [ ] two" })).data.card;
  await call("POST", `/api/cards/n/${accepted.id}/move`, { columnId: "done", version: accepted.version });

  // wip: two cards are allowed in, then the limit drops below the count
  await call("POST", "/api/cards", { project: "n", title: "in flight", columnId: "doing" });
  await call("POST", "/api/cards", { project: "n", title: "second flight", columnId: "doing" });
  assert.equal((await call("PATCH", "/api/columns/n/doing", { wipLimit: 1 })).data.column.wipLimit, 1,
    "lowering the limit under existing cards is allowed — it is an alert, not a delete");

  const items = (await call("GET", "/api/notifications?project=n")).data.notifications;
  const kinds = new Set(items.map((i) => i.kind));
  for (const kind of ["overdue", "blocked", "deps", "wip", "acceptance"]) {
    assert.ok(kinds.has(kind), `missing ${kind}; got ${[...kinds].join(",")}`);
  }
  const overdueItem = items.find((i) => i.kind === "overdue");
  assert.equal(overdueItem.cardId, overdue.id);
  assert.equal(overdueItem.level, "danger");
  assert.match(overdueItem.detail, /2020-01-01/);
  assert.equal(items.find((i) => i.kind === "blocked").cardId, blocked.id);
  assert.equal(items.find((i) => i.kind === "deps").cardId, dependent.id);
  assert.equal(items.find((i) => i.kind === "wip").columnId, "doing");
  assert.equal(items.find((i) => i.kind === "acceptance").cardId, accepted.id);
  assert.match(items.find((i) => i.kind === "acceptance").detail, /1\/2/);

  // danger sorts before warn, warn before info
  const ranks = items.map((i) => ({ danger: 0, warn: 1, info: 2 })[i.level]);
  assert.deepEqual(ranks, [...ranks].sort((x, y) => x - y));

  // no project filter = every board
  const all = (await call("GET", "/api/notifications")).data.notifications;
  assert.ok(all.length >= items.length);
});

test("graph: layers follow the blocker chain", async (t) => {
  const { call } = await server(t);
  await call("POST", "/api/projects", { slug: "g" });
  const a = (await call("POST", "/api/cards", { project: "g", title: "a" })).data.card;
  const b = (await call("POST", "/api/cards", { project: "g", title: "b" })).data.card;
  const c = (await call("POST", "/api/cards", { project: "g", title: "c" })).data.card;
  await call("POST", "/api/dependencies", { project: "g", fromCard: a.id, toCard: b.id });
  await call("POST", "/api/dependencies", { project: "g", fromCard: b.id, toCard: c.id });

  const layout = (await call("GET", "/api/graph?project=g")).data;
  assert.equal(layout.layers, 3);
  assert.deepEqual(layout.nodes.map((n) => [n.id, n.layer]), [[a.id, 0], [b.id, 1], [c.id, 2]]);
  assert.deepEqual(layout.edges, [{ from: a.id, to: b.id }, { from: b.id, to: c.id }]);
  assert.equal(layout.nodes.find((n) => n.id === c.id).blocked, true, "c waits on an open b");
  assert.equal(layout.nodes.find((n) => n.id === a.id).blocked, false);

  // closing a blocker in the middle still leaves c waiting on b, which now waits on nobody open
  await call("POST", `/api/cards/g/${a.id}/move`, { columnId: "done", version: a.version });
  const after = (await call("GET", "/api/graph?project=g")).data;
  assert.equal(after.nodes.find((n) => n.id === b.id).blocked, false);
  assert.equal(after.nodes.find((n) => n.id === a.id).closed, true);
  assert.equal((await call("GET", "/api/graph?project=nope")).status, 404);
});

test("overview: one row per board with ready/blocked/wip/overdue counts", async (t) => {
  const { call } = await server(t);
  await call("POST", "/api/projects", { slug: "o1" });
  await call("POST", "/api/projects", { slug: "o2" });
  const a = (await call("POST", "/api/cards", { project: "o1", title: "a", due: "2020-01-01" })).data.card;
  const b = (await call("POST", "/api/cards", { project: "o1", title: "b" })).data.card;
  await call("POST", "/api/dependencies", { project: "o1", fromCard: a.id, toCard: b.id });
  await call("PATCH", "/api/columns/o1/todo", { wipLimit: 1 });

  const rows = (await call("GET", "/api/overview")).data.projects;
  assert.deepEqual(rows.map((r) => r.projectId), ["o1", "o2"]);
  const o1 = rows.find((r) => r.projectId === "o1");
  assert.equal(o1.counts.total, 2);
  assert.equal(o1.counts.open, 2);
  assert.equal(o1.counts.done, 0);
  assert.equal(o1.counts.overdue, 1);
  assert.equal(o1.counts.blocked, 1, "b waits on an open a (a itself is only overdue)");
  assert.equal(o1.counts.wipOver, 1, "two cards in a column limited to one");
  assert.deepEqual(o1.columns.map((c) => c.id), ["todo", "doing", "done"]);
  assert.equal(o1.columns[0].count, 2);
  assert.equal(o1.columns[0].wipLimit, 1);
  const o2 = rows.find((r) => r.projectId === "o2");
  assert.equal(o2.counts.total, 0);
  assert.equal(o2.counts.ready, 0);
});

test("loop: tick moves the next TODO into DOING (WIP=1) and halts when the TODOs run out", async (t) => {
  const { call } = await server(t);
  await call("POST", "/api/projects", { slug: "lp" });
  const idle = (await call("GET", "/api/loop?project=lp")).data.loop;
  assert.equal(idle.status, "idle");
  assert.equal(idle.nextCardId, null);
  assert.equal(idle.ticks, 0);
  assert.equal((await call("POST", "/api/loop/tick", { project: "lp" })).status, 409, "tick needs a running loop");

  const started = (await call("POST", "/api/loop/start", { project: "lp" })).data.loop;
  assert.equal(started.status, "running");
  assert.ok(started.startedAt);

  const first = (await call("POST", "/api/cards", { project: "lp", title: "blocker" })).data.card;
  const second = (await call("POST", "/api/cards", { project: "lp", title: "waiter" })).data.card;

  // autoPick: the tick itself moves the named TODO into doing.
  const tick = (await call("POST", "/api/loop/tick", { project: "lp" })).data;
  assert.equal(tick.loop.status, "running");
  assert.equal(tick.loop.ticks, 1);
  assert.equal(tick.loop.nextCardId, first.id);
  assert.equal(tick.nextCard.title, "blocker");
  assert.equal(tick.moved.id, first.id);
  assert.equal(tick.moved.columnId, "doing");
  assert.equal(tick.moved.version, first.version + 1, "the move is a real card write");

  // WIP=1: doing is occupied, so the second tick names #2 as the candidate but moves nothing.
  const held = (await call("POST", "/api/loop/tick", { project: "lp" })).data;
  assert.equal(held.loop.status, "running");
  assert.equal(held.loop.nextCardId, second.id);
  assert.equal(held.moved, null);
  const inTodo = (await call("GET", "/api/board?project=lp")).data.cards.find((c) => c.id === second.id);
  assert.equal(inTodo.columnId, "todo", "#2 waits its turn");

  // Free the slot: the next tick moves #2.
  assert.equal((await call("POST", `/api/cards/lp/${first.id}/move`, { columnId: "done", version: tick.moved.version })).status, 200);
  const picked = (await call("POST", "/api/loop/tick", { project: "lp" })).data;
  assert.equal(picked.moved.id, second.id);
  assert.equal(picked.moved.columnId, "doing");

  // Nothing left in TODO -> the loop halts itself and says why.
  assert.equal((await call("POST", `/api/cards/lp/${second.id}/move`, { columnId: "done", version: picked.moved.version })).status, 200);
  const empty = (await call("POST", "/api/loop/tick", { project: "lp" })).data;
  assert.equal(empty.loop.status, "halted");
  assert.equal(empty.loop.nextCardId, null);
  assert.match(empty.loop.haltReason, /ready/);
  assert.equal(empty.nextCard, null);
  assert.equal(empty.moved, null);

  // a halted loop is visible in the notification feed
  const items = (await call("GET", "/api/notifications?project=lp")).data.notifications;
  assert.ok(items.some((i) => i.kind === "loop"));

  const stopped = (await call("POST", "/api/loop/stop", { project: "lp", reason: "done for today" })).data.loop;
  assert.equal(stopped.status, "halted");
  assert.equal(stopped.haltReason, "done for today");

  // the timeline keeps the story
  const events = (await call("GET", "/api/timeline?project=lp")).data.events.map((e) => e.kind);
  assert.ok(events.includes("loop.resumed"));
  assert.ok(events.includes("loop.tick"));
  assert.ok(events.includes("loop.halted"));
  assert.equal((await call("GET", "/api/loop?project=nope")).status, 404);
});
