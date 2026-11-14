// Pure validation primitives shared by every domain module. No IO, no pi, no sqlite.
import { DomainError, type ErrorCode } from "../shared/errors.js";
import type { ColumnKind } from "../shared/dto.js";
import type { EntityId } from "../shared/ids.js";

export const PRIORITY_MIN = -99;
export const PRIORITY_MAX = 99;
export const DEFAULT_PRIORITY = 0;
export const TITLE_MAX = 500;
export const BODY_MAX = 200_000;
export const NAME_MAX = 100;
export const LABEL_MAX = 64;
export const LABELS_MAX = 32;
export const PROJECT_SLUG_MAX = 64;
export const COLUMN_ID_MAX = 32;
export const WIP_LIMIT_MAX = 999;

export const COLUMN_KINDS = ["todo", "doing", "done", "custom"] as const;
export const COLUMN_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
export const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;
export const DUE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A clock. `Date` or an ISO-8601 string; strings are re-normalized to ISO. */
export type At = Date | string;

export function domainError(code: ErrorCode, message: string, details?: unknown): DomainError {
  return new DomainError(code, message, details);
}

export function invalid(message: string, details?: unknown): DomainError {
  return domainError("VALIDATION", message, details);
}

/** Deterministic clock normalization: everything leaving the domain is ISO-8601 UTC. */
export function isoAt(now?: At): string {
  if (now === undefined) return new Date().toISOString();
  const d = typeof now === "string" ? new Date(now) : now;
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) throw invalid("invalid timestamp", { now });
  return d.toISOString();
}

function text(v: unknown, field: string, max: number, min = 1): string {
  if (typeof v !== "string") throw invalid(`${field} must be a string`, { field });
  const s = v.trim();
  if (s.length < min) throw invalid(`${field} must not be empty`, { field });
  if (s.length > max) throw invalid(`${field} is longer than ${max} characters`, { field, length: s.length });
  return s;
}

export function assertName(v: unknown, field = "name"): string {
  return text(v, field, NAME_MAX);
}

export function assertTitle(v: unknown): string {
  return text(v, "title", TITLE_MAX);
}

/** Body keeps its internal whitespace; only the outer trim and length are enforced. */
export function assertBody(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw invalid("body must be a string", { field: "body" });
  const s = v.trim();
  if (s.length > BODY_MAX) throw invalid(`body is longer than ${BODY_MAX} characters`, { length: s.length });
  return s;
}

export function assertPriority(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v)) throw invalid(`priority must be an integer ${PRIORITY_MIN}..${PRIORITY_MAX}`, { priority: v });
  if (v < PRIORITY_MIN || v > PRIORITY_MAX) throw invalid(`priority must be an integer ${PRIORITY_MIN}..${PRIORITY_MAX}`, { priority: v });
  return v;
}

/** Labels are trimmed, de-duplicated and kept in first-seen order. */
export function assertLabels(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw invalid("labels must be an array", { field: "labels" });
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw !== "string") throw invalid("label must be a string", { field: "labels" });
    const s = raw.trim();
    if (s === "") continue;
    if (s.length > LABEL_MAX) throw invalid(`label is longer than ${LABEL_MAX} characters`, { label: s });
    if (!out.includes(s)) out.push(s);
  }
  if (out.length > LABELS_MAX) throw invalid(`more than ${LABELS_MAX} labels`, { count: out.length });
  return out;
}

export function assertOwner(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  return text(v, "owner", NAME_MAX);
}

/** Calendar date, `YYYY-MM-DD`. */
export function assertDue(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !DUE_RE.test(v)) throw invalid("due must be a YYYY-MM-DD date", { due: v });
  const d = new Date(`${v}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw invalid("due is not a real date", { due: v });
  return v;
}

export function assertEstimate(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw invalid("estimate must be a finite number >= 0", { estimate: v });
  return v;
}

export function assertBlockedReason(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = typeof v === "string" ? v.trim() : v;
  if (s === "") return null;
  if (typeof s !== "string") throw invalid("blockedReason must be a string", { field: "blockedReason" });
  if (s.length > TITLE_MAX) throw invalid(`blockedReason is longer than ${TITLE_MAX} characters`);
  return s;
}

/** Project-local numeric id: integer >= 1. */
export function assertId(v: unknown, field = "id"): EntityId {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw invalid(`${field} must be an integer >= 1`, { field, [field]: v });
  return v;
}

/** Optimistic-lock version: integer >= 1. */
export function assertVersion(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw invalid("version must be an integer >= 1", { version: v });
  return v;
}

export function assertProjectId(v: unknown): string {
  return assertSlug(v, "projectId");
}

export function assertSlug(v: unknown, field = "slug"): string {
  if (typeof v !== "string") throw invalid(`${field} must be a string`, { field });
  const s = v.trim();
  if (s.length === 0 || s.length > PROJECT_SLUG_MAX) throw invalid(`${field} must be 1..${PROJECT_SLUG_MAX} characters`, { field });
  if (!SLUG_RE.test(s)) throw invalid(`${field} may only contain a-z, 0-9, "-", "_", "." and must start alphanumeric`, { field, [field]: s });
  return s;
}

export function assertColumnId(v: unknown): string {
  if (typeof v !== "string") throw invalid("column id must be a string", { columnId: v });
  const s = v.trim();
  if (s.length === 0 || s.length > COLUMN_ID_MAX) throw invalid(`column id must be 1..${COLUMN_ID_MAX} characters`, { columnId: v });
  if (!COLUMN_ID_RE.test(s)) throw invalid(`column id may only contain a-z, 0-9, "-", "_" and must start alphanumeric`, { columnId: s });
  return s;
}

export function assertColumnName(v: unknown): string {
  return text(v, "column name", NAME_MAX);
}

export function isColumnKind(v: unknown): v is ColumnKind {
  return typeof v === "string" && (COLUMN_KINDS as readonly string[]).includes(v);
}

export function assertColumnKind(v: unknown): ColumnKind {
  if (!isColumnKind(v)) throw invalid(`column kind must be one of ${COLUMN_KINDS.join("|")}`, { kind: v });
  return v;
}

/** WIP limit: `null` = unlimited, otherwise an integer >= 1. */
export function assertWipLimit(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > WIP_LIMIT_MAX) {
    throw invalid(`wipLimit must be an integer 1..${WIP_LIMIT_MAX} or null`, { wipLimit: v });
  }
  return v;
}

/** Derive a safe id from free text (lowercase, non-alphanumerics collapse to "-"). */
export function slugify(v: string, max = COLUMN_ID_MAX): string {
  const s = String(v)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return s;
}
