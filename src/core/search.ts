// Board search across cards and deliverables. Pure and case-insensitive.
// `#12` is an id lookup (card or deliverable); anything else is a substring match.
import type { Card, ColumnDef, Deliverable, SearchHit } from "../shared/dto.js";
import { sortCards } from "./card.js";

export interface SearchInput {
  projectId: string;
  columns: readonly ColumnDef[];
  cards: readonly Card[];
  deliverables?: readonly Deliverable[];
  q: string;
  limit?: number;
}

const SNIPPET_PAD = 40;

function snippetOf(haystack: string, needle: string): string {
  const at = haystack.toLowerCase().indexOf(needle);
  if (at < 0) return "";
  const from = Math.max(0, at - SNIPPET_PAD);
  const to = Math.min(haystack.length, at + needle.length + SNIPPET_PAD);
  return `${from > 0 ? "…" : ""}${haystack.slice(from, to).trim()}${to < haystack.length ? "…" : ""}`;
}

function idQuery(q: string): number | null {
  const m = /^#?(\d{1,9})$/.exec(q);
  return m ? Number(m[1]) : null;
}

/**
 * Score: 0 exact id, 1 title/name hit, 2 body/ref hit. Ties break on project, then id.
 * The column of a card is carried so the UI can show where the hit lives.
 */
export function searchBoard(input: SearchInput): SearchHit[] {
  const q = input.q.trim();
  const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 50)));
  if (q === "") return [];
  const needle = q.toLowerCase();
  const id = idQuery(q);
  const scored: { hit: SearchHit; score: number }[] = [];

  for (const card of sortCards(input.cards)) {
    const title = card.title ?? "";
    const body = card.body ?? "";
    const owner = card.owner ?? "";
    const labels = (card.labels ?? []).join(" ");
    const haystack = [title, body, owner, labels].filter(s => s !== "").join("\n");
    let score: number | null = null;
    if (id !== null && card.id === id) score = 0;
    else if (title.toLowerCase().includes(needle)) score = 1;
    else if (haystack.toLowerCase().includes(needle)) score = 2;
    if (score === null) continue;
    const closed = card.closedAt !== null && card.closedAt !== undefined;
    scored.push({
      score,
      hit: {
        projectId: input.projectId, type: "card", id: card.id, title, columnId: card.columnId, closed,
        snippet: score === 1 ? title : snippetOf(haystack, needle),
      },
    });
  }

  for (const d of input.deliverables ?? []) {
    const title = d.title ?? "";
    const ref = d.ref ?? "";
    const haystack = ref === "" ? title : `${title}\n${ref}`;
    let score: number | null = null;
    if (id !== null && d.id === id) score = 0;
    else if (title.toLowerCase().includes(needle)) score = 1;
    else if (haystack.toLowerCase().includes(needle)) score = 2;
    if (score === null) continue;
    scored.push({
      score,
      hit: {
        projectId: input.projectId, type: "deliverable", id: d.id, title,
        cardId: d.cardId ?? null, snippet: score === 1 ? ref || title : snippetOf(haystack, needle),
      },
    });
  }

  return scored
    .sort((a, b) => a.score - b.score || a.hit.projectId.localeCompare(b.hit.projectId) || a.hit.id - b.hit.id)
    .slice(0, limit)
    .map(s => s.hit);
}
