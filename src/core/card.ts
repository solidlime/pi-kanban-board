// Card entity: construction, patching, column moves, completion predicates.
// `closedAt` is derived from the column kind: entering a `done` column closes the card,
// leaving one reopens it.
import type { Card, ColumnDef } from "../shared/dto.js";
import type { EntityId, ProjectId } from "../shared/ids.js";
import { isAcceptanceComplete } from "./acceptance.js";
import {
  assertBlockedReason, assertBody, assertDue, assertEstimate, assertId, assertLabels, assertOwner,
  assertPriority, assertTitle, assertVersion, DEFAULT_PRIORITY, domainError, isoAt, type At,
} from "./validation.js";

export interface CreateCardInput {
  title: string;
  body?: string;
  priority?: number;
  owner?: string | null;
  due?: string | null;
  estimate?: number | null;
  labels?: string[];
  sessionId?: string | null;
  /** Commit sha this card was opened for. */
  commit?: string | null;
  blockedReason?: string | null;
}

/** Fresh card, `version: 1`, timestamps equal. `id` is resolved by the caller (board/allocator). */
export function createCard(projectId: ProjectId, id: EntityId, columnId: string, input: CreateCardInput, opts: { now?: At } = {}): Card {
  const ts = isoAt(opts.now);
  return {
    projectId,
    id: assertId(id),
    columnId,
    title: assertTitle(input.title),
    body: assertBody(input.body),
    priority: input.priority === undefined ? DEFAULT_PRIORITY : assertPriority(input.priority),
    owner: assertOwner(input.owner),
    due: assertDue(input.due),
    estimate: assertEstimate(input.estimate),
    blockedReason: assertBlockedReason(input.blockedReason),
    labels: assertLabels(input.labels),
    sessionId: input.sessionId ?? null,
    commit: input.commit ?? null,
    createdAt: ts,
    updatedAt: ts,
    movedAt: ts,
    closedAt: null,
    version: 1,
  };
}

export interface CardPatch {
  title?: string;
  body?: string;
  priority?: number;
  owner?: string | null;
  due?: string | null;
  estimate?: number | null;
  labels?: string[];
  blockedReason?: string | null;
  sessionId?: string | null;
  commit?: string | null;
}

export interface PatchResult { card: Card; changed: string[] }

/**
 * Applies a partial update. Nothing changed -> same card, `changed: []`, version untouched,
 * so callers can skip the timeline event.
 */
export function patchCard(card: Card, patch: CardPatch, opts: { now?: At; version?: number } = {}): PatchResult {
  assertVersion(card.version);
  if (opts.version !== undefined && opts.version !== card.version) {
    throw domainError("STALE_VERSION", `card #${card.id} is at version ${card.version}`, { id: card.id, expected: opts.version, actual: card.version });
  }
  const next: Card = { ...card };
  const changed: string[] = [];
  const set = <K extends keyof Card>(key: K, value: Card[K]) => {
    if (next[key] !== value) { next[key] = value; changed.push(key as string); }
  };

  if (patch.title !== undefined) set("title", assertTitle(patch.title));
  if (patch.body !== undefined) set("body", assertBody(patch.body));
  if (patch.priority !== undefined) set("priority", assertPriority(patch.priority));
  if (patch.owner !== undefined) set("owner", assertOwner(patch.owner));
  if (patch.due !== undefined) set("due", assertDue(patch.due));
  if (patch.estimate !== undefined) set("estimate", assertEstimate(patch.estimate));
  if (patch.blockedReason !== undefined) set("blockedReason", assertBlockedReason(patch.blockedReason));
  if (patch.sessionId !== undefined) set("sessionId", patch.sessionId ?? null);
  if (patch.commit !== undefined) set("commit", patch.commit ?? null);
  if (patch.labels !== undefined) {
    const labels = assertLabels(patch.labels);
    if (JSON.stringify(labels) !== JSON.stringify(card.labels ?? [])) { next.labels = labels; changed.push("labels"); }
  }

  if (changed.length === 0) return { card, changed };
  next.updatedAt = isoAt(opts.now);
  next.version = card.version + 1;
  return { card: next, changed };
}

export interface MoveOptions {
  now?: At;
  version?: number;
  /** Refuse the move if the card still has unchecked acceptance criteria. */
  requireAcceptance?: boolean;
}

/**
 * Moves a card into `target`. Same column = no-op (returns the card untouched so
 * `movedAt` stays meaningful). `closedAt` is set on the first move into a `done` column
 * and cleared when leaving one.
 */
export function moveCard(card: Card, target: ColumnDef, opts: MoveOptions = {}): Card {
  if (opts.version !== undefined && opts.version !== card.version) {
    throw domainError("STALE_VERSION", `card #${card.id} is at version ${card.version}`, { id: card.id, expected: opts.version, actual: card.version });
  }
  if (target.id === card.columnId) return card;
  if (opts.requireAcceptance && target.kind === "done" && !isAcceptanceComplete(card)) {
    throw domainError("VALIDATION", `card #${card.id} has unchecked acceptance criteria`, { id: card.id });
  }
  const ts = isoAt(opts.now);
  return {
    ...card,
    columnId: target.id,
    movedAt: ts,
    updatedAt: ts,
    closedAt: target.kind === "done" ? (card.closedAt ?? ts) : null,
    version: card.version + 1,
  };
}

/** True once the card has entered a `done` column. */
export function isClosed(card: Pick<Card, "closedAt">): boolean {
  return card.closedAt !== null && card.closedAt !== undefined;
}

/** Closed *and* every acceptance criterion checked (cards without criteria: vacuously ok). */
export function isComplete(card: Pick<Card, "closedAt" | "body">): boolean {
  return isClosed(card) && isAcceptanceComplete(card);
}

export function isOverdue(card: Pick<Card, "due" | "closedAt">, today = new Date()): boolean {
  if (!card.due || isClosed(card)) return false;
  return card.due < today.toISOString().slice(0, 10);
}

/** Optimistic-lock check; `undefined` expected version = unconditional. */
export function assertCardVersion(card: Pick<Card, "id" | "version">, expected?: number): void {
  if (expected === undefined) return;
  if (expected !== card.version) {
    throw domainError("STALE_VERSION", `card #${card.id} is at version ${card.version}`, { id: card.id, expected, actual: card.version });
  }
}

export function findCard(cards: readonly Card[], id: EntityId): Card {
  const card = cards.find(c => c.id === id);
  if (!card) throw domainError("NOT_FOUND", `card #${id} does not exist`, { id });
  return card;
}

/** Board order: priority descending, then id ascending (stable and deterministic). */
export function sortCards(cards: readonly Card[]): Card[] {
  return [...cards].sort((a, b) => b.priority - a.priority || a.id - b.id);
}

/** Replaces (or appends) one card, returning a new array. */
export function upsertCard(cards: readonly Card[], card: Card): Card[] {
  const i = cards.findIndex(c => c.id === card.id);
  if (i < 0) return [...cards, card];
  const out = [...cards];
  out[i] = card;
  return out;
}
