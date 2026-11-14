// Timeline event factories. They only build objects — persistence appends them in the
// same transaction as the state change (see docs/REWRITE_V2_PLAN.md §8).
import type { TimelineEvent } from "../shared/events.js";
import type { Card, Project } from "../shared/dto.js";
import { cid, formatCid } from "../shared/ids.js";
import type { Dependency } from "./dependency.js";
import { isoAt, type At } from "./validation.js";

export const ACTOR_SYSTEM = "system";

export interface EventContext { actor?: string; at?: At }

function base(projectId: string, entityType: TimelineEvent["entityType"], entityId: string, kind: TimelineEvent["kind"], payload: unknown, ctx: EventContext): TimelineEvent {
  return { projectId, entityType, entityId, kind, actor: ctx.actor ?? ACTOR_SYSTEM, payload, at: isoAt(ctx.at) };
}

/** Composite id string used for card-scoped `entityId` (never a bare id). */
export function cardEntityId(projectId: string, id: number): string {
  return formatCid(cid(projectId, id));
}

export function dependencyEntityId(dep: Dependency): string {
  return `${cardEntityId(dep.projectId, dep.fromCard)}->${dep.toCard}`;
}

export function projectCreated(project: Project, ctx: EventContext = {}): TimelineEvent {
  return base(project.projectId, "project", project.projectId, "project.created", { slug: project.slug, name: project.name }, ctx);
}

export function projectUpdated(project: Project, changed: readonly string[], ctx: EventContext = {}): TimelineEvent {
  return base(project.projectId, "project", project.projectId, "project.updated", { changed: [...changed] }, ctx);
}

export function cardCreated(card: Card, ctx: EventContext = {}): TimelineEvent {
  return base(card.projectId, "card", cardEntityId(card.projectId, card.id), "card.created", {
    id: card.id, title: card.title, columnId: card.columnId, priority: card.priority,
  }, ctx);
}

export function cardUpdated(card: Card, changed: readonly string[], ctx: EventContext = {}): TimelineEvent {
  return base(card.projectId, "card", cardEntityId(card.projectId, card.id), "card.updated", {
    id: card.id, changed: [...changed], title: card.title, columnId: card.columnId,
  }, ctx);
}

export function cardMoved(card: Card, fromColumnId: string, ctx: EventContext = {}): TimelineEvent {
  return base(card.projectId, "card", cardEntityId(card.projectId, card.id), "card.moved", {
    id: card.id, from: fromColumnId, to: card.columnId, closedAt: card.closedAt ?? null, movedAt: card.movedAt,
  }, ctx);
}

export function cardDeleted(card: Card, ctx: EventContext = {}): TimelineEvent {
  return base(card.projectId, "card", cardEntityId(card.projectId, card.id), "card.deleted", {
    id: card.id, title: card.title, columnId: card.columnId,
  }, ctx);
}

export function dependencyAdded(dep: Dependency, ctx: EventContext = {}): TimelineEvent {
  return base(dep.projectId, "dependency", dependencyEntityId(dep), "dependency.added", { fromCard: dep.fromCard, toCard: dep.toCard, type: dep.type }, ctx);
}

export function dependencyRemoved(dep: Dependency, ctx: EventContext = {}): TimelineEvent {
  return base(dep.projectId, "dependency", dependencyEntityId(dep), "dependency.removed", { fromCard: dep.fromCard, toCard: dep.toCard, type: dep.type }, ctx);
}
