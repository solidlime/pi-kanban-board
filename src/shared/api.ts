import type { BoardSnapshot, Card, ColumnDef, Dependency, Deliverable, Project } from "./dto.js";
import type { TimelineEvent } from "./events.js";
import type { ApiEnvelope } from "./errors.js";

export type Meta = { version: string; buildHash: string; schemaVersion: number; capabilities: string[] };
export type ProjectRef = { projectId: string; slug: string; name: string };

// Read
export type GetMeta = ApiEnvelope<Meta>;
export type GetProjects = ApiEnvelope<{ projects: ProjectRef[] }>;
export type GetBoard = ApiEnvelope<BoardSnapshot>;

// Write
export type CreateProjectReq = { slug?: string; name?: string };
export type CreateProjectRes = ApiEnvelope<{ project: Project; columns: ColumnDef[] }>;
export type DeleteProjectRes = ApiEnvelope<{ deleted: { projectId: string; slug: string } }>;

export type CreateCardReq = { project: string; title: string; body?: string; columnId?: string; priority?: number; labels?: string[]; owner?: string | null; due?: string | null; estimate?: number | null };
export type CreateCardRes = ApiEnvelope<{ card: Card }>;

export type PatchCardReq = { title?: string; body?: string; priority?: number; labels?: string[]; owner?: string | null; due?: string | null; estimate?: number | null; blockedReason?: string | null; sessionId?: string | null; version: number };
export type PatchCardRes = ApiEnvelope<{ card: Card }>;

// A pi session a card can resume. The UI offers the name; the card stores the id.
export type SessionRef = { id: string; name: string; updatedAt: string };
export type GetSessions = ApiEnvelope<{ sessions: SessionRef[] }>;

export type MoveCardReq = { columnId: string; position?: number; version: number };
export type MoveCardRes = ApiEnvelope<{ card: Card }>;

export type DeleteCardReq = { version?: number };
export type DeleteCardRes = ApiEnvelope<{ deleted: { projectId: string; id: number } }>;

// Dependencies (project-scoped; a bare card id is never enough to name an edge)
export type DependencyType = "blocks" | "relates";
export type GetDependencies = ApiEnvelope<{ dependencies: Dependency[] }>;
export type AddDependencyReq = { project: string; fromCard: number; toCard: number; type?: DependencyType };
export type AddDependencyRes = ApiEnvelope<{ dependency: Dependency }>;
export type RemoveDependencyRes = ApiEnvelope<{ removed: Dependency }>;

// Deliverables
export type GetDeliverables = ApiEnvelope<{ deliverables: Deliverable[] }>;
export type CreateDeliverableReq = { project: string; title: string; ref?: string; kind?: string; cardId?: number | null };
export type CreateDeliverableRes = ApiEnvelope<{ deliverable: Deliverable }>;
export type DeleteDeliverableRes = ApiEnvelope<{ deleted: { projectId: string; id: number } }>;

// Timeline
export type GetTimeline = ApiEnvelope<{ events: TimelineEvent[] }>;
