// Acceptance criteria live inside the card body as a markdown checklist:
//   - [ ] not done
//   - [x] done
// That keeps the dto/Card shape untouched (body only) while giving the UI and the
// domain one shared, greppable representation.
import type { Card } from "../shared/dto.js";

export interface AcceptanceItem { text: string; done: boolean }
export interface AcceptanceProgress { total: number; done: number; complete: boolean }

const ITEM_RE = /^\s{0,3}[-*]\s+\[([ xX])\]\s+(\S.*?)\s*$/;
const FENCE_RE = /^\s{0,3}(?:```|~~~)/;

/** Parses checklist items, ignoring anything inside fenced code blocks. */
export function parseAcceptance(body: string | undefined | null): AcceptanceItem[] {
  if (!body) return [];
  const items: AcceptanceItem[] = [];
  let fenced = false;
  for (const line of body.split(/\r?\n/)) {
    if (FENCE_RE.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const m = ITEM_RE.exec(line);
    if (m) items.push({ text: m[2], done: m[1].toLowerCase() === "x" });
  }
  return items;
}

export function acceptanceProgress(body: string | undefined | null): AcceptanceProgress {
  const items = parseAcceptance(body);
  const done = items.filter(i => i.done).length;
  return { total: items.length, done, complete: done === items.length };
}

export function hasAcceptance(card: Pick<Card, "body">): boolean {
  return parseAcceptance(card.body).length > 0;
}

/** Vacuously true when a card declares no criteria. */
export function isAcceptanceComplete(card: Pick<Card, "body">): boolean {
  return acceptanceProgress(card.body).complete;
}

/** Appends one checklist line to a body, keeping a blank line before it. */
export function appendAcceptance(body: string | undefined | null, item: AcceptanceItem | string, done = false): string {
  const value: AcceptanceItem = typeof item === "string" ? { text: item, done } : item;
  const line = `- [${value.done ? "x" : " "}] ${value.text.trim()}`;
  const base = (body ?? "").replace(/\s+$/, "");
  return base === "" ? line : `${base}\n${line}`;
}
