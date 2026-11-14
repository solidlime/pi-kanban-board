// A3 (time view) — the derivation is the logic, so it is tested directly: bars from
// due/movedAt/closedAt, and an axis that starts on a week (or month) boundary.
// The render side is guarded statically: this view must stay read-only and innerHTML-free.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ganttAxis, ganttRows, monthStart, weekStart } from "../../web/src/gantt.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-13T09:00:00Z");

/** Only the fields the projection reads; the rest of Card is irrelevant here. */
function card(over = {}) {
  return {
    projectId: "p1", id: 1, title: "c", columnId: "todo", priority: 0,
    createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", movedAt: "2026-11-01T00:00:00Z",
    closedAt: null, due: null, version: 1, ...over,
  };
}

test("gantt: closed card spans creation → closure", () => {
  const [row] = ganttRows([card({ closedAt: "2026-11-05T12:00:00Z" })], NOW);
  assert.equal(row.start, Date.parse("2026-11-01T00:00:00Z"));
  assert.equal(row.end, Date.parse("2026-11-05T12:00:00Z"));
  assert.equal(row.closed, true);
  assert.equal(row.openEnded, false);
});

test("gantt: an open card with a due date ends at the due date", () => {
  const [row] = ganttRows([card({ due: "2026-11-20" })], NOW);
  assert.equal(row.end, Date.parse("2026-11-20T00:00:00Z"), "date-only due is UTC midnight");
  assert.equal(row.due, Date.parse("2026-11-20T00:00:00Z"));
  assert.equal(row.openEnded, false);
});

test("gantt: no due and not closed ends today and is drawn open", () => {
  const [row] = ganttRows([card()], NOW);
  assert.equal(row.end, NOW);
  assert.equal(row.openEnded, true);
  assert.equal(row.closed, false);
});

test("gantt: the closure wins over the due date", () => {
  const [row] = ganttRows([card({ due: "2026-11-30", closedAt: "2026-11-10T00:00:00Z" })], NOW);
  assert.equal(row.end, Date.parse("2026-11-10T00:00:00Z"));
});

test("gantt: a due date before creation cannot make a negative bar", () => {
  const [row] = ganttRows([card({ due: "2026-10-01" })], NOW);
  assert.ok(row.end >= row.start, "end is clamped to start");
});

test("gantt: a seeded card without createdAt starts at its last move", () => {
  const [row] = ganttRows([card({ createdAt: undefined, movedAt: "2026-11-07T00:00:00Z" })], NOW);
  assert.equal(row.start, Date.parse("2026-11-07T00:00:00Z"));
});

test("gantt: rows are ordered by start, then id", () => {
  const rows = ganttRows([
    card({ id: 2, createdAt: "2026-11-08T00:00:00Z", movedAt: "2026-11-08T00:00:00Z" }),
    card({ id: 1, createdAt: "2026-11-02T00:00:00Z", movedAt: "2026-11-02T00:00:00Z" }),
    card({ id: 3, createdAt: "2026-11-02T00:00:00Z", movedAt: "2026-11-02T00:00:00Z" }),
  ], NOW);
  assert.deepEqual(rows.map(r => r.card.id), [1, 3, 2]);
});

test("gantt axis: week scale starts on a Monday and steps one day", () => {
  const rows = ganttRows([card({ due: "2026-11-20" })], NOW);
  const axis = ganttAxis(rows, "week", NOW);
  assert.equal(new Date(axis.from).getUTCDay(), 1, "from is a Monday");
  assert.equal(axis.from, weekStart(axis.from));
  assert.ok(axis.to > Date.parse("2026-11-20T00:00:00Z"), "window contains the last bar");
  assert.ok(axis.from <= Date.parse("2026-11-01T00:00:00Z"), "window contains the first bar");
  for (let i = 1; i < axis.ticks.length; i += 1) prefix(axis, i, DAY);
  assert.equal(axis.ticks.filter(t => t.major).length, (axis.to - axis.from) / (7 * DAY));
});

test("gantt axis: month scale starts on the 1st and steps one week", () => {
  const rows = ganttRows([card({ due: "2026-11-20" })], NOW);
  const axis = ganttAxis(rows, "month", NOW);
  assert.equal(axis.from, monthStart(axis.from));
  assert.equal(new Date(axis.from).getUTCDate(), 1);
  for (let i = 1; i < axis.ticks.length; i += 1) prefix(axis, i, 7 * DAY);
  for (const tick of axis.ticks) {
    if (tick.major) assert.equal(monthStart(tick.at), tick.at, "a major tick is a month start");
  }
});

test("gantt axis: an empty board still gets a readable frame", () => {
  const axis = ganttAxis([], "week", NOW);
  assert.ok(axis.to - axis.from >= 14 * DAY);
  assert.ok(axis.ticks.length >= 14);
});

// ---------------------------------------------------------------- static guards

const source = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/src/gantt.ts"), "utf8");

test("gantt: the view never writes — no API call, no drag handler, no innerHTML", () => {
  assert.ok(!/innerHTML/.test(source), "elements are built with el()/textContent");
  assert.ok(!/fetch\(|api\.js|insertAdjacentHTML/.test(source), "no request of any kind");
  assert.ok(!/dragstart|draggable|ondrop|'drop'/.test(source), "dragging must not be wired to a write");
  assert.ok(!/onSave|patchCard|moveCard/.test(source), "read-only");
});

function prefix(axis, i, step) {
  assert.equal(axis.ticks[i].at - axis.ticks[i - 1].at, step, `tick ${i} steps by ${step}ms`);
}
