// One tick of one board's doing-loop, shared by the supervisor and POST /api/loop/tick so
// both move cards the same way. WIP=1: the next TODO goes to DOING only when DOING is empty.
import type { Db } from "./persistence/db.js";
import type { Card, LoopState } from "./shared/dto.js";
import type { EntityId, ProjectId } from "./shared/ids.js";
import { getLoop, getLoopSettings, moveCard, readBoard, saveLoop } from "./persistence/repos.js";
import { stopLoop, stuckDoingCard, tickLoop } from "./core/loop.js";

export interface TickProjectResult {
  loop: LoopState;
  /** The card the tick named. A candidate only: it stays put when DOING is occupied. */
  nextCardId: EntityId | null;
  /** The card this tick actually moved into DOING, if any. */
  moved: Card | null;
  /** "halted" when this tick stopped the loop (stuck card, budget spent). An empty board does
   *  not halt: it keeps counting. */
  reason: "halted" | null;
  /** Who is in DOING when this tick ends — moved now, or left over from an earlier tick. The
   *  supervisor wakes this card: a card can sit here with no writer (a wake that refused, a
   *  process that died, a restart), and nothing else in the system would retry it. */
  doingCardId: EntityId | null;
}

/** null when the loop is not running (or the board is gone): nothing to tick. */
export function tickProject(db: Db, projectId: ProjectId, now = new Date().toISOString(), actor = "loop"): TickProjectResult | null {
  const loop = getLoop(db, projectId);
  if (loop.status !== "running") return null;
  // No lastActor here: this tick never reads it, and the GROUP BY is a full timeline scan.
  const snapshot = readBoard(db, projectId, { withActors: false });
  if (!snapshot) return null;
  const settings = getLoopSettings(db);
  const doing = snapshot.columns.find(c => c.kind === "doing");
  // A DOING card that has not moved for `stuckDays` stops the board: moving on would bury it.
  const stuck = doing === undefined ? null : stuckDoingCard(snapshot.cards, doing.id, now, settings.stuckDays);
  if (stuck) {
    const reason = `DOING の #${stuck.card.id} が ${stuck.days} 日動いていない`;
    // Stuck returns before the tick's kind is chosen below, so this literal is its own record:
    // it is what the stuck test pins, not the `loop.halted` branch of that ternary.
    const saved = saveLoop(db, stopLoop(loop, now, reason), actor, "loop.halted");
    return { loop: saved, nextCardId: null, moved: null, reason: "halted", doingCardId: stuck.card.id };
  }
  const result = tickLoop(loop, {
    columns: snapshot.columns, cards: snapshot.cards, deps: snapshot.dependencies ?? [], now, maxLoops: settings.maxLoops,
  });
  // Display only: moveCard is the one that decides, inside its own transaction. The catch is for
  // the race this read cannot close — the loser of two ticks reports "nothing moved", not a torn tick.
  const occupied = doing !== undefined && snapshot.cards.some(c => c.columnId === doing.id);
  let moved: Card | null = null;
  if (result.nextCardId !== null && doing !== undefined && !occupied) {
    try {
      moved = moveCard(db, projectId, result.nextCardId, doing.id, { actor });
    } catch (err) {
      if ((err as { code?: string }).code !== "WIP_LIMIT") throw err;
    }
  }
  const quiet = moved === null && result.reason === null;
  // A tick that moved nothing and halted nothing is the steady state of an empty board: it saves
  // the clock but is not an event. Recording it every 15s would grow the timeline forever.
  const kind = quiet ? null : result.reason === "halted" ? "loop.halted" : "loop.tick";
  const saved = saveLoop(db, result.state, actor, kind);
  const standing = doing === undefined ? undefined : snapshot.cards.find(c => c.columnId === doing.id);
  return { loop: saved, nextCardId: result.nextCardId, moved, reason: result.reason, doingCardId: moved?.id ?? standing?.id ?? null };
}
