// Alerts derived from board state. Pure: no DB, no clock beyond the `now` passed in.
// These are the things a human would want to hear about without opening every card.
import type { Card, ColumnDef, LoopState, Notification, NotificationLevel } from "../shared/dto.js";
import type { Dependency } from "./dependency.js";
import { closedLookup, openBlockersOf } from "./dependency.js";
import { acceptanceProgress } from "./acceptance.js";
import { sortCards } from "./card.js";

export const STALE_DAYS = 30;

export interface NotifyInput {
  projectId: string;
  columns: readonly ColumnDef[];
  cards: readonly Card[];
  deps?: readonly Dependency[];
  loop?: LoopState | null;
  /** ISO timestamp; only the date part is used for "overdue". */
  now?: string;
  staleDays?: number;
}

const LEVEL_RANK: Record<NotificationLevel, number> = { danger: 0, warn: 1, info: 2 };

const daysBetween = (fromIso: string, toIso: string): number => {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.floor((to - from) / 86_400_000);
};

/**
 * Rules, in one pass:
 *   overdue   open card whose `due` date is in the past            (danger)
 *   blocked   open card with a manual block reason                  (warn)
 *   deps      open card with blockers that are still open           (warn)
 *   wip       column over its WIP limit                             (danger)
 *   acceptance done card with unchecked acceptance items            (warn)
 *   stale     open card untouched for `staleDays` (default 30)     (info)
 *   loop      loop halted with a reason                             (warn)
 */
export function notifications(input: NotifyInput): Notification[] {
  const now = input.now ?? new Date().toISOString();
  const today = now.slice(0, 10);
  const staleDays = input.staleDays ?? STALE_DAYS;
  const out: Notification[] = [];
  const isDone = closedLookup(input.cards);
  const open = input.cards.filter(c => !isDone(c.id));

  for (const card of sortCards(open)) {
    if (card.due && card.due < today) {
      out.push({ projectId: input.projectId, kind: "overdue", level: "danger", cardId: card.id, title: card.title, detail: `期限 ${card.due}` });
    }
    if (card.blockedReason) {
      out.push({ projectId: input.projectId, kind: "blocked", level: "warn", cardId: card.id, title: card.title, detail: card.blockedReason });
    }
    const blockers = openBlockersOf(input.deps ?? [], card.id, isDone);
    if (blockers.length > 0) {
      out.push({
        projectId: input.projectId, kind: "deps", level: "warn", cardId: card.id, title: card.title,
        detail: `#${blockers.join(", #")} の完了待ち`,
      });
    }
    if (staleDays > 0 && daysBetween(card.updatedAt, now) >= staleDays) {
      out.push({ projectId: input.projectId, kind: "stale", level: "info", cardId: card.id, title: card.title, detail: `${daysBetween(card.updatedAt, now)} 日更新なし` });
    }
  }

  for (const col of input.columns) {
    const limit = col.wipLimit ?? null;
    if (limit === null) continue;
    const count = input.cards.filter(c => c.columnId === col.id).length;
    if (count > limit) {
      out.push({ projectId: input.projectId, kind: "wip", level: "danger", columnId: col.id, title: col.name, detail: `WIP ${count}/${limit}` });
    }
  }

  for (const card of input.cards) {
    if (!isDone(card.id)) continue;
    const { total, done } = acceptanceProgress(card.body ?? "");
    if (total > 0 && done < total) {
      out.push({ projectId: input.projectId, kind: "acceptance", level: "warn", cardId: card.id, title: card.title, detail: `完了条件 ${done}/${total}` });
    }
  }

  if (input.loop && input.loop.status === "halted" && input.loop.haltReason) {
    out.push({ projectId: input.projectId, kind: "loop", level: "warn", title: "自走ループ停止", detail: input.loop.haltReason });
  }

  return out.sort((a, b) =>
    LEVEL_RANK[a.level] - LEVEL_RANK[b.level]
    || a.projectId.localeCompare(b.projectId)
    || (a.cardId ?? 0) - (b.cardId ?? 0)
    || a.kind.localeCompare(b.kind));
}

export function countLevels(items: readonly Notification[]): { danger: number; warn: number; info: number } {
  const out = { danger: 0, warn: 0, info: 0 };
  for (const n of items) out[n.level]++;
  return out;
}
