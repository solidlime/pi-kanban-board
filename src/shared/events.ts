// Timeline / domain events (append-only in persistence). Payloads are JSON-serializable.
export type EntityType = "project" | "board" | "card" | "deliverable" | "attachment" | "dependency" | "view" | "loop";
export type EventKind =
  | "project.created" | "project.updated"
  | "card.created" | "card.updated" | "card.moved" | "card.deleted"
  | "board.column.updated"
  | "dependency.added" | "dependency.removed"
  | "deliverable.created" | "deliverable.updated" | "deliverable.deleted"
  | "attachment.added" | "attachment.removed"
  | "loop.resumed" | "loop.halted" | "loop.tick";

export interface TimelineEvent<T = unknown> {
  projectId: string;
  seq?: number;
  entityType: EntityType;
  entityId: string; // composite key string or project-scoped id string
  kind: EventKind;
  actor: string; // session/tool/ui/system
  payload: T;
  at: string; // ISO
}
