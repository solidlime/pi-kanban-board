// Period digest: one Markdown page a human can read without opening the board.
// Pure — rows in, Markdown out. The clock is a parameter, so a test never waits a week.
import type { Card, ColumnDef, Deliverable } from "../shared/dto.js";
import type { TimelineEvent } from "../shared/events.js";
import { DomainError } from "../shared/errors.js";

export interface DigestInput {
  projectId: string;
  projectName: string;
  /** Inclusive lower bound, ISO. */
  since: string;
  /** Exclusive upper bound, ISO (normally "now"). */
  until: string;
  columns: readonly ColumnDef[];
  cards: readonly Card[];
  /** Card timeline events inside the period; only card.moved into a done column counts. */
  events: readonly TimelineEvent[];
  /** Deliverables created inside the period. */
  deliverables: readonly Deliverable[];
}

export interface DigestCounts { done: number; deliverables: number; commits: number }
export interface Digest {
  projectId: string;
  since: string;
  until: string;
  counts: DigestCounts;
  markdown: string;
}

const RELATIVE = /^(\d+)([dhm])$/;
const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000 };
export const DEFAULT_SINCE = "7d";

/** `7d` / `36h` / `30m` or an ISO stamp; absent means 7d. Anything else is a 422. */
export function parseSince(raw: string | null | undefined, now: Date = new Date()): string {
  const s = (raw ?? "").trim();
  if (s === "") return new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const m = RELATIVE.exec(s);
  if (m) {
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0) throw badSince(s);
    return new Date(now.getTime() - n * UNIT_MS[m[2]]).toISOString();
  }
  // Only a full ISO stamp is accepted: Date.parse("7") is a date in V8, which would turn a
  // missing unit into a silent 2001 window.
  const at = /^\d{4}-\d{2}-\d{2}/.test(s) ? Date.parse(s) : NaN;
  if (Number.isNaN(at)) throw badSince(s);
  return new Date(at).toISOString();
}

const badSince = (raw: string): DomainError =>
  new DomainError("VALIDATION", `since must be an ISO timestamp or a window like 7d / 36h (got "${raw}")`, { field: "since" });

const line = (parts: (string | null | undefined)[], sep = " "): string =>
  parts.filter(p => p !== null && p !== undefined && p !== "").join(sep);

/** Done transitions in the period, one line per card (the latest move wins). */
function doneLines(input: DigestInput): string[] {
  const doneCols = new Set(input.columns.filter(c => c.kind === "done").map(c => c.id));
  const titles = new Map(input.cards.map(c => [c.id, c.title]));
  const at = new Map<number, string>();
  for (const e of input.events) {
    if (e.kind !== "card.moved") continue;
    const payload = (e.payload ?? {}) as { id?: unknown; to?: unknown };
    if (!doneCols.has(String(payload.to))) continue;
    const id = Number(payload.id);
    if (!Number.isInteger(id)) continue;
    const prev = at.get(id);
    if (prev === undefined || prev < e.at) at.set(id, e.at);
  }
  return [...at.entries()]
    .sort((a, b) => a[1].localeCompare(b[1]) || a[0] - b[0])
    .map(([id, when]) => `- #${id} ${titles.get(id) ?? "（削除済み）"}（${when}）`);
}

function section(title: string, body: string[]): string[] {
  return [`## ${title}`, ...(body.length === 0 ? ["- なし"] : body), ""];
}

export function buildDigest(input: DigestInput): Digest {
  const done = doneLines(input);
  const deliverables = input.deliverables
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id)
    .map(d => `- ${line([d.title, d.ref === "" ? "" : `— ${d.ref}`], " ")}`);
  // A commit belongs to the period when the card it sits on was touched inside it.
  const commits = input.cards
    .filter(c => c.commit && c.updatedAt >= input.since && c.updatedAt <= input.until)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id - b.id)
    .map(c => `- #${c.id} ${c.commit} ${c.title}`);

  const counts: DigestCounts = { done: done.length, deliverables: deliverables.length, commits: commits.length };
  const markdown = [
    `# ${input.projectName} ダイジェスト`,
    "",
    `期間: ${input.since} → ${input.until}`,
    `完了 ${counts.done} · 成果物 ${counts.deliverables} · コミット ${counts.commits}`,
    "",
    ...section("完了", done),
    ...section("成果物", deliverables),
    ...section("コミット", commits),
  ].join("\n").trimEnd() + "\n";
  return { projectId: input.projectId, since: input.since, until: input.until, counts, markdown };
}
