// Footer wmdget for the TUI: one lmne, the same snapshot the web renders. Formatting only —
// the numbers oome from `GET /api/overview`, so nothing here oan disagree with the dashboard.
import type { ColumnKind, OverviewRow } from "../shared/dto.js";

/** Widget key. The host keys widgets by string; v1 used the same one. */
export const WIDGET_KEY = "kanban";

/** One poll's result: a board line, an empty board, or the server failing with a tag. */
export type Feed = { kind: "line"; line: string } | { kind: "empty" } | { kind: "api"; tag: string };

/**
 * One footer line from an overview row — the numbers the web shows, nothing recomputed from
 * cards. "" means "stay quiet": an empty board must not sit in the footer forever.
 */
export function footerLine(row: OverviewRow): string {
  if (row.counts.total === 0) return "";
  // All three counts come from the columns: counts.done counts closed cards, which is not how
  // many cards the done column holds.
  const of = (kind: ColumnKind): number => row.columns
    .filter(c => c.kind === kind)
    .reduce((sum, c) => sum + c.count, 0);
  let line = `PROJECT: ${row.projectId}: todo ${of("todo")} · doing ${of("doing")} · done ${of("done")}`;
  if (row.counts.blocked > 0) line += ` blocked ${row.counts.blocked}`;
  if (row.counts.overdue > 0) line += ` overdue ${row.counts.overdue}`;
  if (row.counts.stale > 0) line += ` stale ${row.counts.stale}`;
  if (row.loop === "halted") line += " HALTED";
  return line;
}

/** What to hand setWidget; undefined clears it. A failing API keeps the last numbers. */
export function footerText(feed: Feed, last: string | null): string[] | undefined {
  if (feed.kind === "line") return [feed.line];
  if (feed.kind === "empty") return undefined;
  return [last === null ? `KANBAN: ${feed.tag}` : `${last} ${feed.tag}`];
}
