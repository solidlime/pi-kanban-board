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
  /** "halted" when this tick stopped the loop (stuck card, no ready card, budget spent). */
  reason: "halted" | null;
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
    const saved = saveLoop(db, stopLoop(loop, now, reason), actor, "loop.halted");
    return { loop: saved, nextCardId: null, moved: null, reason: "halted" };
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
  const saved = saveLoop(db, result.state, actor, "loop.tick");
  return { loop: saved, nextCardId: result.nextCardId, moved, reason: result.reason };
}
