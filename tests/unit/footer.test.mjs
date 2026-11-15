import "./_load.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const { footerLine, footerText } = await import("../../src/agent/footer.ts");

/** The overview row the API returns; every field the footer reads is explicit. */
function row(over = {}) {
  return {
    projectId: "alpha",
    name: "Alpha",
    loop: "idle",
    columns: [
      { id: "todo", name: "TODO", kind: "todo", count: 2, wipLimit: null },
      { id: "doing", name: "DOING", kind: "doing", count: 1, wipLimit: null },
      { id: "done", name: "DONE", kind: "done", count: 3, wipLimit: null },
    ],
    counts: { total: 6, open: 3, done: 9, ready: 2, blocked: 0, overdue: 0, stale: 0, wipOver: 0 },
    ...over,
  };
}

test("an empty board stays out of the footer", () => {
  assert.equal(
    footerLine(row({ counts: { total: 0, open: 0, done: 0, ready: 0, blocked: 0, overdue: 0, stale: 0, wipOver: 0 } })),
    "",
  );
});

test("the line is the web's numbers, no card list", () => {
  // counts.done is 9 here while the done column holds 3: the line counts the column.
  assert.equal(footerLine(row()), "PROJECT: alpha: todo 2 · doing 1 · done 3");
});

test("tags appear only when positive, in blocked/overdue/stale order", () => {
  const counts = { total: 6, open: 3, done: 9, ready: 2, blocked: 0, overdue: 0, stale: 0, wipOver: 0 };
  assert.equal(footerLine(row({ counts: { ...counts, blocked: 1 } })), "PROJECT: alpha: todo 2 · doing 1 · done 3 blocked 1");
  assert.equal(footerLine(row({ counts: { ...counts, overdue: 2 } })), "PROJECT: alpha: todo 2 · doing 1 · done 3 overdue 2");
  assert.equal(footerLine(row({ counts: { ...counts, stale: 3 } })), "PROJECT: alpha: todo 2 · doing 1 · done 3 stale 3");
  assert.equal(
    footerLine(row({ counts: { ...counts, stale: 1, overdue: 2, blocked: 1 } })),
    "PROJECT: alpha: todo 2 · doing 1 · done 3 blocked 1 overdue 2 stale 1",
  );
});

test("a halted loop is named last", () => {
  assert.equal(
    footerLine(row({ loop: "halted", counts: { total: 6, open: 3, done: 9, ready: 2, blocked: 0, overdue: 0, stale: 1, wipOver: 0 } })),
    "PROJECT: alpha: todo 2 · doing 1 · done 3 stale 1 HALTED",
  );
});

test("a board line is handed to the widget as a single line", () => {
  assert.deepEqual(footerText({ kind: "line", line: "PROJECT: alpha: todo 1" }, null), ["PROJECT: alpha: todo 1"]);
});

test("an empty board clears the widget and forgets the last numbers", () => {
  assert.equal(footerText({ kind: "empty" }, "PROJECT: alpha: todo 1"), undefined);
});

test("a failing API keeps the last numbers and names the failure", () => {
  assert.deepEqual(
    footerText({ kind: "api", tag: "API: 500" }, "PROJECT: alpha: todo 1"),
    ["PROJECT: alpha: todo 1 API: 500"],
  );
});

test("a failing API with no numbers yet still says something", () => {
  assert.deepEqual(footerText({ kind: "api", tag: "API: DOWN" }, null), ["KANBAN: API: DOWN"]);
});
