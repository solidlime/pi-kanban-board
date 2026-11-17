// Doing-loop state machine. Each tick names the next TODO card, which the caller moves into
// DOING (WIP=1: only when DOING is empty) — that is v1's autoPick, without waking a model.
// A tick with no ready TODO names nothing and just counts: an empty board is not a reason to stop.
// Only an explicit stop, the tick budget, or a stuck DOING card halts the loop.
import type { Card, ColumnDef, LoopState } from "../shared/dto.js";
import type { EntityId } from "../shared/ids.js";
import { DomainError } from "../shared/errors.js";
import type { Dependency } from "./dependency.js";
import { closedLookup, openBlockersOf } from "./dependency.js";
import { sortCards } from "./card.js";

/** A board is born started: halting is something someone does, not the default. `now` is passed
 *  in — no clock in core; the caller owns time. */
export function initialLoopState(projectId: string, now: string): LoopState {
  return {
    projectId, status: "running", mode: "suggest",
    startedAt: now, haltedAt: null, haltReason: null,
    lastTickAt: null, ticks: 0, nextCardId: null,
  };
}

export function startLoop(state: LoopState, now: string): LoopState {
  return { ...state, status: "running", startedAt: now, haltedAt: null, haltReason: null };
}

/** Stopping is a halt with a reason: "why did it stop" is the question people ask later. */
export function stopLoop(state: LoopState, now: string, reason = "stopped manually"): LoopState {
  return { ...state, status: "halted", haltedAt: now, haltReason: reason };
}

export interface TickInput {
  columns: readonly ColumnDef[];
  cards: readonly Card[];
  deps: readonly Dependency[];
  now: string;
  /** Tick budget from loop.settings: 0 (or absent) is unlimited, v1 #67's cap. */
  maxLoops?: number;
}

export interface TickResult {
  state: LoopState;
  nextCardId: EntityId | null;
  /** "halted" when this tick stopped the loop, so a caller can log it without unpacking state. */
  reason: "halted" | null;
}

/** A TODO-column card with no open blocker (manual `blockedReason` does not count: it is a note). */
function readyCards(input: TickInput): Card[] {
  const todoCols = new Set(input.columns.filter(c => c.kind === "todo").map(c => c.id));
  const isDone = closedLookup(input.cards);
  return sortCards(input.cards.filter(c => todoCols.has(c.columnId)
    && openBlockersOf(input.deps, c.id, isDone).length === 0));
}

export function tickLoop(state: LoopState, input: TickInput): TickResult {
  if (state.status !== "running") {
    throw new DomainError("CONFLICT", `loop is ${state.status}: start it before ticking`, { status: state.status });
  }
  const cap = input.maxLoops ?? 0;
  // `ticks` is the heartbeat, not "cards picked": an empty tick counts too, so a budgeted board
  // stops maxLoops heartbeats in, not maxLoops cards later. Pinned in tests/unit/core-loop.test.mjs.
  if (cap > 0 && state.ticks >= cap) {
    return { state: stopLoop({ ...state, nextCardId: null }, input.now, "maxLoops に達した"), nextCardId: null, reason: "halted" };
  }
  const next = readyCards(input);
  if (next.length === 0) {
    return {
      state: { ...state, ticks: state.ticks + 1, lastTickAt: input.now, nextCardId: null },
      nextCardId: null, reason: null,
    };
  }
  const card = next[0];
  return {
    state: { ...state, ticks: state.ticks + 1, lastTickAt: input.now, nextCardId: card.id },
    nextCardId: card.id, reason: null,
  };
}

/**
 * The DOING card that has not moved for `stuckDays` whole days, with that count. The clock is
 * `movedAt`, not `updatedAt`: a wake writes sessionId and a note rewrites blockedReason, and
 * either would make a card that has sat in DOING for a week look fresh. `createdAt` covers a
 * row whose movedAt is unreadable. 0 days (or less) turns the check off, like v1's unlimited cap.
 */
export function stuckDoingCard(
  cards: readonly Card[], doingColumnId: string, now: string, stuckDays: number,
): { card: Card; days: number } | null {
  if (!(stuckDays > 0)) return null;
  const nowMs = Date.parse(now);
  for (const card of cards) {
    if (card.columnId !== doingColumnId) continue;
    const days = Math.floor((nowMs - Date.parse(card.movedAt || card.createdAt)) / 86_400_000);
    if (days >= stuckDays) return { card, days };
  }
  return null;
}
