// The Phase 0 HTTP surface. Envelope is `{ok:true,data}` / `{ok:false,error:{code,message}}`
// (src/shared/errors.ts). Every write resolves its project first and never takes a bare id.
//
// Contract notes:
//   - a stale `version` is 409 STALE_VERSION (details carry the current version)
//   - an unknown column is 422 VALIDATION, an unknown project/card 404 NOT_FOUND
//   - WIP limits are domain rules: they are enforced here with core.wipError, in addition
//     to the repository's column check (repos does not know about WIP)
import { createReadStream, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join } from "node:path";
import type http from "node:http";
import { DomainError, fail, ok, type ErrorCode } from "../shared/errors.js";
import type { LoopSettings } from "../shared/dto.js";
import type { Db } from "../persistence/db.js";
import { one } from "../persistence/db.js";
import { LATEST_SCHEMA_VERSION, schemaVersion } from "../persistence/migrations.js";
import type { HomeState } from "../persistence/init.js";
import {
  attachmentBlobName, createAttachment, createCard, createCardFromTemplate, createDeliverable, createProject,
  createTemplate, createView, deleteAttachment, deleteCard, deleteDeliverable, deleteProject, deleteTemplate, deleteView,
  getAttachment, getCard, getColumn, getDeliverable, getLoop, getLoopSettings, getProject, getProjectBySlug, listAttachments,
  listCards, listColumns,
  listDeliverables, listDependencies, listProjects, listTemplates, listTimeline, listViews, moveCard,
  readBoard, removeDependency, saveLoop, saveLoopSettings, updateCard, updateColumn, updateView, addDependency, digestInput,
  type UpdateCardPatch,
} from "../persistence/repos.js";
import { defaultColumnId, makeBoard, staleDoingCount } from "../core/board.js";
import { assertDependencyAddable, assertDependencyType, closedLookup, openBlockersOf } from "../core/dependency.js";
import { MAX_ATTACHMENT_BYTES, safeAttachmentName } from "../core/attachment.js";
import { blobPath, storeBlob } from "../media.js";
import { graphLayout } from "../core/graph.js";
import { buildDigest, parseSince } from "../core/digest.js";
import { esc, md } from "../core/markdown.js";
import { deliverNotifications, parseSinkSetting, SINK_ENV } from "../core/notify-sink.js";
import { acquireLock, assertResource, assertTtlSeconds, listLocks, releaseLock } from "../persistence/locks.js";
import { initialLoopState, startLoop, stopLoop } from "../core/loop.js";
import { tickProject } from "../loop-runner.js";
import type { Wake } from "../supervisor.js";
import { notifications } from "../core/notify.js";
import { forgetCard, forgetProject, runningWakes, sessionDirOf } from "../agent/driver.js";
import { readSessions } from "../core/sessions.js";
import { clampSearchLimit, compareScored, searchBoardScored, type ScoredHit } from "../core/search.js";
import { parseQuickAdd } from "../core/quickadd.js";
import {
  assertBody, assertBlockedReason, assertColumnId, assertDue, assertEstimate, assertId, assertLabels,
  assertName, assertOwner, assertPriority, assertSlug, assertTitle, assertVersion,
} from "../core/validation.js";

export const API_VERSION = "2.0.0-dev";
export const CAPABILITIES = [
  "meta", "selftest", "projects", "project.delete", "board", "timeline", "cards", "card.move", "card.delete",
  "dependencies", "deliverables",
  "columns.update", "views", "templates", "attachments", "search", "notifications", "graph", "overview", "loop",
  "digest", "locks", "sessions",
];

const ACTOR = "ui";
const MAX_BODY_BYTES = 1024 * 1024;

export interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  db: Db | null;
  home: string;
  state: HomeState;
  token: string | null;
  /** Token gate state, echoed by meta so a client knows whether to send one. */
  auth: boolean;
  version: string;
  buildHash: string;
  /** Supervisor cadence, so /api/loop can say when the next tick is due. 0 = no loop. */
  loopMs: number;
  /** Wake a DOING card's session after a manual move. Absent = the board never wakes. */
  wake?: Wake;
  /** Re-arm the supervisor when the saved interval changes; absent means the caller tests only. */
  restartSupervisor?: (ms: number) => void;
}

/** A transport-level failure (status is not derivable from the domain ErrorCode alone). */
export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION: 422,
  WIP_LIMIT: 409,
  CYCLE: 409,
  STALE_VERSION: 409,
  INTERNAL: 500,
};

export function sendJson(ctx: Ctx, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const s = JSON.stringify(body);
  ctx.res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(s),
    "cache-control": "no-store",
    ...headers,
  });
  ctx.res.end(s);
}

export function sendError(ctx: Ctx, err: unknown): void {
  if (err instanceof HttpError) return sendJson(ctx, err.status, fail(err.code, err.message, err.details));
  if (err instanceof DomainError) {
    const status = STATUS[err.code] ?? 500;
    return sendJson(ctx, status, fail(err.code, err.message, err.details));
  }
  // An unclassified error can carry SQLite's own text — table names, absolute paths. Log it,
  // and tell the client only that it failed.
  console.error("kanban: unhandled error", err);
  sendJson(ctx, 500, fail("INTERNAL", "internal error"));
}

const notInitialized = (ctx: Ctx): HttpError => new HttpError(503, "INTERNAL",
  `kanban home ${ctx.home} is not initialized (${ctx.state.status}). ` +
  `Start the server without init:false to let it initialize (any old layout is moved to a dated ` +
  `backup, never deleted), or run the v2 init with --confirm after reviewing the targets.`);

function requireDb(ctx: Ctx): Db {
  if (!ctx.db) throw notInitialized(ctx);
  return ctx.db;
}

// ---------------------------------------------------------------- request helpers

async function readJson(ctx: Ctx): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of ctx.req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "BAD_REQUEST", `body is larger than ${MAX_BODY_BYTES} bytes`);
    chunks.push(buf);
  }
  if (size === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "BAD_REQUEST", "body is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "BAD_REQUEST", "body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * `lastActor` (and any other timeline projection) is read-only: a write carrying it is a
 * client bug, not something to silently drop.
 */
function rejectReadOnly(body: Record<string, unknown>, fields: readonly string[]): void {
  for (const field of fields) {
    if (field in body) throw new DomainError("VALIDATION", `${field} is read-only`, { field });
  }
}

const CARD_READ_ONLY_FIELDS = ["lastActor"] as const;

const str = (v: unknown, field: string): string => {
  if (typeof v !== "string" || v.trim() === "") throw new HttpError(400, "BAD_REQUEST", `${field} is required`);
  return v.trim();
};

const decodeSegment = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new HttpError(400, "BAD_REQUEST", "malformed percent-encoding in path");
  }
};

function projectOr404(db: Db, ref: string) {
  const project = getProjectBySlug(db, ref) ?? getProject(db, ref);
  if (!project) throw new DomainError("NOT_FOUND", `project ${ref} not found`);
  return project;
}

/** "My Project 2" -> "my-project-2". Non-latin names collapse to "project" and fail assertSlug. */
function slugify(name: string): string {
  const s = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return s.length > 0 ? s : "project";
}

/** Unknown columns are a request error (422), not "missing resource" — repos agrees. */
function assertColumn(db: Db, projectId: string, columnId: string): string {
  const id = assertColumnId(columnId);
  if (!getColumn(db, projectId, id)) throw new DomainError("VALIDATION", `column ${id} not found in ${projectId}`);
  return id;
}

function boardState(db: Db, projectId: string) {
  const snap = readBoard(db, projectId);
  if (!snap) throw new DomainError("NOT_FOUND", `project ${projectId} not found`);
  return { snap, state: makeBoard(snap.project, snap.columns, snap.cards) };
}

// ---------------------------------------------------------------------- handlers

function getMeta(ctx: Ctx): void {
  sendJson(ctx, 200, ok({
    version: ctx.version,
    buildHash: ctx.buildHash,
    auth: ctx.auth ? "token" : "off",
    schemaVersion: ctx.db ? schemaVersion(ctx.db) : (ctx.state.schemaVersion ?? 0),
    capabilities: CAPABILITIES,
  }));
}

function getSelftest(ctx: Ctx): void {
  let dbOk = false;
  let dbError: string | null = null;
  let integrity: string | null = null;
  if (ctx.db) {
    try {
      one(ctx.db, "SELECT 1 AS x");
      // A page-level integrity check, not just "the handle answers": a home whose WAL was
      // truncated by a hard kill still passes SELECT 1.
      const row = one<{ quick_check?: string }>(ctx.db, "PRAGMA quick_check");
      integrity = row?.quick_check ?? null;
      dbOk = integrity === "ok";
      if (!dbOk) dbError = `PRAGMA quick_check: ${integrity ?? "no result"}`;
    } catch (err) {
      dbError = err instanceof Error ? err.message : String(err);
    }
  } else {
    dbError = "kanban home is not initialized";
  }
  // Two independent failure modes: the db will not answer, and the db is not the schema this
  // build expects (a half-applied migration looks healthy to every query until it does not).
  const version = ctx.db ? schemaVersion(ctx.db) : (ctx.state.schemaVersion ?? 0);
  const schemaOk = ctx.db !== null && version === LATEST_SCHEMA_VERSION;
  sendJson(ctx, 200, ok({
    ok: dbOk && schemaOk,
    version: ctx.version,
    buildHash: ctx.buildHash,
    auth: ctx.auth ? "token" : "off",
    schemaVersion: version,
    schema: { version, expected: LATEST_SCHEMA_VERSION, ok: schemaOk },
    db: { ok: dbOk, error: dbError, integrity },
    home: { path: ctx.home, status: ctx.state.status, initialized: ctx.state.initialized },
    capabilities: CAPABILITIES,
  }));
}

function getProjects(ctx: Ctx): void {
  const projects = listProjects(requireDb(ctx)).map(p => ({ projectId: p.projectId, slug: p.slug, name: p.name }));
  sendJson(ctx, 200, ok({ projects }));
}

async function postProject(ctx: Ctx): Promise<void> {
  const db = requireDb(ctx);
  const body = await readJson(ctx);
  const name = body.name === undefined ? undefined : assertName(body.name, "project name");
  // The shell posts only a name, so derive the slug from it; an explicit slug still wins.
  if (body.slug === undefined && name === undefined) {
    throw new HttpError(422, "VALIDATION", "project needs a slug or a name");
  }
  const slug = body.slug === undefined
    ? assertSlug(slugify(name ?? ""), "slug")
    : assertSlug(body.slug, "slug");
  const project = createProject(db, {
    slug, ...(name === undefined ? {} : { name }),
    ...(body.settings === undefined ? {} : { settings: assertSettings(body.settings) }),
  }, ACTOR);
  sendJson(ctx, 201, ok({ project, columns: listColumns(db, slug) }));
}

function deleteProjectRoute(ctx: Ctx, m: RegExpExecArray): void {
  const db = requireDb(ctx);
  const project = projectOr404(db, decodeSegment(m[1]));
  deleteProject(db, project.projectId, ACTOR);
  // Same reason as deleteCard's forgetCard: a watcher entry for a board that no longer exists
  // would refuse every later wake once the slug is created again.
  forgetProject(project.projectId);
  sendJson(ctx, 200, ok({ deleted: { projectId: project.projectId, slug: project.slug } }));
}

/** Board settings are a plain JSON object (`cwd` is the one this code reads). */
function assertSettings(v: unknown): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new HttpError(422, "VALIDATION", "settings must be an object");
  }
  return v as Record<string, unknown>;
}

function getBoard(ctx: Ctx): void {
  const db = requireDb(ctx);
  const ref = str(ctx.url.searchParams.get("project"), "project");
  const project = projectOr404(db, ref);
  sendJson(ctx, 200, ok(readBoard(db, project.projectId)!));
}

function getTimeline(ctx: Ctx): void {
  const db = requireDb(ctx);
  const project = projectOr404(db, str(ctx.url.searchParams.get("project"), "project"));
  const limit = Number(ctx.url.searchParams.get("limit") ?? 100);
  const sinceSeq = Number(ctx.url.searchParams.get("since") ?? 0);
  if (!Number.isFinite(limit) || !Number.isFinite(sinceSeq)) {
    throw new HttpError(400, "BAD_REQUEST", "limit and since must be numbers");
  }
  sendJson(ctx, 200, ok({ events: listTimeline(db, project.projectId, { limit, sinceSeq }) }));
}

async function postCard(ctx: Ctx): Promise<void> {
  const db = requireDb(ctx);
  const body = await readJson(ctx);
  rejectReadOnly(body, CARD_READ_ONLY_FIELDS);
  // v1 quick-add: leading `#proj` `!N` `due:DATE` tokens name the card's fields, the rest is
  // the title. The same parser runs on the /kanban command path (src/core/quickadd.ts).
  const qa = typeof body.title === "string" ? parseQuickAdd(body.title) : null;
  if (qa !== null && !qa.ok) throw new HttpError(400, "BAD_REQUEST", qa.error);
  const quick = qa !== null && qa.ok ? qa.value : null;
  // `#slug` retargets the card, creating the board when it is new — v1's quick add did the same.
  // Only creation parses tokens; PATCH title does not, which is v1's asymmetry and stayed.
  const project = quick?.project == null
    ? projectOr404(db, str(body.project, "project"))
    : (getProjectBySlug(db, quick.project)
      ?? createProject(db, { slug: quick.project, name: quick.project }, ACTOR));
  const { state } = boardState(db, project.projectId);

  const columnId = body.columnId === undefined
    ? defaultColumnId(state)
    : assertColumn(db, project.projectId, assertColumnId(body.columnId));
  const card = createCard(db, {
    projectId: project.projectId,
    columnId,
    title: assertTitle(quick === null ? body.title : quick.title),
    body: assertBody(body.body),
    priority: body.priority === undefined ? 0 : assertPriority(body.priority),
    owner: assertOwner(body.owner),
    due: assertDue(quick?.due ?? body.due),
    estimate: assertEstimate(quick?.estimate ?? body.estimate),
    labels: assertLabels(body.labels),
    blockedReason: assertBlockedReason(body.blockedReason),
  }, ACTOR);
  // A card created straight into DOING is the same request a drop is: run it.
  fireWake(ctx, db, project, card);
  sendJson(ctx, 201, ok({ card }));
}

async function patchCard(ctx: Ctx, m: RegExpExecArray): Promise<void> {
  const db = requireDb(ctx);
  const project = projectOr404(db, decodeSegment(m[1]));
  const id = assertId(Number(m[2]));
  const body = await readJson(ctx);
  rejectReadOnly(body, CARD_READ_ONLY_FIELDS);
  const expectedVersion = assertVersion(body.version);

  const patch: UpdateCardPatch = {};
  if ("title" in body) patch.title = assertTitle(body.title);
  if ("body" in body) patch.body = assertBody(body.body);
  if ("priority" in body) patch.priority = assertPriority(body.priority);
  if ("labels" in body) patch.labels = assertLabels(body.labels);
  if ("owner" in body) patch.owner = assertOwner(body.owner);
  if ("due" in body) patch.due = assertDue(body.due);
  if ("estimate" in body) patch.estimate = assertEstimate(body.estimate);
  if ("blockedReason" in body) patch.blockedReason = assertBlockedReason(body.blockedReason);
  // ref is a reference to a local path, never a copy: an empty string clears it.
  if ("ref" in body) patch.ref = body.ref === null ? null : optText(body.ref, "ref", 2000) || null;
  // The digest reports landed commits, so the hash has to be writable from the API too.
  if ("commit" in body) patch.commit = body.commit === null ? null : optText(body.commit, "commit", 64) || null;
  // The session a wake resumes. A card stores the id only; the picker shows the name it maps to.
  if ("sessionId" in body) patch.sessionId = body.sessionId === null ? null : optText(body.sessionId, "sessionId", 128) || null;
  const card = updateCard(db, project.projectId, id, patch, { expectedVersion, actor: ACTOR });
  sendJson(ctx, 200, ok({ card }));
}

/**
 * A wake reaches pi-web, which may take a while to start the session: never await it here. A
 * failed wake is logged, not thrown — the supervisor's pass is the retry.
 */
function fireWake(ctx: Ctx, db: Db, project: Parameters<Wake>[1], card: Parameters<Wake>[2]): void {
  if (!ctx.wake || getColumn(db, project.projectId, card.columnId)?.kind !== "doing") return;
  void ctx.wake(db, project, card).catch((err: unknown) => {
    console.error(`[kanban] wake ${project.slug}#${card.id} failed:`, err instanceof Error ? err.message : err);
  });
}

async function postCardMove(ctx: Ctx, m: RegExpExecArray): Promise<void> {
  const db = requireDb(ctx);
  const project = projectOr404(db, decodeSegment(m[1]));
  const id = assertId(Number(m[2]));
  const body = await readJson(ctx);
  const expectedVersion = assertVersion(body.version);
  const columnId = assertColumn(db, project.projectId, assertColumnId(body.columnId));

  // WIP and the same-column no-op live in repos.moveCard, so templates and the agent
  // adapter hit the same rule as this route.
  const before = getCard(db, project.projectId, id);
  const card = moveCard(db, project.projectId, id, columnId, { expectedVersion, actor: ACTOR });
  // A drop into the column the card is already in is a no-op, not a second run: waking it
  // would only refill the queue with the prompt the running session already has.
  if (before?.columnId !== columnId) fireWake(ctx, db, project, card);
  sendJson(ctx, 200, ok({ card }));
}

async function deleteCardRoute(ctx: Ctx, m: RegExpExecArray): Promise<void> {
  const db = requireDb(ctx);
  const project = projectOr404(db, decodeSegment(m[1]));
  const id = assertId(Number(m[2]));
  const body = await readJson(ctx);
  const raw = body.version ?? ctx.url.searchParams.get("version") ?? undefined;
  const expectedVersion = raw === undefined ? undefined : assertVersion(Number(raw));

  deleteCard(db, project.projectId, id, { expectedVersion, actor: ACTOR });
  // The watcher entry outliving its card would make every later wake for this board look busy.
  forgetCard(project.projectId, id);
  sendJson(ctx, 200, ok({ deleted: { projectId: project.projectId, id } }));
}

// -------------------------------------------------------------- dependencies
// Edges are project data, so every call names the project; a bare card id never resolves.
// The cycle/duplicate rules live in core (assertDependencyAddable); repos only persists.

function getDependencies(ctx: Ctx): void {
  const db = requireDb(ctx);
  const project = projectOr404(db, str(ctx.url.searchParams.get("project"), "project"));
  sendJson(ctx, 200, ok({ dependencies: listDependencies(db, project.projectId) }));
}

async function postDependency(ctx: Ctx): Promise<void> {
  const db = requireDb(ctx);
  const body = await readJson(ctx);
  const project = projectOr404(db, str(body.project, "project"));
  const fromCard = assertId(Number(body.fromCard), "fromCard");
  const toCard = assertId(Number(body.toCard), "toCard");
  const type = body.type === undefined ? "blocks" : assertDependencyType(body.type);

  assertDependencyAddable(listDependencies(db, project.projectId), fromCard, toCard, type);
  const dependency = addDependency(db, { projectId: project.projectId, fromCard, toCard, type }, ACTOR);
  sendJson(ctx, 201, ok({ dependency }));
}

function deleteDependency(ctx: Ctx): void {
  const db = requireDb(ctx);
  const q = ctx.url.searchParams;
  const project = projectOr404(db, str(q.get("project"), "project"));
  const fromCard = assertId(Number(q.get("from")), "from");
  const toCard = assertId(Number(q.get("to")), "to");
  const raw = q.get("type") ?? "blocks";
  const type = assertDependencyType(raw);

  removeDependency(db, { projectId: project.projectId, fromCard, toCard, type }, ACTOR);
  sendJson(ctx, 200, ok({ removed: { projectId: project.projectId, fromCard, toCard, type } }));
}

// -------------------------------------------------------------- deliverables

function getDeliverables(ctx: Ctx): void {
  const db = requireDb(ctx);
  const project = projectOr404(db, str(ctx.url.searchParams.get("project"), "project"));
  const rawCard = ctx.url.searchParams.get("cardId");
  const cardId = rawCard === null ? undefined : assertId(Number(rawCard));
  sendJson(ctx, 200, ok({ deliverables: listDeliverables(db, project.projectId, cardId === undefined ? {} : { cardId }) }));
}

/** Free-text fields that are allowed to be empty but not over-long. */
function optText(v: unknown, field: string, max = 500): string {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new HttpError(400, "BAD_REQUEST", `${field} must be a string`);
  const s = v.trim();
  if (s.length > max) throw new DomainError("VALIDATION", `${field} is longer than ${max} characters`, { field });
  return s;
}

async function postDeliverable(ctx: Ctx): Promise<void> {
  const db = requireDb(ctx);
  const body = await readJson(ctx);
  const project = projectOr404(db, str(body.project, "project"));
  const title = assertTitle(body.title);
  const kind = optText(body.kind, "kind", 32);
  const cardId = body.cardId === undefined || body.cardId === null ? null : assertId(Number(body.cardId), "cardId");
  const deliverable = createDeliverable(db, {
    projectId: project.projectId, title, ref: optText(body.ref, "ref"), kind: kind || "note", cardId,
  }, ACTOR);
  sendJson(ctx, 201, ok({ deliverable }));
}

async function deleteDeliverableRoute(ctx: Ctx, m: RegExpExecArray): Promise<void> {
  const db = requireDb(ctx);
  const project = projectOr404(db, decodeSegment(m[1]));
  const id = assertId(Number(m[2]));
  deleteDeliverable(db, project.projectId, id, ACTOR);
  sendJson(ctx, 200, ok({ deleted: { projectId: project.projectId, id } }));
}

// -------------------------------------------------------------- deliverable files

/** Extensions the viewer knows; anything else is offered as a download. */
const EXT_MIME: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".mov": "video/quicktime",
  ".zip": "application/zip",
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
};

/**
 * A ref is an absolute path; a relative one is read from the home dir. `..` is refused outright
 * and the surviving path is realpath'd, so neither traversal nor a symlink can point elsewhere.
 */
function resolveRef(home: string, ref: string): string {
  if (ref === "" || ref.split(/[\\/]/).includes("..")) {
    throw new DomainError("NOT_FOUND", `ref ${ref} is not servable`);
  }
  const p = isAbsolute(ref) ? ref : join(home, ref);
  try {
    const real = realpathSync(p);
    if (!statSync(real).isFile()) throw new Error("not a file");
    return real;
  } catch {
    throw new DomainError("NOT_FOUND", `ref ${ref} is missing on disk`);
  }
}

interface FileSource {
  file: string;
  name: string;
  mime: string;
  /** Where the raw bytes live, for the viewer's <img>/<video>/<iframe>. */
  src: string;
  /** Serve the bytes as an inline download under this name (attachments). */
  download?: string;
  cache?: string;
}

function deliverableRef(ctx: Ctx, m: RegExpExecArray): FileSource {
  const db = requireDb(ctx);
  const project = projectOr404(db, decodeSegment(m[1]));
  const id = assertId(Number(m[2]));
  const d = getDeliverable(db, project.projectId, id);
  if (!d) throw new DomainError("NOT_FOUND", `deliverable ${project.projectId}#${id} not found`);
  const file = resolveRef(ctx.home, d.ref.trim());
  return {
    file, name: basename(file), mime: EXT_MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
    src: `/api/deliverables/${encodeURIComponent(project.slug)}/${id}/file`,
  };
}

/** `bytes=a-b` only — a player never asks for more. Null means "send the whole thing". */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (header === undefined) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  const [rawStart, rawEnd] = m === null ? [undefined, undefined] : [m[1], m[2]];
  let start: number;
  let end: number;
  if (rawStart === undefined) return null; // another unit, or a multi-range: not worth parsing
  if (rawStart === "") {
    start = size - Number(rawEnd);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= size || start > end) {
    throw new HttpError(416, "VALIDATION", `range ${header} is not satisfiable for ${size} bytes`);
  }
  return { start, end };
}

/** Raw bytes: Range/206 keeps a video seekable. Deliverables and attachments share this. */
function sendFileBytes(ctx: Ctx, f: FileSource): void {
  const { size } = statSync(f.file);
  let range: { start: number; end: number } | null;
  try {
    range = parseRange(ctx.req.headers.range, size);
  } catch {
    ctx.res.writeHead(416, { "content-range": `bytes */${size}`, "accept-ranges": "bytes" });
    ctx.res.end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  ctx.res.writeHead(range === null ? 200 : 206, {
    "content-type": f.mime,
    "content-length": String(range === null ? size : end - start + 1),
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
    "cache-control": f.cache ?? "private, no-cache",
    ...(f.download === undefined ? {} : { "content-disposition": `inline; filename="${encodeURIComponent(f.download)}"` }),
    ...(range === null ? {} : { "content-range": `bytes ${start}-${end}/${size}` }),
  });
  if (size === 0) return void ctx.res.end();
  createReadStream(f.file, { start, end }).pipe(ctx.res);
}

const VIEW_CSS = "html,body{margin:0;height:100%;background:#16161a;color:#e8e8ea;" +
  "font:15px/1.7 system-ui,-apple-system,sans-serif}.md{padding:24px 28px;max-width:56rem;margin:0 auto}" +
  ".md code{background:#26262e;padding:1px 4px;border-radius:3px}img.media{display:block;margin:auto;max-width:100%;" +
  "max-height:100vh}video.media{display:block;width:100%;height:100vh}.dl{padding:24px 28px}a{color:#8ab4f8}";
// md() backtracks quadratically on pathological input, and attachments are user uploads now.
const VIEW_TEXT_MAX = 256 * 1024;

/**
 * The readable form of the same bytes. HTML is served as-is (the sandbox CSP keeps it off our
 * origin); everything else gets the smallest wrapper that shows or plays it.
 */
function sendFileView(ctx: Ctx, f: FileSource): void {
  const { file, name, src, mime } = f;
  const ext = extname(file).toLowerCase();
  const readViewText = (): string => {
    const raw = readFileSync(file, "utf8");
    return raw.length > VIEW_TEXT_MAX ? `${raw.slice(0, VIEW_TEXT_MAX)}\n\n（先頭 256KB のみ表示）` : raw;
  };
  const head = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">';
  let body: string;
  let csp = "";
  if (ext === ".html" || ext === ".htm") {
    body = readFileSync(file, "utf8");
    csp = "sandbox allow-scripts allow-forms allow-popups";
  } else if (ext === ".md" || ext === ".markdown") {
    body = `${head}<title>${esc(name)}</title><style>${VIEW_CSS}</style><article class="md">${md(readViewText())}</article>`;
  } else if (mime.startsWith("image/")) {
    body = `${head}<title>${esc(name)}</title><style>${VIEW_CSS}</style><img class="media" src="${src}" alt="${esc(name)}">`;
  } else if (mime.startsWith("video/")) {
    body = `${head}<title>${esc(name)}</title><style>${VIEW_CSS}</style><video class="media" controls autoplay src="${src}"></video><p class="dl"><a href="${src}">ダウンロード</a></p>`;
  } else if (mime.startsWith("audio/")) {
    body = `${head}<title>${esc(name)}</title><style>${VIEW_CSS}</style><audio class="media" controls autoplay src="${src}"></audio><p class="dl"><a href="${src}">ダウンロード</a></p>`;
  } else if (mime === "application/pdf") {
    body = `${head}<title>${esc(name)}</title><iframe src="${src}" style="width:100%;height:100vh;border:0"></iframe>`;
  } else if (mime.startsWith("text/") || mime.startsWith("application/json")) {
    body = `${head}<title>${esc(name)}</title><style>${VIEW_CSS}</style><article class="md">${md(readViewText())}</article>`;
  } else {
    body = `${head}<title>${esc(name)}</title><style>${VIEW_CSS}</style>` +
      `<div class="dl"><p>${esc(name)}</p><p><a href="${src}">ダウンロード</a></p></div>`;
  }
  ctx.res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-cache",
    ...(csp === "" ? {} : { "content-security-policy": csp }),
  });
  ctx.res.end(body);
}

// -------------------------------------------------------------- columns (wip editing)

async function patchColumn(ctx: Ctx, m: RegExpExecArray): Promise<void> {
  const db = requireDb(ctx);
  const project = projectOr404(db, decodeSegment(m[1]));
  const id = assertColumnId(decodeSegment(m[2]));
  const body = await readJson(ctx);
  const patch: { name?: string; wipLimit?: number | null; ord?: number } = {};
  if ("name" in body) patch.name = assertName(body.name, "column name");
  if ("wipLimit" in body) {
    patch.wipLimit = body.wipLimit === null ? null : Number(body.wipLimit);
  }
  if ("ord" in body) patch.ord = Number(body.ord);
  const column = updateColumn(db, project.projectId, id, patch, ACTOR);
  sendJson(ctx, 200, ok({ column }));
}

// -------------------------------------------------------------- saved views

function getViews(ctx: Ctx): void {
  const db = requireDb(ctx);
  const project = projectOr404(db, str(ctx.url.searchParams.get("project"), "project"));
  sendJson(ctx, 200, ok({ views: listViews(db, project.projectId) }));
}

async function postView(ctx: Ctx): Promise<void> {
  const db = requireDb(ctx);
  const body = await readJson(ctx);
  const project = projectOr404(db, str(body.project, "project"));
  const view = createView(db, project.projectId, assertName(body.name, "view name"), viewQuery(body.query));
  sendJson(ctx, 201, ok({ view }));
}

async function patchView(ctx: Ctx, m: RegExpExecArray): Promise<void> {
  const db = requireDb(ctx);
  const project = projectOr404(db, decodeSegment(m[1]));
  const id = assertId(Number(m[2]));
  const body = await readJson(ctx);
  const view = updateView(db, project.projectId, id, {
    ...("name" in body ? { name: assertName(body.name, "view name") } : {}),
    ...("query" in body ? { query: viewQuery(body.query) } : {}),
  });
  sendJson(ctx, 200, ok({ view }));
}

function deleteViewRoute(ctx: Ctx, m: RegExpExecArray): void {
  const db = requireDb(ctx);
  const project = projectOr404(db, decodeSegment(m[1]));
  const id = assertId(Number(m[2]));
  deleteView(db, project.projectId, id);
  sendJson(ctx, 200, ok({ deleted: { projectId: project.projectId, id } }));
}

/** The query is a filter the board knows how to re-apply, not an arbitrary expression. */
function viewQuery(raw: unknown): { q?: string; focus?: boolean } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "BAD_REQUEST", "query must be an object");
  const src = raw as Record<string, unknown>;
  const q = src.q === undefined ? undefined : optText(src.q, "q", 200);
  const focus = src.focus === undefined ? undefined : Boolean(src.focus);
  return { ...(q ? { q } : {}), ...(focus === undefined ? {} : { focus }) };
}

// -------------------------------------------------------------- templates

function getTemplates(ctx: Ctx): void {
  const db = requireDb(ctx);
  const project = projectOr404(db, str(ctx.url.searchParams.get("project"), "project"));
  sendJson(ctx, 200, ok({ templates: listTemplates(db, project.projectId) }));
}

async function postTemplate(ctx: Ctx): Promise<void> {
  const db = requireDb(ctx);
  const body = await readJson(ctx);
  const project = projectOr404(db, str(body.project, "project"));
  const template = createTemplate(db, project.projectId, {
    name: assertName(body.name, "template name"),
    title: assertTitle(body.title),
    body: assertBody(body.body),
    columnId: body.columnId === undefined ? null : assertColumn(db, project.projectId, assertColumnId(body.columnId)),
    priority: body.priority === undefined ? 0 : assertPriority(body.priority),
    labels: assertLabels(body.labels),
  });
  sendJson(ctx, 201, ok({ template }));
}

/** Instantiate: one POST yields a card in the project (query `column` overrides the template). */
async function postTemplateUse(ctx: Ctx, m: RegExpExecArray): Promise<void> {
  const db = requireDb(ctx);
  const project = projectOr404(db, decodeSegment(m[1]));
  const id = assertId(Number(m[2]));
  const body = await readJson(ctx);
  const columnId = body.columnId === undefined
    ? undefined
    : assertColumn(db, project.projectId, assertColumnId(body.columnId));
  const card = createCardFromTemplate(db, project.projectId, id, { ...(columnId ? { columnId } : {}), actor: ACTOR });
  sendJson(ctx, 201, ok({ card }));
}

function deleteTemplateRoute(ctx: Ctx, m: RegExpExecArray): void {
  const db = requireDb(ctx);
  const project = projectOr404(db, decodeSegment(m[1]));
  const id = assertId(Number(m[2]));
  deleteTemplate(db, project.projectId, id);
  sendJson(ctx, 200, ok({ deleted: { projectId: project.projectId, id } }));
}

// -------------------------------------------------------------- attachments
// Bytes go in the body, metadata in the query: a multipart parser is not worth writing for
// one endpoint, and the browser can send a Blob directly.

async function readRaw(ctx: Ctx, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of ctx.req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > max) throw new HttpError(413, "BAD_REQUEST", `body is larger than ${max} bytes`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function getAttachments(ctx: Ctx): void {
  const db = requireDb(ctx);
  const project = projectOr404(db, str(ctx.url.searchParams.get("project"), "project"));
  const rawCard = ctx.url.searchParams.get("cardId");
  const rawDeliv = ctx.url.searchParams.get("deliverableId");
  const opts = rawCard !== null ? { cardId: assertId(Number(rawCard)) }
    : rawDeliv !== null ? { deliverableId: assertId(Number(rawDeliv)) }
    : {};
  sendJson(ctx, 200, ok({ attachments: listAttachments(db, project.projectId, opts) }));
}

async function postAttachment(ctx: Ctx): Promise<void> {
  const db = requireDb(ctx);
  const q = ctx.url.searchParams;
  const project = projectOr404(db, str(q.get("project"), "project"));
  const cardId = q.get("cardId") === null ? null : assertId(Number(q.get("cardId")));
  const deliverableId = q.get("deliverableId") === null ? null : assertId(Number(q.get("deliverableId")));
  if (cardId === null && deliverableId === null) {
    throw new HttpError(400, "BAD_REQUEST", "cardId or deliverableId is required");
  }
  const bytes = await readRaw(ctx, MAX_ATTACHMENT_BYTES);
  if (bytes.length === 0) throw new HttpError(400, "BAD_REQUEST", "body is empty");
  const name = safeAttachmentName(String(q.get("name") ?? ""), "");
  // Content-addressed: the same file twice costs one file, and the stored name cannot escape.
  const stored = storeBlob(ctx.home, bytes, name);
  if (!stored) {
    throw new HttpError(422, "VALIDATION", "unsupported file: images, pdf, video/audio, zip and plain text (md/txt/csv/json/log/yaml) are accepted");
  }
  const attachment = createAttachment(db, project.projectId, {
    cardId, deliverableId, name: name === "" ? stored.blobName : name, mime: stored.mime, size: stored.size,
  }, stored.blobName);
  sendJson(ctx, 201, ok({ attachment }));
}

/** The bytes live in the media store, not at any path the attachment row names. */
function attachmentRef(ctx: Ctx, m: RegExpExecArray): FileSource {
  const db = requireDb(ctx);
  const project = projectOr404(db, decodeSegment(m[1]));
  const id = assertId(Number(m[2]));
  const att = getAttachment(db, project.projectId, id);
  const blob = att ? attachmentBlobName(db, project.projectId, id) : null;
  if (!att || blob === null) throw new DomainError("NOT_FOUND", `attachment ${project.projectId}#${id} not found`);
  const file = blobPath(ctx.home, blob);
  if (file === null) throw new HttpError(410, "NOT_FOUND", `blob for attachment #${id} is missing on disk`);
  return {
    file, name: att.name, mime: att.mime,
    src: `/api/attachments/${encodeURIComponent(project.slug)}/${id}`,
    download: att.name, cache: "private, max-age=31536000, immutable",
  };
}

function getAttachmentBytes(ctx: Ctx, m: RegExpExecArray): void {
  sendFileBytes(ctx, attachmentRef(ctx, m));
}

function deleteAttachmentRoute(ctx: Ctx, m: RegExpExecArray): void {
  const db = requireDb(ctx);
  const project = projectOr404(db, decodeSegment(m[1]));
  const id = assertId(Number(m[2]));
  deleteAttachment(db, project.projectId, id);
  sendJson(ctx, 200, ok({ deleted: { projectId: project.projectId, id } }));
}

// -------------------------------------------------------------- read-only views

/**
 * `project` is optional: without it every board is searched and the hits carry their projectId.
 * `limit` is one budget for the whole answer — boards are gathered whole, merged on score,
 * then sliced once (a per-board slice would let board A fill the quota and hide board B).
 */
function getSearch(ctx: Ctx): void {
  const db = requireDb(ctx);
  const q = ctx.url.searchParams;
  const ref = q.get("project")?.trim() ?? "";
  const projects = ref === "" ? listProjects(db) : [projectOr404(db, ref)];
  const limit = clampSearchLimit(q.get("limit") === null ? undefined : Number(q.get("limit")));
  const scored: ScoredHit[] = projects.flatMap(project => {
    const snapshot = readBoard(db, project.projectId)!;
    return searchBoardScored({
      projectId: project.projectId, columns: snapshot.columns, cards: snapshot.cards,
      deliverables: listDeliverables(db, project.projectId), q: q.get("q") ?? "",
    });
  });
  sendJson(ctx, 200, ok({ hits: scored.sort(compareScored).slice(0, limit).map(s => s.hit) }));
}

function getNotifications(ctx: Ctx): void {
  const db = requireDb(ctx);
  const ref = ctx.url.searchParams.get("project");
  const projects = ref === null ? listProjects(db) : [projectOr404(db, ref)];
  const items = projects.flatMap(project => {
    const snapshot = readBoard(db, project.projectId)!;
    return notifications({
      projectId: project.projectId, columns: snapshot.columns, cards: snapshot.cards,
      deps: snapshot.dependencies ?? [], loop: getLoop(db, project.projectId),
    });
  });
  // A5: same payload, optionally mirrored to KANBAN_NOTIFY_SINK=file:<path>. Off (no
  // second key in the response) unless configured; a bad setting is a visible 422, not a
  // silent fallback to off.
  const delivery = deliverNotifications(items, parseSinkSetting(process.env[SINK_ENV]));
  sendJson(ctx, 200, ok({
    notifications: items,
    sink: delivery === null ? undefined : { path: delivery.path, written: delivery.written, skipped: delivery.skipped, ...(delivery.error === undefined ? {} : { error: delivery.error }) },
  }));
}

/** A6: who is writing what. Expired rows are reclaimed on read, so this is always the truth. */
function getLocks(ctx: Ctx): void {
  const db = requireDb(ctx);
  const project = projectOr404(db, str(ctx.url.searchParams.get("project"), "project"));
  sendJson(ctx, 200, ok({ locks: listLocks(db, project.projectId) }));
}

async function postLock(ctx: Ctx): Promise<void> {
  const db = requireDb(ctx);
  const body = await readJson(ctx);
  const project = projectOr404(db, str(body.project, "project"));
  const owner = optText(body.owner, "owner", 64) || ACTOR;
  const lock = acquireLock(db, {
    projectId: project.projectId,
    resource: assertResource(body.resource),
    owner,
    ttlSeconds: body.ttlSeconds === undefined ? undefined : assertTtlSeconds(body.ttlSeconds),
  });
  sendJson(ctx, 201, ok({ lock }));
}

async function deleteLockRoute(ctx: Ctx, m: RegExpExecArray): Promise<void> {
  const db = requireDb(ctx);
  const project = projectOr404(db, str(ctx.url.searchParams.get("project"), "project"));
  const resource = decodeSegment(m[1]);
  // Releasing is idempotent: a holder that retries must not turn into a 404 wall.
  sendJson(ctx, 200, ok({ released: releaseLock(db, project.projectId, resource) }));
}

/** One Markdown page for a period: done transitions, deliverables, commits. */
function getDigest(ctx: Ctx): void {
  const db = requireDb(ctx);
  const q = ctx.url.searchParams;
  const project = projectOr404(db, str(q.get("project"), "project"));
  const until = new Date().toISOString();
  const since = parseSince(q.get("since"), new Date(until));
  const input = digestInput(db, project.projectId, { since, until });
  if (!input) throw new DomainError("NOT_FOUND", `project ${project.projectId} not found`);
  sendJson(ctx, 200, ok(buildDigest(input)));
}

function getGraph(ctx: Ctx): void {
  const db = requireDb(ctx);
  const project = projectOr404(db, str(ctx.url.searchParams.get("project"), "project"));
  const snapshot = readBoard(db, project.projectId)!;
  sendJson(ctx, 200, ok(graphLayout({
    cards: snapshot.cards, deps: snapshot.dependencies ?? [], columns: snapshot.columns,
  })));
}

// -------------------------------------------------------------- sessions
// The card's session picker: a board's cwd names one folder of pi session files (src/core/sessions.ts
// does the reading — a whole JSONL is tens of MB, so only its head and tail are read).
async function getSessions(ctx: Ctx): Promise<void> {
  const db = requireDb(ctx);
  const project = projectOr404(db, str(ctx.url.searchParams.get("project"), "project"));
  const dir = sessionDirOf(project);
  sendJson(ctx, 200, ok({ sessions: await readSessions(dir) }));
}

/** Every project on one screen: the "総合管理" half of the board. */
function getOverview(ctx: Ctx): void {
  const db = requireDb(ctx);
  const today = new Date().toISOString().slice(0, 10);
  const rows = listProjects(db).map(project => {
    const snapshot = readBoard(db, project.projectId)!;
    const cards = snapshot.cards;
    const doneCols = new Set(snapshot.columns.filter(c => c.kind === "done").map(c => c.id));
    const isDone = closedLookup(cards);
    const open = cards.filter(c => !isDone(c.id) && !doneCols.has(c.columnId));
    const deps = snapshot.dependencies ?? [];
    return {
      projectId: project.projectId,
      name: project.name,
      columns: snapshot.columns.map(c => ({
        id: c.id, name: c.name, kind: c.kind,
        count: cards.filter(card => card.columnId === c.id).length,
        wipLimit: c.wipLimit ?? null,
      })),
      loop: getLoop(db, project.projectId).status,
      counts: {
        total: cards.length,
        open: open.length,
        done: cards.length - open.length,
        ready: open.filter(c => openBlockersOf(deps, c.id, isDone).length === 0).length,
        blocked: open.filter(c => openBlockersOf(deps, c.id, isDone).length > 0 || Boolean(c.blockedReason)).length,
        overdue: open.filter(c => c.due !== null && c.due !== undefined && c.due !== "" && c.due < today).length,
        stale: staleDoingCount(snapshot.columns, cards),
        wipOver: snapshot.columns.filter(c => c.wipLimit != null
          && cards.filter(card => card.columnId === c.id).length > c.wipLimit).length,
      },
    };
  });
  sendJson(ctx, 200, ok({ projects: rows }));
}

// -------------------------------------------------------------- doing loop

function getLoopRoute(ctx: Ctx): void {
  const db = requireDb(ctx);
  const project = projectOr404(db, str(ctx.url.searchParams.get("project"), "project"));
  const loop = getLoop(db, project.projectId);
  // A client cannot know the supervisor's cadence, so the deadline is computed here: one place
  // decides what "next tick" means, and a stopped loop (or no supervisor) schedules nothing.
  const nextTickAt = loop.status === "running" && ctx.loopMs > 0 && loop.lastTickAt
    ? new Date(Date.parse(loop.lastTickAt) + ctx.loopMs).toISOString()
    : null;
  // `running` answers the one question the loop row cannot: a wake this process started and has
  // not seen end. Without it a card sitting in DOING looks the same whether a child owns it or
  // the wake was refused, and the retry below is invisible from outside.
  sendJson(ctx, 200, ok({ loop: { ...loop, nextTickAt, running: runningWakes() } }));
}

/**
 * The thresholds are process-wide, not per board, so this route takes no project: the same
 * numbers decide every board's cadence, budget and stuck halt.
 */
function getLoopSettingsRoute(ctx: Ctx): void {
  const db = requireDb(ctx);
  // KANBAN_LOOP_MS is the default for a home that never saved one; the saved value wins.
  const fallback = ctx.loopMs > 0 ? { intervalMs: ctx.loopMs } : {};
  // Only a server that can re-arm its timer may say a change takes effect now.
  const appliesLater = ctx.restartSupervisor === undefined;
  sendJson(ctx, 200, ok({ ...getLoopSettings(db, fallback), intervalAppliesOnRestart: appliesLater }));
}

/** A partial update. The timer is re-armed here; `true` means this server has no timer to arm. */
async function patchLoopSettings(ctx: Ctx): Promise<void> {
  const db = requireDb(ctx);
  const settings = saveLoopSettings(db, await readJson(ctx) as Partial<LoopSettings>);
  // The saved interval only matters if the timer picks it up: re-arm instead of asking for a
  // restart, which nobody does and every board then keeps ticking at the old cadence.
  const appliesLater = ctx.restartSupervisor === undefined;
  ctx.restartSupervisor?.(settings.intervalMs);
  sendJson(ctx, 200, ok({ ...settings, intervalAppliesOnRestart: appliesLater }));
}

/**
 * Start marks the loop running; a tick names the next TODO card and moves it into DOING
 * (WIP=1, `moved` in the response) without waking a model. A board with nothing ready keeps
 * running with `nextCardId: null`: only a stop, the budget or a stuck card halts it.
 */
async function postLoop(ctx: Ctx, action: string): Promise<void> {
  const db = requireDb(ctx);
  const body = await readJson(ctx);
  const project = projectOr404(db, str(body.project, "project"));
  const now = new Date().toISOString();
  const current = getLoop(db, project.projectId);

  if (action === "start") {
    const loop = saveLoop(db, startLoop(current.status === "running" ? current : { ...initialLoopState(project.projectId, now), ticks: current.ticks }, now), ACTOR, "loop.resumed");
    sendJson(ctx, 200, ok({ loop }));
    return;
  }
  if (action === "stop") {
    const loop = saveLoop(db, stopLoop(current, now, typeof body.reason === "string" && body.reason.trim() !== "" ? body.reason.trim() : "stopped manually"), ACTOR, "loop.halted");
    sendJson(ctx, 200, ok({ loop }));
    return;
  }

  const result = tickProject(db, project.projectId, now, ACTOR);
  // tickProject returns null for a loop that is not running: same CONFLICT tickLoop raises.
  if (!result) throw new DomainError("CONFLICT", `loop is ${current.status}: start it before ticking`, { status: current.status });
  // An HTTP tick wakes the card it moved: the supervisor is not the only caller, and a tick
  // with no supervisor behind it would otherwise move a card into DOING and leave it there.
  if (result.moved) fireWake(ctx, db, project, result.moved);
  const next = result.nextCardId === null ? null : listCards(db, project.projectId).find(c => c.id === result.nextCardId) ?? null;
  sendJson(ctx, 200, ok({ loop: result.loop, nextCard: next, moved: result.moved }));
}

// ------------------------------------------------------------------ route table

type Handler = (ctx: Ctx, m: RegExpExecArray) => void | Promise<void>;
interface Route { m: string; re: RegExp; h: Handler }

const routes: Route[] = [
  { m: "GET", re: /^\/api\/meta$/, h: getMeta },
  { m: "GET", re: /^\/api\/selftest$/, h: getSelftest },
  { m: "GET", re: /^\/api\/projects$/, h: getProjects },
  { m: "POST", re: /^\/api\/projects$/, h: postProject },
  { m: "DELETE", re: /^\/api\/projects\/([^/]+)$/, h: deleteProjectRoute },
  { m: "GET", re: /^\/api\/board$/, h: getBoard },
  { m: "GET", re: /^\/api\/timeline$/, h: getTimeline },
  { m: "POST", re: /^\/api\/cards$/, h: postCard },
  { m: "PATCH", re: /^\/api\/cards\/([^/]+)\/(\d+)$/, h: patchCard },
  { m: "POST", re: /^\/api\/cards\/([^/]+)\/(\d+)\/move$/, h: postCardMove },
  { m: "DELETE", re: /^\/api\/cards\/([^/]+)\/(\d+)$/, h: deleteCardRoute },
  { m: "GET", re: /^\/api\/dependencies$/, h: getDependencies },
  { m: "POST", re: /^\/api\/dependencies$/, h: postDependency },
  { m: "DELETE", re: /^\/api\/dependencies$/, h: deleteDependency },
  { m: "GET", re: /^\/api\/deliverables$/, h: getDeliverables },
  { m: "POST", re: /^\/api\/deliverables$/, h: postDeliverable },
  { m: "DELETE", re: /^\/api\/deliverables\/([^/]+)\/(\d+)$/, h: deleteDeliverableRoute },
  { m: "GET", re: /^\/api\/deliverables\/([^/]+)\/(\d+)\/file$/, h: (c, m) => sendFileBytes(c, deliverableRef(c, m)) },
  { m: "GET", re: /^\/api\/deliverables\/([^/]+)\/(\d+)\/view$/, h: (c, m) => sendFileView(c, deliverableRef(c, m)) },
  { m: "PATCH", re: /^\/api\/columns\/([^/]+)\/([^/]+)$/, h: patchColumn },
  { m: "GET", re: /^\/api\/views$/, h: getViews },
  { m: "POST", re: /^\/api\/views$/, h: postView },
  { m: "PATCH", re: /^\/api\/views\/([^/]+)\/(\d+)$/, h: patchView },
  { m: "DELETE", re: /^\/api\/views\/([^/]+)\/(\d+)$/, h: deleteViewRoute },
  { m: "GET", re: /^\/api\/templates$/, h: getTemplates },
  { m: "POST", re: /^\/api\/templates$/, h: postTemplate },
  { m: "POST", re: /^\/api\/templates\/([^/]+)\/(\d+)$/, h: postTemplateUse },
  { m: "DELETE", re: /^\/api\/templates\/([^/]+)\/(\d+)$/, h: deleteTemplateRoute },
  { m: "GET", re: /^\/api\/attachments$/, h: getAttachments },
  { m: "POST", re: /^\/api\/attachments$/, h: postAttachment },
  { m: "GET", re: /^\/api\/attachments\/([^/]+)\/(\d+)\/view$/, h: (c, m) => sendFileView(c, attachmentRef(c, m)) },
  { m: "GET", re: /^\/api\/attachments\/([^/]+)\/(\d+)$/, h: getAttachmentBytes },
  { m: "DELETE", re: /^\/api\/attachments\/([^/]+)\/(\d+)$/, h: deleteAttachmentRoute },
  { m: "GET", re: /^\/api\/search$/, h: getSearch },
  { m: "GET", re: /^\/api\/notifications$/, h: getNotifications },
  { m: "GET", re: /^\/api\/graph$/, h: getGraph },
  { m: "GET", re: /^\/api\/digest$/, h: getDigest },
  { m: "GET", re: /^\/api\/locks$/, h: getLocks },
  { m: "POST", re: /^\/api\/locks$/, h: postLock },
  { m: "DELETE", re: /^\/api\/locks\/([^/]+)$/, h: deleteLockRoute },
  { m: "GET", re: /^\/api\/overview$/, h: getOverview },
  { m: "GET", re: /^\/api\/sessions$/, h: getSessions },
  { m: "GET", re: /^\/api\/loop$/, h: getLoopRoute },
  { m: "GET", re: /^\/api\/loop\/settings$/, h: getLoopSettingsRoute },
  { m: "PATCH", re: /^\/api\/loop\/settings$/, h: patchLoopSettings },
  { m: "POST", re: /^\/api\/loop\/(start|stop|tick)$/, h: (ctx, m2) => postLoop(ctx, m2[1]) },
];


/**
 * Run one /api request. Returns false when nothing matched (the caller writes the 404).
 * Errors are turned into envelopes here, so the server never sees a domain error.
 */
export async function handleApi(ctx: Ctx): Promise<boolean> {
  const path = ctx.url.pathname;
  if (!path.startsWith("/api/")) return false;
  for (const r of routes) {
    if (r.m !== ctx.req.method) continue;
    const m = r.re.exec(path);
    if (!m) continue;
    try {
      await r.h(ctx, m);
    } catch (err) {
      if (ctx.res.headersSent) return true;
      sendError(ctx, err);
    }
    return true;
  }
  sendJson(ctx, 404, fail("NOT_FOUND", `no route for ${ctx.req.method} ${path}`));
  return true;
}

