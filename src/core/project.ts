// Project + column definitions. Pure constructors and patchers; no persistence.
import type { ColumnDef, ColumnKind, Project } from "../shared/dto.js";
import type { ProjectId } from "../shared/ids.js";
import {
  assertColumnId, assertColumnKind, assertColumnName, assertName, assertSlug, assertWipLimit,
  domainError, isoAt, slugify, type At,
} from "./validation.js";

/** The three structural columns every project is created with, in order. */
export const DEFAULT_COLUMNS: readonly { id: string; name: string; kind: ColumnKind }[] = [
  { id: "todo", name: "TODO", kind: "todo" },
  { id: "doing", name: "DOING", kind: "doing" },
  { id: "done", name: "DONE", kind: "done" },
];

/** Column kinds that carry board semantics and therefore cannot be removed. */
export const STRUCTURAL_KINDS: readonly ColumnKind[] = ["todo", "done"];

export interface CreateProjectInput {
  slug: string;
  name?: string;
  settings?: Record<string, unknown>;
}

export function createProject(input: CreateProjectInput, opts: { now?: At } = {}): Project {
  const slug = assertSlug(input.slug);
  const ts = isoAt(opts.now);
  const project: Project = {
    projectId: slug,
    slug,
    name: input.name === undefined ? slug : assertName(input.name, "project name"),
    createdAt: ts,
    updatedAt: ts,
  };
  if (input.settings !== undefined) project.settings = input.settings;
  return project;
}

export function touchProject(p: Project, opts: { now?: At } = {}): Project {
  return { ...p, updatedAt: isoAt(opts.now) };
}

export function renameProject(p: Project, name: string, opts: { now?: At } = {}): Project {
  return { ...touchProject(p, opts), name: assertName(name, "project name") };
}

export function updateProjectSettings(p: Project, settings: Record<string, unknown>, opts: { now?: At } = {}): Project {
  return { ...touchProject(p, opts), settings: { ...(p.settings ?? {}), ...settings } };
}

export function defaultColumns(projectId: ProjectId): ColumnDef[] {
  const pid = assertSlug(projectId, "projectId");
  return DEFAULT_COLUMNS.map((c, i) => ({ projectId: pid, id: c.id, name: c.name, kind: c.kind, ord: i, wipLimit: null }));
}

export function columnsByOrd(columns: readonly ColumnDef[]): ColumnDef[] {
  return [...columns].sort((a, b) => a.ord - b.ord || a.id.localeCompare(b.id));
}

export function findColumn(columns: readonly ColumnDef[], id: string): ColumnDef {
  const col = columns.find(c => c.id === id);
  if (!col) throw domainError("NOT_FOUND", `column "${id}" does not exist`, { columnId: id });
  return col;
}

export function columnIdsOf(columns: readonly ColumnDef[]): string[] {
  return columns.map(c => c.id);
}

export interface CreateColumnInput {
  id?: string;
  name: string;
  kind?: ColumnKind;
  wipLimit?: number | null;
}

/** Custom column with a derived, collision-free id (name slug, then `-2`, `-3`, ...). */
export function createColumn(projectId: ProjectId, input: CreateColumnInput, existing: readonly ColumnDef[] = []): ColumnDef {
  const pid = assertSlug(projectId, "projectId");
  const name = assertColumnName(input.name);
  const used = new Set(existing.map(c => c.id));
  let id: string;
  if (input.id !== undefined) {
    id = assertColumnId(input.id);
    if (used.has(id)) throw domainError("CONFLICT", `column "${id}" already exists`, { columnId: id });
  } else {
    const base = slugify(name) || "column";
    id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`.slice(0, 32);
  }
  const ord = existing.reduce((m, c) => Math.max(m, c.ord), -1) + 1;
  return { projectId: pid, id, name, kind: input.kind === undefined ? "custom" : assertColumnKind(input.kind), ord, wipLimit: assertWipLimit(input.wipLimit) };
}

export interface ColumnPatch {
  name?: string;
  kind?: ColumnKind;
  wipLimit?: number | null;
  ord?: number;
}

export function patchColumn(col: ColumnDef, patch: ColumnPatch): ColumnDef {
  const next: ColumnDef = { ...col };
  if (patch.name !== undefined) next.name = assertColumnName(patch.name);
  if (patch.kind !== undefined) next.kind = assertColumnKind(patch.kind);
  if (patch.wipLimit !== undefined) next.wipLimit = assertWipLimit(patch.wipLimit);
  if (patch.ord !== undefined) {
    if (!Number.isInteger(patch.ord) || patch.ord < 0) throw domainError("VALIDATION", "ord must be an integer >= 0", { ord: patch.ord });
    next.ord = patch.ord;
  }
  return next;
}

/**
 * Removes a custom/doing column and re-indexes `ord`. Structural (todo/done) columns and
 * the last remaining column are refused; callers must move cards out first.
 */
export function removeColumn(columns: readonly ColumnDef[], id: string): ColumnDef[] {
  const target = findColumn(columns, id);
  if (STRUCTURAL_KINDS.includes(target.kind)) {
    throw domainError("CONFLICT", `column "${id}" is structural (${target.kind}) and cannot be removed`, { columnId: id, kind: target.kind });
  }
  if (columns.length <= 1) throw domainError("CONFLICT", "a project must keep at least one column", { columnId: id });
  return columnsByOrd(columns.filter(c => c.id !== id)).map((c, i) => ({ ...c, ord: i }));
}
