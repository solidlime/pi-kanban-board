import type { ProjectId, EntityId } from "./ids.js";

export type ColumnKind = "todo" | "doing" | "done" | "custom";

export interface Project {
  projectId: ProjectId; slug: string; name: string;
  settings?: Record<string, unknown>;
  createdAt: string; updatedAt: string;
}

export interface ColumnDef {
  projectId: ProjectId; id: string; name: string; kind: ColumnKind; ord: number; wipLimit: number | null;
}

export interface Card {
  projectId: ProjectId; id: EntityId; columnId: string; title: string; body?: string;
  priority: number; owner?: string | null; due?: string | null; estimate?: number | null;
  blockedReason?: string | null; acceptance?: string[]; labels?: string[];
  sessionId?: string | null; commit?: string | null;
  /** Absolute path of the original file (v1 `ref` semantics: reference, never copied). */
  ref?: string | null;
  /**
   * Actor of the newest timeline event for this card. Read-only projection: the board
   * snapshot carries it, no endpoint accepts it on a write.
   */
  lastActor?: string | null;
  createdAt: string; updatedAt: string; movedAt: string; closedAt?: string | null; version: number;
}

export interface Dependency { projectId: ProjectId; fromCard: EntityId; toCard: EntityId; type: "blocks" | "relates"; }

export interface Deliverable {
  projectId: ProjectId; id: EntityId; cardId?: EntityId | null;
  title: string; ref: string; kind: string; meta?: Record<string, unknown>;
  createdAt: string; updatedAt: string;
}

export interface BoardSnapshot { project: Project; columns: ColumnDef[]; cards: Card[]; dependencies?: Dependency[]; generation?: string; }

// ---------------------------------------------------------------- v2 extras (schema v2)

/** Saved view payload. Deliberately small: a query the board can re-apply in one click. */
export interface ViewQuery { q?: string; focus?: boolean }

export interface SavedView {
  projectId: ProjectId; id: EntityId; name: string; query: ViewQuery;
}

/** A card blueprint: create-in-one-click, not a card. */
export interface CardTemplate {
  projectId: ProjectId; id: EntityId; name: string; title: string; body: string;
  columnId?: string | null; priority: number; labels?: string[];
  createdAt: string; updatedAt: string;
}

/** A stored blob (image) attached to a card or a deliverable. */
export interface Attachment {
  projectId: ProjectId; id: EntityId; cardId?: EntityId | null; deliverableId?: EntityId | null;
  name: string; mime: string; size: number; createdAt: string;
}

/**
 * Doing-loop observability. v2 has no executor: the state machine records who started it,
 * when it last ran and which card it suggests next; the agent does the work.
 */
export type LoopStatus = "idle" | "running" | "halted";
export interface LoopState {
  projectId: ProjectId; status: LoopStatus; mode: "suggest";
  startedAt: string | null; haltedAt: string | null; haltReason: string | null;
  lastTickAt: string | null; ticks: number; nextCardId: EntityId | null;
}

/**
 * The three loop knobs v1 kept behind /api/interval, /api/stuck and /api/maxloops, as one
 * row in kv_meta. `stuckDays` 0 disables the stuck halt, `maxLoops` 0 means unlimited.
 * `intervalMs` only takes effect on the next start: a running supervisor keeps its cadence.
 */
export interface LoopSettings { intervalMs: number; stuckDays: number; maxLoops: number }

export type NotificationLevel = "danger" | "warn" | "info";
export type NotificationKind = "overdue" | "blocked" | "deps" | "wip" | "acceptance" | "stale" | "loop";
export interface Notification {
  projectId: ProjectId; kind: NotificationKind; level: NotificationLevel;
  cardId?: EntityId; columnId?: string; title: string; detail: string;
}

export interface SearchHit {
  projectId: ProjectId; type: "card" | "deliverable"; id: EntityId;
  title: string; snippet: string; columnId?: string; cardId?: EntityId | null; closed?: boolean;
}

/** Layered dependency layout: layer = longest chain of blockers behind the node. */
export interface GraphNode {
  id: EntityId; columnId: string; layer: number; closed: boolean; blocked: boolean; title: string;
}
export interface GraphEdge { from: EntityId; to: EntityId }
export interface GraphLayout { nodes: GraphNode[]; edges: GraphEdge[]; layers: number }

export interface OverviewRow {
  projectId: ProjectId; name: string;
  loop: LoopStatus;
  columns: { id: string; name: string; kind: ColumnKind; count: number; wipLimit: number | null }[];
  counts: { total: number; open: number; done: number; ready: number; blocked: number; overdue: number; stale: number; wipOver: number };
}
