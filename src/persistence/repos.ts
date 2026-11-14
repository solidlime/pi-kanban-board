// Repositories for v2. Every write is one transaction and appends its timeline event
// inside that same transaction — a state change that is not described is a bug.
// Nothing here resolves a bare entity id: every call takes projectId + entity id.
import type {
  Attachment, BoardSnapshot, Card, CardTemplate, ColumnDef, ColumnKind, Deliverable, LoopState, Project, SavedView, ViewQuery
} from "../shared/dto.js";
import type { EntityId, ProjectId } from "../shared/ids.js";
import { formatCid } from "../shared/ids.js";
import type { EntityType, EventKind, TimelineEvent } from "../shared/events.js";
import type { DependencyType } from "../core/dependency.js";
import type { DigestInput } from "../core/digest.js";
import { DomainError } from "../shared/errors.js";
import type { Db } from "./db.js";
import { all, one, run, withTx } from "./db.js";

export type SeqName = "card" | "deliverable" | "attachment" | "view";

const nowIso = (): string => new Date().toISOString();

/**
 * WIP is a rule of the board, so it is checked at the only door to the DB: HTTP routes,
 * templates and the agent adapter all create and move through here, and none of them can
 * step around it. (Before this lived in the routes, so template and agent writes bypassed it.)
 */
function assertWip(db: Db, projectId: ProjectId, columnId: string, excludeCardId?: EntityId): void {
  const col = getColumn(db, projectId, columnId);
  if (!col || col.wipLimit === null) return;
  const inColumn = one<{ n: number }>(db,
    "SELECT COUNT(*) AS n FROM card WHERE project_id = ? AND column_id = ? AND id <> ?",
    projectId, columnId, excludeCardId ?? -1)?.n ?? 0;
  if (inColumn >= col.wipLimit) {
    throw new DomainError("WIP_LIMIT", `column "${col.name}" is at its WIP limit (${col.wipLimit})`,
      { columnId, limit: col.wipLimit, count: inColumn });
  }
}

// ---------- row mapping ----------

interface ProjectRow { project_id: string; slug: string; name: string; settings_json: string; created_at: string; updated_at: string }
interface ColumnRow { project_id: string; id: string; name: string; kind: string; ord: number; wip_limit: number | null }
interface CardRow {
  project_id: string; id: number; column_id: string; title: string; body: string; priority: number;
  owner: string | null; due: string | null; estimate: number | null; blocked_reason: string | null;
  labels_json: string; session_id: string | null; commit_sha: string | null; ref: string | null;
  created_at: string; updated_at: string; moved_at: string; closed_at: string | null; version: number;
}
interface TimelineRow { project_id: string; seq: number; entity_type: string; entity_id: string; kind: string; actor: string; payload_json: string; at: string }
interface DeliverableRow {
  project_id: string; id: number; card_id: number | null; title: string; ref: string; kind: string;
  meta_json: string; created_at: string; updated_at: string;
}

const parseJson = <T>(raw: string, fallback: T): T => {
  try { return JSON.parse(raw) as T; } catch { return fallback; }
};

const toProject = (r: ProjectRow): Project => ({
  projectId: r.project_id,
  slug: r.slug,
  name: r.name,
  settings: parseJson<Record<string, unknown>>(r.settings_json, {}),
  createdAt: r.created_at,
  updatedAt: r.updated_at
});

const toColumn = (r: ColumnRow): ColumnDef => ({
  projectId: r.project_id, id: r.id, name: r.name, kind: r.kind as ColumnKind, ord: Number(r.ord), wipLimit: r.wip_limit
});

const toCard = (r: CardRow): Card => ({
  projectId: r.project_id, id: Number(r.id), columnId: r.column_id, title: r.title, body: r.body,
  priority: Number(r.priority), owner: r.owner, due: r.due, estimate: r.estimate === null ? null : Number(r.estimate),
  blockedReason: r.blocked_reason, labels: parseJson<string[]>(r.labels_json, []),
  sessionId: r.session_id, commit: r.commit_sha, ref: r.ref ?? null,
  createdAt: r.created_at, updatedAt: r.updated_at, movedAt: r.moved_at, closedAt: r.closed_at,
  version: Number(r.version)
});

const toDeliverable = (r: DeliverableRow): Deliverable => ({
  projectId: r.project_id, id: Number(r.id), cardId: r.card_id === null ? null : Number(r.card_id),
  title: r.title, ref: r.ref, kind: r.kind, meta: parseJson<Record<string, unknown>>(r.meta_json, {}),
  createdAt: r.created_at, updatedAt: r.updated_at
});

const toEvent = (r: TimelineRow): TimelineEvent => ({
  projectId: r.project_id, seq: Number(r.seq), entityType: r.entity_type as EntityType,
  entityId: r.entity_id, kind: r.kind as EventKind, actor: r.actor,
  payload: parseJson<unknown>(r.payload_json, {}), at: r.at
});

/** SQLite constraint failures become domain errors so callers never see raw sqlite text. */
function asDomain<T>(fn: () => T, conflictMessage: string): T {
  try {
    return fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed|PRIMARY KEY/i.test(msg)) throw new DomainError("CONFLICT", conflictMessage, { cause: msg });
    if (/FOREIGN KEY constraint failed/i.test(msg)) throw new DomainError("NOT_FOUND", "referenced row does not exist", { cause: msg });
    throw err;
  }
}

// ---------- timeline ----------

export interface AppendEventInput {
  projectId: ProjectId;
  entityType: EntityType;
  entityId: string;
  kind: EventKind;
  actor?: string;
  payload?: unknown;
  at?: string;
}

/** Append one event. Call inside the caller's tx; do not open a second one. */
export function appendTimeline(db: Db, e: AppendEventInput): TimelineEvent {
  const at = e.at ?? nowIso();
  const r = run(db,
    "INSERT INTO timeline_event (project_id, entity_type, entity_id, kind, actor, payload_json, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    e.projectId, e.entityType, e.entityId, e.kind, e.actor ?? "system", JSON.stringify(e.payload ?? {}), at);
  return { projectId: e.projectId, seq: r.lastInsertRowid, entityType: e.entityType, entityId: e.entityId, kind: e.kind, actor: e.actor ?? "system", payload: e.payload ?? {}, at };
}

export function listTimeline(db: Db, projectId: ProjectId, opts: { limit?: number; sinceSeq?: number } = {}): TimelineEvent[] {
  const limit = Math.max(1, Math.min(1000, Math.trunc(opts.limit ?? 100)));
  return all<TimelineRow>(db,
    "SELECT * FROM timeline_event WHERE project_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
    projectId, Math.trunc(opts.sinceSeq ?? 0), limit).map(toEvent);
}

// ---------- id sequencing ----------

/**
 * Project-local sequence. `counters.next` holds the last id issued; the row is bumped in
 * the caller's tx, so a rolled back insert also rolls the id back — ids are gapless per
 * project, never global.
 */
export function nextId(db: Db, projectId: ProjectId, name: SeqName): EntityId {
  const row = one<{ next: number }>(db,
    `INSERT INTO counters (project_id, name, next) VALUES (?, ?, 1)
     ON CONFLICT(project_id, name) DO UPDATE SET next = next + 1
     RETURNING next`, projectId, name);
  if (!row) throw new DomainError("INTERNAL", "counter bump returned no row");
  return Number(row.next);
}

/** What the next id would be, without consuming it (for tool `details.nextId`). */
export function peekNextId(db: Db, projectId: ProjectId, name: SeqName): EntityId {
  const row = one<{ next: number }>(db, "SELECT next FROM counters WHERE project_id = ? AND name = ?", projectId, name);
  return row ? Number(row.next) + 1 : 1;
}

// ---------- projects ----------

export const DEFAULT_COLUMNS: ReadonlyArray<Omit<ColumnDef, "projectId">> = [
  { id: "todo", name: "TODO", kind: "todo", ord: 1, wipLimit: null },
  { id: "doing", name: "DOING", kind: "doing", ord: 2, wipLimit: null },
  { id: "done", name: "DONE", kind: "done", ord: 3, wipLimit: null }
];

export interface CreateProjectInput { slug: string; name?: string; settings?: Record<string, unknown>; withDefaultColumns?: boolean }

export function createProject(db: Db, input: CreateProjectInput, actor = "system"): Project {
  if (!input.slug) throw new DomainError("VALIDATION", "slug is required");
  const at = nowIso();
  return withTx(db, () => {
    // NOT a domain-level "unique" here: the UNIQUE index on slug is the source of truth.
    asDomain(() => run(db,
      "INSERT INTO project (project_id, slug, name, settings_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      input.slug, input.slug, input.name ?? input.slug, JSON.stringify(input.settings ?? {}), at, at),
    `project ${input.slug} already exists`);
    if (input.withDefaultColumns !== false) {
      for (const c of DEFAULT_COLUMNS) {
        run(db, "INSERT INTO column_def (project_id, id, name, kind, ord, wip_limit) VALUES (?, ?, ?, ?, ?, ?)",
          input.slug, c.id, c.name, c.kind, c.ord, c.wipLimit ?? null);
      }
    }
    appendTimeline(db, { projectId: input.slug, entityType: "project", entityId: input.slug, kind: "project.created", actor, payload: { slug: input.slug }, at });
    const row = one<ProjectRow>(db, "SELECT * FROM project WHERE project_id = ?", input.slug);
    return toProject(row!);
  });
}

export function getProject(db: Db, projectId: ProjectId): Project | null {
  const row = one<ProjectRow>(db, "SELECT * FROM project WHERE project_id = ?", projectId);
  return row ? toProject(row) : null;
}

export function getProjectBySlug(db: Db, slug: string): Project | null {
  const row = one<ProjectRow>(db, "SELECT * FROM project WHERE slug = ?", slug);
  return row ? toProject(row) : null;
}

export function listProjects(db: Db): Project[] {
  return all<ProjectRow>(db, "SELECT * FROM project ORDER BY project_id ASC").map(toProject);
}

export function updateProject(db: Db, projectId: ProjectId, patch: { name?: string; settings?: Record<string, unknown> }, actor = "system"): Project {
  return withTx(db, () => {
    const cur = one<ProjectRow>(db, "SELECT * FROM project WHERE project_id = ?", projectId);
    if (!cur) throw new DomainError("NOT_FOUND", `project ${projectId} not found`);
    const at = nowIso();
    run(db, "UPDATE project SET name = ?, settings_json = ?, updated_at = ? WHERE project_id = ?",
      patch.name ?? cur.name, JSON.stringify(patch.settings ?? parseJson(cur.settings_json, {})), at, projectId);
    appendTimeline(db, { projectId, entityType: "project", entityId: projectId, kind: "project.updated", actor, payload: patch, at });
    return toProject(one<ProjectRow>(db, "SELECT * FROM project WHERE project_id = ?", projectId)!);
  });
}

// ---------- columns ----------

export interface CreateColumnInput { projectId: ProjectId; id: string; name: string; kind: ColumnKind; ord?: number; wipLimit?: number | null }

export function createColumn(db: Db, input: CreateColumnInput): ColumnDef {
  if (!input.id) throw new DomainError("VALIDATION", "column id is required");
  const ord = input.ord ?? (one<{ m: number | null }>(db, "SELECT MAX(ord) AS m FROM column_def WHERE project_id = ?", input.projectId)?.m ?? 0) + 1;
  asDomain(() => run(db,
    "INSERT INTO column_def (project_id, id, name, kind, ord, wip_limit) VALUES (?, ?, ?, ?, ?, ?)",
    input.projectId, input.id, input.name, input.kind, ord, input.wipLimit ?? null),
  `column ${input.id} already exists in ${input.projectId}`);
  const row = one<ColumnRow>(db, "SELECT * FROM column_def WHERE project_id = ? AND id = ?", input.projectId, input.id);
  if (!row) throw new DomainError("NOT_FOUND", `column ${input.id} not found`);
  return toColumn(row);
}

export function getColumn(db: Db, projectId: ProjectId, id: string): ColumnDef | null {
  const row = one<ColumnRow>(db, "SELECT * FROM column_def WHERE project_id = ? AND id = ?", projectId, id);
  return row ? toColumn(row) : null;
}

export function listColumns(db: Db, projectId: ProjectId): ColumnDef[] {
  return all<ColumnRow>(db, "SELECT * FROM column_def WHERE project_id = ? ORDER BY ord ASC, id ASC", projectId).map(toColumn);
}

// ---------- cards ----------

export interface CreateCardInput {
  projectId: ProjectId;
  columnId: string;
  title: string;
  body?: string;
  priority?: number;
  owner?: string | null;
  due?: string | null;
  estimate?: number | null;
  blockedReason?: string | null;
  labels?: string[];
  sessionId?: string | null;
  commit?: string | null;
  ref?: string | null;
}

export function createCard(db: Db, input: CreateCardInput, actor = "system"): Card {
  if (!input.title || !input.title.trim()) throw new DomainError("VALIDATION", "title is required");
  return withTx(db, () => {
    const col = getColumn(db, input.projectId, input.columnId);
    if (!col) throw new DomainError("VALIDATION", `column ${input.columnId} not found in ${input.projectId}`);
    assertWip(db, input.projectId, input.columnId);
    const id = nextId(db, input.projectId, "card");
    const at = nowIso();
    run(db,
      `INSERT INTO card (project_id, id, column_id, title, body, priority, owner, due, estimate, blocked_reason,
        labels_json, session_id, commit_sha, ref, created_at, updated_at, moved_at, closed_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      input.projectId, id, input.columnId, input.title, input.body ?? "", Math.trunc(input.priority ?? 0),
      input.owner ?? null, input.due ?? null, input.estimate ?? null, input.blockedReason ?? null,
      JSON.stringify(input.labels ?? []), input.sessionId ?? null, input.commit ?? null, input.ref ?? null,
      at, at, at, col.kind === "done" ? at : null);
    const card = getCard(db, input.projectId, id)!;
    appendTimeline(db, {
      projectId: input.projectId, entityType: "card", entityId: formatCid({ projectId: input.projectId, id }),
      kind: "card.created", actor, payload: { id, columnId: input.columnId, title: input.title, version: card.version }, at
    });
    return card;
  });
}

export function getCard(db: Db, projectId: ProjectId, id: EntityId): Card | null {
  const row = one<CardRow>(db, "SELECT * FROM card WHERE project_id = ? AND id = ?", projectId, id);
  return row ? toCard(row) : null;
}

export function listCards(db: Db, projectId: ProjectId, filter: { columnId?: string } = {}): Card[] {
  if (filter.columnId) {
    return all<CardRow>(db,
      "SELECT * FROM card WHERE project_id = ? AND column_id = ? ORDER BY priority DESC, id ASC",
      projectId, filter.columnId).map(toCard);
  }
  return all<CardRow>(db,
    "SELECT * FROM card WHERE project_id = ? ORDER BY column_id ASC, priority DESC, id ASC",
    projectId).map(toCard);
}

/** Optimistic lock: a stale expectedVersion fails without touching the row. */
function checkVersion(cur: Card, expected?: number): void {
  if (expected !== undefined && expected !== cur.version) {
    throw new DomainError("STALE_VERSION", `card ${cur.projectId}#${cur.id} is at version ${cur.version}`, { current: cur.version, expected });
  }
}

export interface UpdateCardPatch {
  title?: string; body?: string; priority?: number; owner?: string | null; due?: string | null;
  estimate?: number | null; blockedReason?: string | null; labels?: string[];
  sessionId?: string | null; commit?: string | null; ref?: string | null;
}

export function updateCard(db: Db, projectId: ProjectId, id: EntityId, patch: UpdateCardPatch, opts: { expectedVersion?: number; actor?: string } = {}): Card {
  return withTx(db, () => {
    const cur = getCard(db, projectId, id);
    if (!cur) throw new DomainError("NOT_FOUND", `card ${projectId}#${id} not found`);
    checkVersion(cur, opts.expectedVersion);
    const at = nowIso();
    run(db,
      `UPDATE card SET title = ?, body = ?, priority = ?, owner = ?, due = ?, estimate = ?, blocked_reason = ?,
        labels_json = ?, session_id = ?, commit_sha = ?, ref = ?, updated_at = ?, version = version + 1
       WHERE project_id = ? AND id = ?`,
      patch.title ?? cur.title, patch.body ?? cur.body ?? "", Math.trunc(patch.priority ?? cur.priority),
      patch.owner === undefined ? (cur.owner ?? null) : patch.owner,
      patch.due === undefined ? (cur.due ?? null) : patch.due,
      patch.estimate === undefined ? (cur.estimate ?? null) : patch.estimate,
      patch.blockedReason === undefined ? (cur.blockedReason ?? null) : patch.blockedReason,
      JSON.stringify(patch.labels ?? cur.labels ?? []),
      patch.sessionId === undefined ? (cur.sessionId ?? null) : patch.sessionId,
      patch.commit === undefined ? (cur.commit ?? null) : patch.commit,
      patch.ref === undefined ? (cur.ref ?? null) : patch.ref,
      at, projectId, id);
    const next = getCard(db, projectId, id)!;
    appendTimeline(db, {
      projectId, entityType: "card", entityId: formatCid({ projectId, id }),
      kind: "card.updated", actor: opts.actor ?? "system", payload: { patches: Object.keys(patch), version: next.version }, at
    });
    return next;
  });
}

/** Move between columns of the same project. Column existence is checked, not assumed. */
export function moveCard(db: Db, projectId: ProjectId, id: EntityId, toColumnId: string, opts: { expectedVersion?: number; actor?: string } = {}): Card {
  return withTx(db, () => {
    const cur = getCard(db, projectId, id);
    if (!cur) throw new DomainError("NOT_FOUND", `card ${projectId}#${id} not found`);
    checkVersion(cur, opts.expectedVersion);
    const col = getColumn(db, projectId, toColumnId);
    if (!col) throw new DomainError("VALIDATION", `column ${toColumnId} not found in ${projectId}`);
    // Dropping a card onto the column it already sits in is not a change: no version bump,
    // no timeline event, and above all no 409 for a drag the user did not make.
    if (cur.columnId === toColumnId) return cur;
    assertWip(db, projectId, toColumnId, id);
    const at = nowIso();
    run(db, "UPDATE card SET column_id = ?, moved_at = ?, updated_at = ?, closed_at = ?, version = version + 1 WHERE project_id = ? AND id = ?",
      toColumnId, at, at, col.kind === "done" ? at : null, projectId, id);
    const next = getCard(db, projectId, id)!;
    appendTimeline(db, {
      projectId, entityType: "card", entityId: formatCid({ projectId, id }),
      kind: "card.moved", actor: opts.actor ?? "system",
      payload: { id, from: cur.columnId, to: toColumnId, version: next.version }, at
    });
    return next;
  });
}

export function deleteCard(db: Db, projectId: ProjectId, id: EntityId, opts: { expectedVersion?: number; actor?: string } = {}): void {
  withTx(db, () => {
    const cur = getCard(db, projectId, id);
    if (!cur) throw new DomainError("NOT_FOUND", `card ${projectId}#${id} not found`);
    checkVersion(cur, opts.expectedVersion);
    const at = nowIso();
    appendTimeline(db, {
      projectId, entityType: "card", entityId: formatCid({ projectId, id }),
      kind: "card.deleted", actor: opts.actor ?? "system", payload: { id, columnId: cur.columnId, title: cur.title }, at
    });
    // The composite FK on (project_id, card_id) is ON DELETE SET NULL, which SQLite applies to
    // BOTH columns — that would null project_id and trip its NOT NULL. Unlinking first keeps the
    // deliverable alive with its project and no card, which is the documented intent.
    run(db, "UPDATE deliverable SET card_id = NULL, updated_at = ? WHERE project_id = ? AND card_id = ?", at, projectId, id);
    // Same composite-FK trap for attachments: unlink so the row keeps its project.
    run(db, "UPDATE attachment SET card_id = NULL WHERE project_id = ? AND card_id = ?", projectId, id);
    run(db, "DELETE FROM card WHERE project_id = ? AND id = ?", projectId, id);
  });
}

// ---------- dependencies ----------

// `type` is the domain union, not a bare string: callers hand this straight to core's
// assertDependencyAddable/listDependencies, which is where cycle and duplicate rules live.
export interface Dependency { projectId: ProjectId; fromCard: EntityId; toCard: EntityId; type: DependencyType }

export function addDependency(db: Db, d: Dependency, actor = "system"): Dependency {
  if (d.fromCard === d.toCard) throw new DomainError("VALIDATION", "a card cannot depend on itself");
  const type = d.type || "blocks";
  return withTx(db, () => {
    if (!getCard(db, d.projectId, d.fromCard)) throw new DomainError("NOT_FOUND", `card ${d.projectId}#${d.fromCard} not found`);
    if (!getCard(db, d.projectId, d.toCard)) throw new DomainError("NOT_FOUND", `card ${d.projectId}#${d.toCard} not found`);
    asDomain(() => run(db, "INSERT INTO dependency (project_id, from_card, to_card, type) VALUES (?, ?, ?, ?)",
      d.projectId, d.fromCard, d.toCard, type),
    `dependency ${d.fromCard}->${d.toCard} (${type}) already exists`);
    appendTimeline(db, {
      projectId: d.projectId, entityType: "dependency", entityId: `${formatCid({ projectId: d.projectId, id: d.fromCard })}>${formatCid({ projectId: d.projectId, id: d.toCard })}`,
      kind: "dependency.added", actor, payload: { from: d.fromCard, to: d.toCard, type }
    });
    return { projectId: d.projectId, fromCard: d.fromCard, toCard: d.toCard, type };
  });
}

export function removeDependency(db: Db, d: Dependency, actor = "system"): void {
  withTx(db, () => {
    const r = run(db, "DELETE FROM dependency WHERE project_id = ? AND from_card = ? AND to_card = ? AND type = ?",
      d.projectId, d.fromCard, d.toCard, d.type || "blocks");
    if (r.changes === 0) throw new DomainError("NOT_FOUND", `dependency ${d.fromCard}->${d.toCard} not found`);
    appendTimeline(db, {
      projectId: d.projectId, entityType: "dependency", entityId: `${formatCid({ projectId: d.projectId, id: d.fromCard })}>${formatCid({ projectId: d.projectId, id: d.toCard })}`,
      kind: "dependency.removed", actor, payload: { from: d.fromCard, to: d.toCard, type: d.type || "blocks" }
    });
  });
}

export function listDependencies(db: Db, projectId: ProjectId, cardId?: EntityId): Dependency[] {
  const rows = cardId === undefined
    ? all<{ from_card: number; to_card: number; type: string }>(db, "SELECT from_card, to_card, type FROM dependency WHERE project_id = ? ORDER BY from_card, to_card", projectId)
    : all<{ from_card: number; to_card: number; type: string }>(db,
      "SELECT from_card, to_card, type FROM dependency WHERE project_id = ? AND (from_card = ? OR to_card = ?) ORDER BY from_card, to_card",
      projectId, cardId, cardId);
  return rows.map((r): Dependency => ({ projectId, fromCard: Number(r.from_card), toCard: Number(r.to_card), type: r.type === "relates" ? "relates" : "blocks" }));
}

// ---------- deliverables ----------
// A deliverable is a project-owned output row; `cardId` links it to the card it came from.
// The FK is ON DELETE SET NULL, so deleting a card keeps the deliverable and drops the link.

export interface CreateDeliverableInput {
  projectId: ProjectId; title: string; ref?: string; kind?: string; cardId?: EntityId | null;
  meta?: Record<string, unknown>;
}

export function createDeliverable(db: Db, input: CreateDeliverableInput, actor = "system"): Deliverable {
  if (!input.title || !input.title.trim()) throw new DomainError("VALIDATION", "title is required");
  return withTx(db, () => {
    if (input.cardId !== undefined && input.cardId !== null && !getCard(db, input.projectId, input.cardId)) {
      throw new DomainError("NOT_FOUND", `card ${input.projectId}#${input.cardId} not found`);
    }
    const id = nextId(db, input.projectId, "deliverable");
    const at = nowIso();
    run(db,
      `INSERT INTO deliverable (project_id, id, card_id, title, ref, kind, meta_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.projectId, id, input.cardId ?? null, input.title.trim(), input.ref ?? "",
      input.kind || "note", JSON.stringify(input.meta ?? {}), at, at);
    const row = one<DeliverableRow>(db, "SELECT * FROM deliverable WHERE project_id = ? AND id = ?", input.projectId, id);
    if (!row) throw new DomainError("INTERNAL", "deliverable insert returned no row");
    appendTimeline(db, {
      projectId: input.projectId, entityType: "deliverable", entityId: formatCid({ projectId: input.projectId, id }),
      kind: "deliverable.created", actor,
      payload: { id, title: input.title.trim(), kind: input.kind || "note", cardId: input.cardId ?? null }, at
    });
    return toDeliverable(row);
  });
}

export function listDeliverables(db: Db, projectId: ProjectId, opts: { cardId?: EntityId } = {}): Deliverable[] {
  const rows = opts.cardId === undefined
    ? all<DeliverableRow>(db, "SELECT * FROM deliverable WHERE project_id = ? ORDER BY id ASC", projectId)
    : all<DeliverableRow>(db, "SELECT * FROM deliverable WHERE project_id = ? AND card_id = ? ORDER BY id ASC", projectId, opts.cardId);
  return rows.map(toDeliverable);
}

export function getDeliverable(db: Db, projectId: ProjectId, id: EntityId): Deliverable | null {
  const row = one<DeliverableRow>(db, "SELECT * FROM deliverable WHERE project_id = ? AND id = ?", projectId, id);
  return row ? toDeliverable(row) : null;
}

export interface UpdateDeliverablePatch {
  title?: string; ref?: string; kind?: string; cardId?: EntityId | null; meta?: Record<string, unknown>;
}

/** Rewording is not a new row: the id and the created_at stamp stay. */
export function updateDeliverable(db: Db, projectId: ProjectId, id: EntityId, patch: UpdateDeliverablePatch, actor = "system"): Deliverable {
  return withTx(db, () => {
    const cur = getDeliverable(db, projectId, id);
    if (!cur) throw new DomainError("NOT_FOUND", `deliverable ${formatCid({ projectId, id })} not found`);
    if (patch.cardId !== undefined && patch.cardId !== null && !getCard(db, projectId, patch.cardId)) {
      throw new DomainError("NOT_FOUND", `card ${projectId}#${patch.cardId} not found`);
    }
    const title = patch.title === undefined ? cur.title : patch.title.trim();
    if (title === "") throw new DomainError("VALIDATION", "title is required");
    const at = nowIso();
    run(db,
      `UPDATE deliverable SET title = ?, ref = ?, kind = ?, card_id = ?, meta_json = ?, updated_at = ?
       WHERE project_id = ? AND id = ?`,
      title, patch.ref ?? cur.ref, patch.kind ?? cur.kind,
      patch.cardId === undefined ? (cur.cardId ?? null) : patch.cardId,
      JSON.stringify(patch.meta ?? cur.meta ?? {}), at, projectId, id);
    appendTimeline(db, {
      projectId, entityType: "deliverable", entityId: formatCid({ projectId, id }),
      kind: "deliverable.updated", actor, payload: { id, patches: Object.keys(patch) }, at
    });
    return getDeliverable(db, projectId, id)!;
  });
}

export function deleteDeliverable(db: Db, projectId: ProjectId, id: EntityId, actor = "system"): void {
  withTx(db, () => {
    const cur = getDeliverable(db, projectId, id);
    if (!cur) throw new DomainError("NOT_FOUND", `deliverable ${projectId}#${id} not found`);
    const at = nowIso();
    appendTimeline(db, {
      projectId, entityType: "deliverable", entityId: formatCid({ projectId, id }),
      kind: "deliverable.deleted", actor, payload: { id, title: cur.title, cardId: cur.cardId ?? null }, at
    });
    run(db, "UPDATE attachment SET deliverable_id = NULL WHERE project_id = ? AND deliverable_id = ?", projectId, id);
    run(db, "DELETE FROM deliverable WHERE project_id = ? AND id = ?", projectId, id);
  });
}

// ---------- board ----------

/**
 * Last writer per card, straight from the append-only timeline. One query: SQLite takes the
 * bare `actor` column from the row that supplied MAX(seq), so no window function is needed.
 */
function lastActors(db: Db, projectId: ProjectId): Map<number, string> {
  const rows = all<{ entity_id: string; actor: string }>(db,
    "SELECT entity_id, actor, MAX(seq) AS seq FROM timeline_event " +
    "WHERE project_id = ? AND entity_type = 'card' GROUP BY entity_id", projectId);
  const out = new Map<number, string>();
  for (const r of rows) {
    const id = Number(r.entity_id.slice(r.entity_id.lastIndexOf("#") + 1));
    if (Number.isInteger(id) && id > 0) out.set(id, r.actor);
  }
  return out;
}

/** One read for the UI/API: project + columns + cards + dependency edges. */
export function readBoard(db: Db, projectId: ProjectId): BoardSnapshot | null {
  const project = getProject(db, projectId);
  if (!project) return null;
  const actors = lastActors(db, projectId);
  return {
    project, columns: listColumns(db, projectId),
    cards: listCards(db, projectId).map(c => ({ ...c, lastActor: actors.get(c.id) ?? null })),
    dependencies: listDependencies(db, projectId)
  };
}

/**
 * Everything the digest needs, read once: the board rows plus the card.moved events inside
 * the window. The rendering itself is core/digest.ts (pure, no db).
 */
export function digestInput(db: Db, projectId: ProjectId, opts: { since: string; until: string }): DigestInput | null {
  const project = getProject(db, projectId);
  if (!project) return null;
  const events = all<TimelineRow>(db,
    "SELECT * FROM timeline_event WHERE project_id = ? AND entity_type = 'card' " +
    "AND kind = 'card.moved' AND at >= ? AND at < ? ORDER BY seq ASC",
    projectId, opts.since, opts.until).map(toEvent);
  return {
    projectId, projectName: project.name, since: opts.since, until: opts.until,
    columns: listColumns(db, projectId), cards: listCards(db, projectId), events,
    deliverables: listDeliverables(db, projectId)
      .filter(d => d.createdAt >= opts.since && d.createdAt < opts.until),
  };
}

// ---------- column editing ----------

export interface ColumnPatch { name?: string; wipLimit?: number | null; ord?: number }

/**
 * WIP limits used to be display-only because nothing could change them. The limit itself is
 * enforced by core/move.ts; this only records the number.
 */
export function updateColumn(db: Db, projectId: ProjectId, id: string, patch: ColumnPatch, actor = "system"): ColumnDef {
  return withTx(db, () => {
    const cur = getColumn(db, projectId, id);
    if (!cur) throw new DomainError("NOT_FOUND", `column ${id} not found in ${projectId}`);
    const name = patch.name === undefined ? cur.name : patch.name.trim();
    if (name === "") throw new DomainError("VALIDATION", "column name is required");
    if (patch.ord !== undefined && !Number.isInteger(patch.ord)) {
      throw new DomainError("VALIDATION", "ord must be an integer", { ord: patch.ord });
    }
    const wip = patch.wipLimit === undefined ? (cur.wipLimit ?? null) : patch.wipLimit;
    if (wip !== null && (!Number.isInteger(wip) || wip < 0)) {
      throw new DomainError("VALIDATION", "wipLimit must be null or a non-negative integer", { wipLimit: wip });
    }
    run(db, "UPDATE column_def SET name = ?, wip_limit = ?, ord = ? WHERE project_id = ? AND id = ?",
      name, wip, Math.trunc(patch.ord ?? cur.ord), projectId, id);
    const next = getColumn(db, projectId, id)!;
    appendTimeline(db, {
      projectId, entityType: "board", entityId: id, kind: "board.column.updated", actor,
      payload: { id, patches: Object.keys(patch), name: next.name, wipLimit: next.wipLimit ?? null }
    });
    return next;
  });
}

// ---------- saved views ----------

interface ViewRow { project_id: string; id: number; name: string; query_json: string }

const toView = (r: ViewRow): SavedView => ({
  projectId: r.project_id, id: Number(r.id), name: r.name, query: parseJson<ViewQuery>(r.query_json, {})
});

export function listViews(db: Db, projectId: ProjectId): SavedView[] {
  return all<ViewRow>(db, "SELECT * FROM saved_view WHERE project_id = ? ORDER BY id ASC", projectId).map(toView);
}

export function getView(db: Db, projectId: ProjectId, id: EntityId): SavedView | null {
  const row = one<ViewRow>(db, "SELECT * FROM saved_view WHERE project_id = ? AND id = ?", projectId, id);
  return row ? toView(row) : null;
}

export function createView(db: Db, projectId: ProjectId, name: string, query: ViewQuery = {}): SavedView {
  const trimmed = name.trim();
  if (trimmed === "") throw new DomainError("VALIDATION", "view name is required");
  return withTx(db, () => {
    const id = nextId(db, projectId, "view");
    asDomain(() => run(db, "INSERT INTO saved_view (project_id, id, name, query_json) VALUES (?, ?, ?, ?)",
      projectId, id, trimmed, JSON.stringify(query)), `view "${trimmed}" already exists in ${projectId}`);
    return getView(db, projectId, id)!;
  });
}

export function updateView(db: Db, projectId: ProjectId, id: EntityId, patch: { name?: string; query?: ViewQuery }): SavedView {
  return withTx(db, () => {
    const cur = getView(db, projectId, id);
    if (!cur) throw new DomainError("NOT_FOUND", `view ${projectId}#${id} not found`);
    const name = patch.name === undefined ? cur.name : patch.name.trim();
    if (name === "") throw new DomainError("VALIDATION", "view name is required");
    asDomain(() => run(db, "UPDATE saved_view SET name = ?, query_json = ? WHERE project_id = ? AND id = ?",
      name, JSON.stringify(patch.query ?? cur.query ?? {}), projectId, id), `view "${name}" already exists in ${projectId}`);
    return getView(db, projectId, id)!;
  });
}

export function deleteView(db: Db, projectId: ProjectId, id: EntityId): void {
  withTx(db, () => {
    const r = run(db, "DELETE FROM saved_view WHERE project_id = ? AND id = ?", projectId, id);
    if (r.changes === 0) throw new DomainError("NOT_FOUND", `view ${projectId}#${id} not found`);
  });
}

// ---------- card templates ----------

interface TemplateRow {
  project_id: string; id: number; name: string; title: string; body: string;
  column_id: string | null; priority: number; labels_json: string; created_at: string; updated_at: string;
}

const toTemplate = (r: TemplateRow): CardTemplate => ({
  projectId: r.project_id, id: Number(r.id), name: r.name, title: r.title, body: r.body,
  columnId: r.column_id, priority: Number(r.priority), labels: parseJson<string[]>(r.labels_json, []),
  createdAt: r.created_at, updatedAt: r.updated_at
});

export interface CreateTemplateInput {
  name: string; title: string; body?: string; columnId?: string | null; priority?: number; labels?: string[];
}

export function listTemplates(db: Db, projectId: ProjectId): CardTemplate[] {
  return all<TemplateRow>(db, "SELECT * FROM card_template WHERE project_id = ? ORDER BY id ASC", projectId).map(toTemplate);
}

export function getTemplate(db: Db, projectId: ProjectId, id: EntityId): CardTemplate | null {
  const row = one<TemplateRow>(db, "SELECT * FROM card_template WHERE project_id = ? AND id = ?", projectId, id);
  return row ? toTemplate(row) : null;
}

export function createTemplate(db: Db, projectId: ProjectId, input: CreateTemplateInput): CardTemplate {
  const name = input.name.trim();
  if (name === "") throw new DomainError("VALIDATION", "template name is required");
  return withTx(db, () => {
    if (input.columnId && !getColumn(db, projectId, input.columnId)) {
      throw new DomainError("VALIDATION", `column ${input.columnId} not found in ${projectId}`);
    }
    const r = run(db,
      `INSERT INTO card_template (project_id, id, name, title, body, column_id, priority, labels_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      projectId, 0, name, input.title ?? "", input.body ?? "", input.columnId ?? null,
      Math.trunc(input.priority ?? 0), JSON.stringify(input.labels ?? []), nowIso(), nowIso());
    run(db, "UPDATE card_template SET id = ? WHERE rowid = ?", r.lastInsertRowid, r.lastInsertRowid);
    return getTemplate(db, projectId, Number(r.lastInsertRowid))!;
  });
}

export function deleteTemplate(db: Db, projectId: ProjectId, id: EntityId): void {
  withTx(db, () => {
    const r = run(db, "DELETE FROM card_template WHERE project_id = ? AND id = ?", projectId, id);
    if (r.changes === 0) throw new DomainError("NOT_FOUND", `template ${projectId}#${id} not found`);
  });
}

/** Instantiate: the template is copied field by field, so later template edits never touch the card. */
export function createCardFromTemplate(db: Db, projectId: ProjectId, templateId: EntityId, opts: { columnId?: string; actor?: string } = {}): Card {
  const tpl = getTemplate(db, projectId, templateId);
  if (!tpl) throw new DomainError("NOT_FOUND", `template ${projectId}#${templateId} not found`);
  const columns = listColumns(db, projectId);
  const columnId = opts.columnId ?? tpl.columnId ?? columns.find(c => c.kind === "todo")?.id ?? columns[0]?.id;
  if (!columnId) throw new DomainError("VALIDATION", `project ${projectId} has no columns`);
  return createCard(db, {
    projectId, columnId, title: tpl.title, body: tpl.body, priority: tpl.priority, labels: tpl.labels ?? []
  }, opts.actor ?? "system");
}

// ---------- attachments ----------

interface AttachmentRow {
  project_id: string; id: number; card_id: number | null; deliverable_id: number | null;
  safe_name: string; mime: string; size: number; created_at: string;
}

const toAttachment = (r: AttachmentRow): Attachment => ({
  projectId: r.project_id, id: Number(r.id), cardId: r.card_id === null ? null : Number(r.card_id),
  deliverableId: r.deliverable_id === null ? null : Number(r.deliverable_id),
  name: r.safe_name, mime: r.mime, size: Number(r.size), createdAt: r.created_at
});

export interface CreateAttachmentInput {
  cardId?: EntityId | null; deliverableId?: EntityId | null; name: string; mime: string; size: number;
}

export function listAttachments(db: Db, projectId: ProjectId, opts: { cardId?: EntityId; deliverableId?: EntityId } = {}): Attachment[] {
  if (opts.cardId !== undefined) {
    return all<AttachmentRow>(db, "SELECT * FROM attachment WHERE project_id = ? AND card_id = ? ORDER BY id ASC", projectId, opts.cardId).map(toAttachment);
  }
  if (opts.deliverableId !== undefined) {
    return all<AttachmentRow>(db, "SELECT * FROM attachment WHERE project_id = ? AND deliverable_id = ? ORDER BY id ASC", projectId, opts.deliverableId).map(toAttachment);
  }
  return all<AttachmentRow>(db, "SELECT * FROM attachment WHERE project_id = ? ORDER BY id ASC", projectId).map(toAttachment);
}

export function getAttachment(db: Db, projectId: ProjectId, id: EntityId): Attachment | null {
  const row = one<AttachmentRow>(db, "SELECT * FROM attachment WHERE project_id = ? AND id = ?", projectId, id);
  return row ? toAttachment(row) : null;
}

/** `name` is the blob file name on disk (content hash), kept separate from the display name. */
export function createAttachment(db: Db, projectId: ProjectId, input: CreateAttachmentInput & { name: string }, blobName: string): Attachment {
  return withTx(db, () => {
    if (input.cardId != null && !getCard(db, projectId, input.cardId)) {
      throw new DomainError("NOT_FOUND", `card ${projectId}#${input.cardId} not found`);
    }
    if (input.deliverableId != null && !getDeliverable(db, projectId, input.deliverableId)) {
      throw new DomainError("NOT_FOUND", `deliverable ${projectId}#${input.deliverableId} not found`);
    }
    const id = nextId(db, projectId, "attachment");
    run(db,
      `INSERT INTO attachment (project_id, id, card_id, deliverable_id, safe_name, mime, size, storage_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      projectId, id, input.cardId ?? null, input.deliverableId ?? null,
      input.name, input.mime, Math.trunc(input.size), blobName, nowIso());
    return getAttachment(db, projectId, id)!;
  });
}

export function attachmentBlobName(db: Db, projectId: ProjectId, id: EntityId): string | null {
  const row = one<{ storage_key: string }>(db, "SELECT storage_key FROM attachment WHERE project_id = ? AND id = ?", projectId, id);
  return row ? row.storage_key : null;
}

/** Deleting the row is not deleting the blob: the caller removes the file once `true` is returned. */
export function deleteAttachment(db: Db, projectId: ProjectId, id: EntityId): { blobName: string; shared: boolean } {
  return withTx(db, () => {
    const blobName = attachmentBlobName(db, projectId, id);
    if (blobName === null) throw new DomainError("NOT_FOUND", `attachment ${projectId}#${id} not found`);
    run(db, "DELETE FROM attachment WHERE project_id = ? AND id = ?", projectId, id);
    const still = one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM attachment WHERE storage_key = ?", blobName);
    return { blobName, shared: Number(still?.n ?? 0) > 0 };
  });
}

// ---------- doing loop ----------

interface LoopRow {
  project_id: string; status: string; mode: string; started_at: string | null; halted_at: string | null;
  halt_reason: string | null; last_tick_at: string | null; ticks: number; next_card_id: number | null;
}

const toLoop = (r: LoopRow): LoopState => ({
  projectId: r.project_id, status: r.status === "running" || r.status === "halted" ? r.status : "idle",
  mode: "suggest", startedAt: r.started_at, haltedAt: r.halted_at, haltReason: r.halt_reason,
  lastTickAt: r.last_tick_at, ticks: Number(r.ticks), nextCardId: r.next_card_id === null ? null : Number(r.next_card_id)
});

/** Absent row means idle: the loop is not created until someone starts it. */
export function getLoop(db: Db, projectId: ProjectId): LoopState {
  const row = one<LoopRow>(db, "SELECT * FROM loop_state WHERE project_id = ?", projectId);
  return row ? toLoop(row) : { projectId, status: "idle", mode: "suggest", startedAt: null, haltedAt: null, haltReason: null, lastTickAt: null, ticks: 0, nextCardId: null };
}

export function saveLoop(db: Db, state: LoopState, actor = "system", kind: EventKind = "loop.tick"): LoopState {
  return withTx(db, () => {
    run(db,
      `INSERT INTO loop_state (project_id, status, mode, started_at, halted_at, halt_reason, last_tick_at, ticks, next_card_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         status = excluded.status, mode = excluded.mode, started_at = excluded.started_at,
         halted_at = excluded.halted_at, halt_reason = excluded.halt_reason,
         last_tick_at = excluded.last_tick_at, ticks = excluded.ticks, next_card_id = excluded.next_card_id`,
      state.projectId, state.status, state.mode, state.startedAt, state.haltedAt, state.haltReason,
      state.lastTickAt, Math.trunc(state.ticks), state.nextCardId);
    appendTimeline(db, {
      projectId: state.projectId, entityType: "loop", entityId: state.projectId, kind, actor,
      payload: { status: state.status, ticks: state.ticks, nextCardId: state.nextCardId, haltReason: state.haltReason }
    });
    return getLoop(db, state.projectId);
  });
}
