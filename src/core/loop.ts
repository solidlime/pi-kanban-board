// Doing-loop state machine. Each tick names the next TODO card, which the caller moves into
// DOING (WIP=1: only when DOING is empty) — that is v1's autoPick, without waking a model.
// The loop halts itself, with a reason, when no TODO is ready.
import type { Card, ColumnDef, LoopState } from "../shared/dto.js";
import type { EntityId } from "../shared/ids.js";
import { DomainError } from "../shared/errors.js";
import type { Dependency } from "./dependency.js";
import { closedLookup, openBlockersOf } from "./dependency.js";
import { sortCards } from "./card.js";

export function initialLoopState(projectId: string): LoopState {
  return {
    projectId, status: "idle", mode: "suggest",
    startedAt: null, haltedAt: null, haltReason: null,
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
}

export interface TickResult { state: LoopState; nextCardId: EntityId | null }

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
  const next = readyCards(input);
  if (next.length === 0) {
    return {
      state: stopLoop({ ...state, ticks: state.ticks + 1, lastTickAt: input.now, nextCardId: null }, input.now, "ready なカードが無い"),
      nextCardId: null,
    };
  }
  const card = next[0];
  return {
    state: { ...state, ticks: state.ticks + 1, lastTickAt: input.now, nextCardId: card.id },
    nextCardId: card.id,
  };
}
