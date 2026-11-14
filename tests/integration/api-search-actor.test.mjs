// A1: search without `project` walks every board; `limit` is one budget for the whole
// answer. A2: the board snapshot carries lastActor (a read-only timeline projection) and
// a write that sends it is refused instead of silently dropped.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./_ts-hooks.mjs";
import { startTestServer } from "../helpers/server.mjs";

test("search: project is optional and the limit spans all boards", async (t) => {
  const { call } = await startTestServer(t, "kb-a1-");
  assert.equal((await call("POST", "/api/projects", { slug: "alpha" })).status, 201);
  assert.equal((await call("POST", "/api/projects", { slug: "beta" })).status, 201);

  // Four matches in alpha, one in beta. A per-board limit of 2 would return 2 hits and hide
  // beta entirely; the global limit of 3 must come from the merged, sorted set.
  for (const title of ["needle one", "needle two", "needle three", "needle four"]) {
    assert.equal((await call("POST", "/api/cards", { project: "alpha", title })).status, 201);
  }
  assert.equal((await call("POST", "/api/cards", { project: "beta", title: "needle beta" })).status, 201);

  const all = await call("GET", "/api/search?q=needle");
  assert.equal(all.status, 200);
  assert.equal(all.data.hits.length, 5, "no project means every board");
  assert.deepEqual([...new Set(all.data.hits.map(h => h.projectId))].sort(), ["alpha", "beta"]);
  assert.ok(all.data.hits.every(h => typeof h.projectId === "string" && h.projectId !== ""));

  const limited = await call("GET", "/api/search?q=needle&limit=3");
  assert.equal(limited.data.hits.length, 3);
  const ids = new Set(limited.data.hits.map(h => `${h.projectId}#${h.id}`));
  assert.equal(ids.size, 3, "the slice keeps distinct hits");

  // #<id> is an id lookup and ids are per board, so the same number answers twice.
  const byId = await call("GET", "/api/search?q=%231");
  assert.deepEqual(byId.data.hits.map(h => h.projectId).sort(), ["alpha", "beta"]);

  // An explicit project still narrows to that board; an unknown one is still 404.
  const one = await call("GET", "/api/search?q=needle&project=beta");
  assert.deepEqual(one.data.hits.map(h => h.projectId), ["beta"]);
  assert.equal((await call("GET", "/api/search?q=needle&project=nope")).status, 404);
});

test("board: cards carry lastActor and the API refuses it on writes", async (t) => {
  const { call } = await startTestServer(t, "kb-a2-");
  await call("POST", "/api/projects", { slug: "actor" });
  const created = await call("POST", "/api/cards", { project: "actor", title: "watched" });
  assert.equal(created.status, 201);
  const id = created.data.card.id;

  // The HTTP layer writes as "ui"; the repository default would be "system".
  let board = await call("GET", "/api/board?project=actor");
  assert.equal(board.data.cards[0].lastActor, "ui");

  await call("POST", `/api/cards/actor/${id}/move`, { columnId: "doing", version: created.data.card.version });
  board = await call("GET", "/api/board?project=actor");
  const moved = board.data.cards.find(c => c.id === id);
  assert.equal(moved.columnId, "doing");
  assert.equal(moved.lastActor, "ui", "the newest event wins");

  // A card that never saw an event (only possible outside the repo) reads as null, so the
  // field's type is `string | null` and never `undefined` in a snapshot.
  assert.equal(typeof moved.lastActor, "string");

  const bogusPatch = await call("PATCH", `/api/cards/actor/${id}`, { version: moved.version, lastActor: "me" });
  assert.equal(bogusPatch.status, 422);
  assert.equal(bogusPatch.json.error.code, "VALIDATION");
  assert.equal(bogusPatch.json.error.details.field, "lastActor");

  const bogusCreate = await call("POST", "/api/cards", { project: "actor", title: "x", lastActor: "me" });
  assert.equal(bogusCreate.status, 422);

  // Nothing was written by the rejected calls.
  const after = await call("GET", "/api/board?project=actor");
  assert.equal(after.data.cards.length, 1);
  assert.equal(after.data.cards[0].title, "watched");
});
