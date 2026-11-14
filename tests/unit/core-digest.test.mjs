// A3: the digest is one pure Markdown page for a period — done transitions, deliverables
// and commits. No DB, no clock of its own: `now` is an argument.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadShared } from "./_load.mjs";

const digest = await import("../../src/core/digest.ts");
const { buildDigest, parseSince } = digest;
const { DomainError } = await loadShared();

const columns = [
  { projectId: "p", id: "todo", name: "TODO", kind: "todo", ord: 0, wipLimit: null },
  { projectId: "p", id: "done", name: "DONE", kind: "done", ord: 1, wipLimit: null },
];

const card = (id, title, extra = {}) => ({
  projectId: "p", id, columnId: "done", title, priority: 0,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-05T00:00:00.000Z",
  movedAt: "2026-01-05T00:00:00.000Z", version: 2, ...extra,
});

const moved = (id, to, at) => ({
  projectId: "p", seq: 1, entityType: "card", entityId: `p#${id}`, kind: "card.moved",
  actor: "ui", payload: { id, from: "todo", to, version: 2 }, at,
});

test("buildDigest renders only in-period done transitions, deliverables and commits", () => {
  const out = buildDigest({
    projectId: "p", projectName: "Demo",
    since: "2026-01-05T00:00:00.000Z", until: "2026-01-12T00:00:00.000Z",
    columns,
    cards: [
      card(1, "shipped one", { commit: "abc1234" }),
      card(2, "shipped two"),
      card(3, "left in todo", { columnId: "todo", commit: null }),
    ],
    events: [
      moved(1, "done", "2026-01-06T00:00:00.000Z"),
      moved(2, "done", "2026-01-07T00:00:00.000Z"),
      moved(3, "todo", "2026-01-07T00:00:00.000Z"), // not a done transition
    ],
    deliverables: [
      { projectId: "p", id: 4, title: "screenshot", ref: "out.png", kind: "note", createdAt: "2026-01-08T00:00:00.000Z", updatedAt: "2026-01-08T00:00:00.000Z" },
    ],
  });

  assert.equal(out.projectId, "p");
  assert.deepEqual(out.counts, { done: 2, deliverables: 1, commits: 1 });
  assert.match(out.markdown, /^# Demo ダイジェスト/m);
  assert.match(out.markdown, /- #1 shipped one/);
  assert.match(out.markdown, /- #2 shipped two/);
  assert.doesNotMatch(out.markdown, /left in todo/);
  assert.match(out.markdown, /- screenshot — out\.png/);
  assert.match(out.markdown, /abc1234/);
  assert.match(out.markdown, /2026-01-05T00:00:00\.000Z → 2026-01-12T00:00:00\.000Z/);
});

test("buildDigest says so when a section is empty, and names a deleted card by id", () => {
  const out = buildDigest({
    projectId: "p", projectName: "Demo",
    since: "2026-01-05T00:00:00.000Z", until: "2026-01-12T00:00:00.000Z",
    columns, cards: [], events: [moved(9, "done", "2026-01-09T00:00:00.000Z")], deliverables: [],
  });
  assert.deepEqual(out.counts, { done: 1, deliverables: 0, commits: 0 });
  assert.match(out.markdown, /- #9 /, "a deleted card still appears, by id");
  assert.equal(out.markdown.match(/- なし/g)?.length, 2, "deliverables and commits are empty");
});

test("parseSince accepts an ISO stamp and a Nd window, and refuses anything else", () => {
  const now = new Date("2026-01-12T00:00:00.000Z");
  assert.equal(parseSince("2026-01-05T00:00:00.000Z", now), "2026-01-05T00:00:00.000Z");
  assert.equal(parseSince("7d", now), "2026-01-05T00:00:00.000Z");
  assert.equal(parseSince("36h", now), "2026-01-10T12:00:00.000Z");
  assert.equal(parseSince(undefined, now), "2026-01-05T00:00:00.000Z", "absent means 7d");
  assert.equal(parseSince("", now), "2026-01-05T00:00:00.000Z");
  for (const bad of ["7", "d", "-1d", "0d", "2026-13-40", "yesterday"]) {
    assert.throws(() => parseSince(bad, now), (err) => err instanceof DomainError && err.code === "VALIDATION", `should reject ${bad}`);
  }
});
