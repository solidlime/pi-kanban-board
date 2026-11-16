// v1 quick-add line parser. Pure: no server, no DB. The two callers (POST /api/cards and
// the /kanban add command) both go through this, so the vocabulary is pinned here.
import test from "node:test";
import assert from "node:assert/strict";
import "./_load.mjs";

const { parseQuickAdd, QUICKADD_MAX_BYTES } = await import("../../src/core/quickadd.ts");

const ok = (r) => {
  assert.equal(r.ok, true, r.ok ? "" : `parse failed: ${r.error}`);
  return r.value;
};

test("plain text is just a title", () => {
  assert.deepEqual(ok(parseQuickAdd("牛乳を買う")), {
    title: "牛乳を買う", project: null, estimate: null, due: null,
  });
});

test("#slug names the project and leaves the title", () => {
  const qa = ok(parseQuickAdd("#pi-kanban 板を直す"));
  assert.equal(qa.project, "pi-kanban");
  assert.equal(qa.title, "板を直す");
});

test("!N is an estimate clamped to 1..5", () => {
  assert.equal(ok(parseQuickAdd("!2 中くらい")).estimate, 2);
  assert.equal(ok(parseQuickAdd("!9 重い")).estimate, 5);
  assert.equal(ok(parseQuickAdd("!0 軽い")).estimate, 1);
  // Not a token: an exclamation that is not digits stays in the title.
  assert.deepEqual(ok(parseQuickAdd("!x ただの本文")).title, "!x ただの本文");
});

test("due: takes a real calendar date", () => {
  assert.equal(ok(parseQuickAdd("due:2026-12-01 締切")).due, "2026-12-01");
  assert.equal(parseQuickAdd("due:2026-02-30 締切").ok, false);
  assert.equal(parseQuickAdd("due:2026-13-01 締切").ok, false);
  assert.equal(parseQuickAdd("due:nope 締切").ok, false);
});

test("tokens only count while they run from the start", () => {
  const qa = ok(parseQuickAdd("本文の途中の #pi と !3 はトークンではない"));
  assert.equal(qa.title, "本文の途中の #pi と !3 はトークンではない");
  assert.equal(qa.project, null);
  assert.equal(qa.estimate, null);
});

test("the first #slug wins and a later one is dropped, as in v1", () => {
  const qa = ok(parseQuickAdd("#a #b 本文"));
  assert.equal(qa.project, "a");
  assert.equal(qa.title, "本文");
});

test("all three tokens in any order", () => {
  const qa = ok(parseQuickAdd("#demo !3 due:2026-01-02 三つ揃い"));
  assert.deepEqual(qa, { title: "三つ揃い", project: "demo", estimate: 3, due: "2026-01-02" });
});

test("tokens only means there is no title", () => {
  assert.equal(parseQuickAdd("#demo !2 due:2026-01-02").ok, false);
  assert.equal(parseQuickAdd("").ok, false);
});

test("newlines are spaces, not a second card", () => {
  assert.equal(ok(parseQuickAdd("2行目\n3行目")).title, "2行目 3行目");
});

test("#slug is a real slug: v1 kept the case, v2 rejects it", () => {
  // Both callers share this validation, so the message is the same on HTTP and on /kanban.
  assert.equal(parseQuickAdd("#MyProj x").ok, false);
  assert.equal(parseQuickAdd("#-x x").ok, false);
  assert.equal(parseQuickAdd(`#${"a".repeat(65)} x`).ok, false);
  assert.equal(ok(parseQuickAdd("#a_b.c-1 x")).project, "a_b.c-1");
});

test("!N clamps past the top, not only to it", () => {
  assert.equal(ok(parseQuickAdd("!10 x")).estimate, 5);
});

test("the 8KB cap is an error, not a truncation", () => {
  assert.equal(parseQuickAdd("x".repeat(QUICKADD_MAX_BYTES + 1)).ok, false);
  assert.equal(parseQuickAdd("x".repeat(QUICKADD_MAX_BYTES)).ok, true);
});
