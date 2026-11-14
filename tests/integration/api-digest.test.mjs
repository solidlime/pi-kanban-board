// A4: GET /api/digest renders one Markdown page for a period — done transitions,
// deliverables and commits — and refuses a `since` it cannot read.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./_ts-hooks.mjs";
import { startTestServer } from "../helpers/server.mjs";

test("digest: finished work, deliverables and commits inside the window", async (t) => {
  const { call } = await startTestServer(t, "kb-a4-");
  assert.equal((await call("POST", "/api/projects", { slug: "dig" })).status, 201);

  const a = await call("POST", "/api/cards", { project: "dig", title: "shipped one" });
  const b = await call("POST", "/api/cards", { project: "dig", title: "still open" });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  const id = a.data.card.id;
  const moved = await call("POST", `/api/cards/dig/${id}/move`, { columnId: "doing", version: a.data.card.version });
  const done = await call("POST", `/api/cards/dig/${id}/move`, { columnId: "done", version: moved.data.card.version });
  assert.equal(done.status, 200);
  const patched = await call("PATCH", `/api/cards/dig/${id}`, { version: done.data.card.version, commit: "abc1234" });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.card.commit, "abc1234", "the commit hash is writable");
  assert.equal((await call("POST", "/api/deliverables", { project: "dig", title: "out.png", ref: "web/out.png" })).status, 201);

  const res = await call("GET", "/api/digest?project=dig");
  assert.equal(res.status, 200);
  assert.equal(res.data.projectId, "dig");
  assert.equal(res.data.counts.done, 1, "only the card that reached done");
  assert.equal(res.data.counts.deliverables, 1);
  assert.equal(res.data.counts.commits, 1);

  const md = res.data.markdown;
  assert.match(md, /^# .+ダイジェスト$/m);
  assert.match(md, new RegExp(`期間: ${res.data.since.replace(/[.]/g, "\\.")} →`));
  assert.ok(md.includes(`- #${id} shipped one`), "done line names the card");
  assert.ok(md.includes("- out.png — web/out.png"), "deliverable line keeps the ref");
  assert.ok(md.includes(`- #${id} abc1234 shipped one`), "commit line names the card");
  assert.ok(!md.includes("still open"), "an untouched card is not a line");

  // The window is honoured: nothing was finished before the epoch-moving cutoff.
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const empty = await call("GET", `/api/digest?project=dig&since=${encodeURIComponent(future)}`);
  assert.equal(empty.status, 200);
  assert.equal(empty.data.counts.done, 0);
  assert.equal(empty.data.markdown.match(/- なし/g).length, 3, "each empty section says so");

  // Relative windows are relative to now, so 7d still sees today's work.
  const week = await call("GET", "/api/digest?project=dig&since=7d");
  assert.equal(week.data.counts.done, 1);
  assert.ok(week.data.since < new Date().toISOString());

  // Bad windows and unknown boards are errors, not empty digests.
  const bad = await call("GET", "/api/digest?project=dig&since=7");
  assert.equal(bad.status, 422);
  assert.equal(bad.json.error.code, "VALIDATION");
  assert.equal(bad.json.error.details.field, "since");
  assert.equal((await call("GET", "/api/digest")).status, 400);
  assert.equal((await call("GET", "/api/digest?project=nope")).status, 404);
});
