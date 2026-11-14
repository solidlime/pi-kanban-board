// Frozen tool surface (Phase 0). Names/order must be preserved by agent adapter.
export const TOOL_NAMES = ["kanban", "deliverable"] as const;

export type KanbanAction = "list" | "add" | "move" | "remove" | "check" | "resume" | "url" | "edit" | "img" | "ref";
export type KanbanScope = "project" | "global";

export interface KanbanParams {
  action: KanbanAction;
  scope?: KanbanScope;
  project?: string; // slug; required when ambiguous or for global-origin items
  id?: number;
  text?: string;
  col?: string;
  nextFireAt?: string;
  blocked?: boolean | string;
  session?: string;
  commit?: string;
  labels?: string[];
  image?: string;
  priority?: number;
}

export type KanbanDetails = { scope: KanbanScope; cards: unknown[]; nextId?: number; url?: string };

export type DeliverableAction = "add" | "list" | "edit" | "remove" | "img" | "ref";
export interface DeliverableParams { action: DeliverableAction; scope?: KanbanScope; project?: string; id?: number; title?: string; ref?: string; cardId?: number }
export type DeliverableDetails = { scope: KanbanScope; deliverables: unknown[] };
