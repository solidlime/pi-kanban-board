// Board-level domain operations: assemble state, run one transition, emit the event.
// Every function is pure — it returns a new state, never mutates and never persists.
import type { BoardSnapshot, Card, ColumnDef, Project } from "../shared/dto.js";
import type { EntityId, ProjectId } from "../shared/ids.js";
import type { TimelineEvent } from "../shared/events.js";
import { DomainError } from "../shared/errors.js";
import {
  createCard as buildCard, findCard, moveCard as moveCardEntity, patchCard as patchCardEntity,
  sortCards, upsertCard, assertCardVersion,
  type CardPatch, type CreateCardInput, type MoveOptions,
} from "./card.js";
import {
  assertDependencyAddable, closedLookup, makeDependency, openBlockersOf, type Dependency, type DependencyType,
} from "./dependency.js";
import { columnsByOrd, defaultColumns, findColumn } from "./project.js";
import { cardCreated, cardDeleted, cardMoved, cardUpdated, dependencyAdded, dependencyRemoved, type EventContext } from "./timeline.js";
import { domainError, isoAt, type At } from "./validation.js";

export interface BoardState {
  project: Project;
  columns: ColumnDef[];
  cards: Card[];
  dependencies: Dependency[];
}

/** A domain result: the next state, the affected entity, and the events to append. */
export interface BoardChange<T> {
  state: BoardState;
  value: T;
  events: TimelineEvent[];
}

export interface ChangeContext {
  actor?: string;
  now?: At;
  /** Project-local id allocator (the persistence layer owns the counters table). */
  allocateId?: (projectId: ProjectId) => EntityId;
  /** Expected `card.version` for optimistic locking. */
  version?: number;
}

function eventCtx(ctx: ChangeContext): EventContext {
  return { actor: ctx.actor, at: ctx.now };
}

export function makeBoard(project: Project, columns?: ColumnDef[], cards: Card[] = [], dependencies: Dependency[] = []): BoardState {
  return { project, columns: columns ? [...columns] : defaultColumns(project.projectId), cards: [...cards], dependencies: [...dependencies] };
}

export function fromSnapshot(snapshot: BoardSnapshot, dependencies: Dependency[] = []): BoardState {
  return makeBoard(snapshot.project, snapshot.columns, snapshot.cards, dependencies);
}

export function toSnapshot(state: BoardState, generation?: string): BoardSnapshot {
  const snap: BoardSnapshot = { project: state.project, columns: columnsByOrd(state.columns), cards: state.cards };
  if (generation !== undefined) snap.generation = generation;
  return snap;
}

// ---------------------------------------------------------------- column helpers

export function columnOf(state: BoardState, columnId: string): ColumnDef {
  return findColumn(state.columns, columnId);
}

/** Default landing column for a new card: the first `todo` column, else the leftmost. */
export function defaultColumnId(state: BoardState): string {
  const ordered = columnsByOrd(state.columns);
  const todo = ordered.find(c => c.kind === "todo");
  if (todo) return todo.id;
  if (ordered.length === 0) throw domainError("NOT_FOUND", "project has no columns", { projectId: state.project.projectId });
  return ordered[0].id;
}

export function cardsInColumn(state: BoardState, columnId: string): Card[] {
  return sortCards(state.cards.filter(c => c.columnId === columnId));
}

export function groupByColumn(state: BoardState): Map<string, Card[]> {
  const out = new Map<string, Card[]>();
  for (const col of columnsByOrd(state.columns)) out.set(col.id, cardsInColumn(state, col.id));
  return out;
}

/** Next free project-local id (max + 1). Persistence usually overrides via `allocateId`. */
export function nextCardId(state: BoardState): EntityId {
  return state.cards.reduce((max, c) => Math.max(max, c.id), 0) + 1;
}

// --------------------------------------------------------------------- WIP limits

export interface WipStatus { columnId: string; limit: number | null; count: number; full: boolean; remaining: number | null }

/** Current occupancy of a column. `excludeCardId` drops a card already sitting there. */
export function wipStatus(state: BoardState, columnId: string, opts: { excludeCardId?: EntityId } = {}): WipStatus {
  const col = columnOf(state, columnId);
  const count = state.cards.filter(c => c.columnId === columnId && c.id !== opts.excludeCardId).length;
  const limit = col.wipLimit ?? null;
  return { columnId, limit, count, full: limit !== null && count >= limit, remaining: limit === null ? null : Math.max(0, limit - count) };
}

/**
 * Non-throwing WIP probe: `null` when one more card may enter, else the `WIP_LIMIT` error.
 * Use it for pre-flight checks; the board operations below already enforce it.
 */
export function wipError(state: BoardState, columnId: string, opts: { excludeCardId?: EntityId } = {}): DomainError | null {
  const status = wipStatus(state, columnId, opts);
  if (status.limit === null || status.count < status.limit) return null;
  const col = columnOf(state, columnId);
  return domainError("WIP_LIMIT", `column "${col.name}" is at its WIP limit (${status.limit})`, {
    columnId, limit: status.limit, count: status.count,
  });
}

export function assertWip(state: BoardState, columnId: string, opts: { excludeCardId?: EntityId } = {}): void {
  const err = wipError(state, columnId, opts);
  if (err) throw err;
}

// -------------------------------------------------------------------- transitions

export interface AddCardRequest extends CreateCardInput {
  columnId?: string;
  /** Explicit id (tests/imports). Otherwise `allocateId`, else `nextCardId`. */
  id?: EntityId;
}

export function addCard(state: BoardState, req: AddCardRequest, ctx: ChangeContext = {}): BoardChange<Card> {
  const columnId = req.columnId ?? defaultColumnId(state);
  const target = columnOf(state, columnId);
  assertWip(state, target.id);
  const id = req.id ?? ctx.allocateId?.(state.project.projectId) ?? nextCardId(state);
  if (state.cards.some(c => c.id === id)) throw domainError("CONFLICT", `card #${id} already exists`, { id });
  const card = buildCard(state.project.projectId, id, target.id, req, { now: ctx.now });
  return { state: { ...state, cards: upsertCard(state.cards, card) }, value: card, events: [cardCreated(card, eventCtx(ctx))] };
}

export function patchCardIn(state: BoardState, id: EntityId, patch: CardPatch, ctx: ChangeContext = {}): BoardChange<Card> {
  const card = findCard(state.cards, id);
  assertCardVersion(card, ctx.version);
  const result = patchCardEntity(card, patch, { now: ctx.now });
  if (result.changed.length === 0) return { state, value: card, events: [] };
  return {
    state: { ...state, cards: upsertCard(state.cards, result.card) },
    value: result.card,
    events: [cardUpdated(result.card, result.changed, eventCtx(ctx))],
  };
}

export interface MoveCardOptions extends ChangeContext, MoveOptions { position?: number }

/** Moving into the current column is a no-op (no version bump, no event). */
export function moveCardIn(state: BoardState, id: EntityId, columnId: string, opts: MoveCardOptions = {}): BoardChange<Card> {
  const card = findCard(state.cards, id);
  assertCardVersion(card, opts.version);
  const target = columnOf(state, columnId);
  if (target.id === card.columnId) return { state, value: card, events: [] };
  assertWip(state, target.id, { excludeCardId: card.id });
  const moved = moveCardEntity(card, target, { now: opts.now, requireAcceptance: opts.requireAcceptance });
  return {
    state: { ...state, cards: upsertCard(state.cards, moved) },
    value: moved,
    events: [cardMoved(moved, card.columnId, eventCtx(opts))],
  };
}

/** Domain delete: the card and every edge touching it disappear from the state. */
export function deleteCardIn(state: BoardState, id: EntityId, ctx: ChangeContext = {}): BoardChange<{ id: EntityId }> {
  const card = findCard(state.cards, id);
  assertCardVersion(card, ctx.version);
  return {
    state: {
      ...state,
      cards: state.cards.filter(c => c.id !== card.id),
      dependencies: state.dependencies.filter(d => d.fromCard !== card.id && d.toCard !== card.id),
    },
    value: { id: card.id },
    events: [cardDeleted(card, eventCtx(ctx))],
  };
}

export function addDependencyIn(state: BoardState, fromCard: EntityId, toCard: EntityId, type: DependencyType = "blocks", ctx: ChangeContext = {}): BoardChange<Dependency> {
  findCard(state.cards, fromCard);
  findCard(state.cards, toCard);
  assertDependencyAddable(state.dependencies, fromCard, toCard, type);
  const dep = makeDependency(state.project.projectId, fromCard, toCard, type);
  return {
    state: { ...state, dependencies: [...state.dependencies, dep] },
    value: dep,
    events: [dependencyAdded(dep, eventCtx(ctx))],
  };
}

export function removeDependencyIn(state: BoardState, fromCard: EntityId, toCard: EntityId, type: DependencyType = "blocks", ctx: ChangeContext = {}): BoardChange<Dependency> {
  const dep = state.dependencies.find(d => d.fromCard === fromCard && d.toCard === toCard && d.type === type);
  if (!dep) throw domainError("NOT_FOUND", `dependency ${fromCard} ${type} ${toCard} does not exist`, { fromCard, toCard, type });
  return {
    state: { ...state, dependencies: state.dependencies.filter(d => d !== dep) },
    value: dep,
    events: [dependencyRemoved(dep, eventCtx(ctx))],
  };
}

// -------------------------------------------------------------------- derivations

/** Blockers of the card that are not done yet, ascending. */
export function blockedBy(state: BoardState, cardId: EntityId): EntityId[] {
  return openBlockersOf(state.dependencies, cardId, closedLookup(state.cards));
}

/** Manual block (`blockedReason` set) or at least one open blocker. */
export function isBlocked(state: BoardState, cardId: EntityId): boolean {
  const card = findCard(state.cards, cardId);
  if (card.blockedReason) return true;
  return blockedBy(state, cardId).length > 0;
}

/** Open, not in a `done` column, unblocked — i.e. work that can start now. */
export function isReady(state: BoardState, card: Card): boolean {
  if (card.closedAt !== null && card.closedAt !== undefined) return false;
  if (columnOf(state, card.columnId).kind === "done") return false;
  return !isBlocked(state, card.id);
}

export function readyCards(state: BoardState): Card[] {
  return sortCards(state.cards.filter(c => isReady(state, c)));
}

/** Normalized "now" for a caller that needs the same clock value twice. */
export function nowIso(now?: At): string {
  return isoAt(now);
}
