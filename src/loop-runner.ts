// One tick of one board's doing-loop, shared by the supervisor and POST /api/loop/tick so
// both move cards the same way. WIP=1: the next TODO goes to DOING only when DOING is empty.
import type { Db } from "./persistence/db.js";
import type { Card, LoopState } from "./shared/dto.js";
import type { EntityId, ProjectId } from "./shared/ids.js";
import { getLoop, moveCard, readBoard, saveLoop } from "./persistence/repos.js";
import { tickLoop } from "./core/loop.js";

export interface TickProjectResult {
  loop: LoopState;
  /** The card the tick named. A candidate only: it stays put when DOING is occupied. */
  nextCardId: EntityId | null;
  /** The card this tick actually moved into DOING, if any. */
  moved: Card | null;
}

/** null when the loop is not running (or the board is gone): nothing to tick. */
export function tickProject(db: Db, projectId: ProjectId, now = new Date().toISOString(), actor = "loop"): TickProjectResult | null {
  const loop = getLoop(db, projectId);
  if (loop.status !== "running") return null;
  const snapshot = readBoard(db, projectId);
  if (!snapshot) return null;
  const result = tickLoop(loop, {
    columns: snapshot.columns, cards: snapshot.cards, deps: snapshot.dependencies ?? [], now,
  });
  const doing = snapshot.columns.find(c => c.kind === "doing");
  const occupied = doing !== undefined && snapshot.cards.some(c => c.columnId === doing.id);
  const moved = result.nextCardId !== null && doing !== undefined && !occupied
    ? moveCard(db, projectId, result.nextCardId, doing.id, { actor })
    : null;
  const saved = saveLoop(db, result.state, actor, "loop.tick");
  return { loop: saved, nextCardId: result.nextCardId, moved };
}
