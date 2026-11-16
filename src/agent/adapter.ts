// W3F: the v1 external agent contract (`kanban` / `deliverable` tools, `/kanban`) on the
// v2 stack. pi-facing wiring (schemas, registration order, events) lives in
// extensions/kanban-v2.ts; everything here is DB + text, so it is testable without a pi
// host. Composites are always (projectId, id): no call below resolves a bare id.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { PORT_DEFAULT } from "../shared/constants.js";
import type { Card, ColumnDef, Deliverable } from "../shared/dto.js";
import { DomainError } from "../shared/errors.js";
import type { Db } from "../persistence/db.js";
import { closeDb, one } from "../persistence/db.js";
import { detectState, kanbanHome, openHomeDatabase, readToken, type HomeState } from "../persistence/init.js";
import { schemaVersion } from "../persistence/migrations.js";
import {
  createAttachment, createCard, createDeliverable, createProject, deleteCard, deleteDeliverable, digestInput,
  getLoop, getProjectBySlug, listCards, listColumns, listDeliverables, listProjects, moveCard, peekNextId,
  saveLoop, updateCard, updateDeliverable, type UpdateCardPatch,
} from "../persistence/repos.js";
import { startServer, type RunningServer } from "../api/start.js";
import { columnsByOrd } from "../core/project.js";
import { sortCards } from "../core/card.js";
import { assertBlockedReason, assertLabels, assertPriority, assertTitle, invalid, TITLE_MAX } from "../core/validation.js";
import { MAX_ATTACHMENT_BYTES, safeAttachmentName } from "../core/attachment.js";
import { startLoop } from "../core/loop.js";
import { buildDigest, parseSince } from "../core/digest.js";
import { storeBlob } from "../media.js";

export type Scope = "project" | "global";

export interface Env { cwd: string; actor?: string }

export interface KanbanArgs {
  action: string;
  scope?: Scope;
  text?: string;
  id?: number;
  col?: string;
  nextFireAt?: string;
  blocked?: string | boolean;
  project?: string;
  session?: string;
  commit?: string;
  labels?: string | string[];
  image?: string;
  priority?: number;
}

export interface DeliverableArgs {
  action: string;
  scope?: Scope;
  project?: string;
  id?: number;
  text?: string;
  title?: string;
  ref?: string;
  image?: string;
  cardId?: number;
}

export interface Result {
  ok: boolean;
  text: string;
  details: { scope: Scope; cards?: unknown[]; nextId?: number; url?: string; deliverables?: unknown[]; digest?: { done: number; deliverables: number; commits: number } };
}

// ---------------------------------------------------------------- runtime (db + server)

export interface Runtime {
  home: string;
  state: HomeState;
  /** null when the home is not a v2 home: every write refuses, meta/selftest still answer. */
  db: Db | null;
  url: string;
  server: RunningServer | null;
  token: string | null;
}

let runtime: Promise<Runtime> | null = null;

/** The v2 home. `KANBAN_HOME` exists so a test can point the adapter at a temp home. */
function homeOf(): string {
  const override = (process.env.KANBAN_HOME ?? "").trim();
  return override === "" ? kanbanHome() : override;
}

/** Start the dashboard+DB once per process; other sessions in this process reuse it. */
export function kanbanRuntime(): Promise<Runtime> {
  runtime ??= openRuntime();
  return runtime;
}

/** Release the server and DB. The next kanbanRuntime() starts a fresh one. */
export async function closeRuntime(): Promise<void> {
  const pending = runtime;
  runtime = null;
  cachedInjection = null;
  if (!pending) return;
  const rt = await pending.catch(() => null);
  if (!rt) return;
  try { await rt.server?.close(); } catch { /* already gone */ }
  if (rt.db) {
    try { closeDb(rt.db); } catch { /* closed with the server */ }
  }
}

const isAddrInUse = (err: unknown): boolean => (err as { code?: string } | null)?.code === "EADDRINUSE";

async function openRuntime(): Promise<Runtime> {
  const home = homeOf();
  try {
    const run = await startServer({ home });
    return { home, state: run.state, db: run.db, url: run.url, server: run, token: run.token };
  } catch (err) {
    if (!isAddrInUse(err)) throw err;
    // Something already serves the port (an external `serve:v2`, or v1's own extension).
    // Attach: our own DB handle, the URL of whoever holds the port.
    const state = detectState(home);
    const port = Number(process.env.KANBAN_PORT ?? PORT_DEFAULT);
    return {
      home, state,
      db: state.initialized ? openHomeDatabase(home).db : null,
      url: `http://${process.env.KANBAN_HOST ?? "127.0.0.1"}:${port}/`,
      server: null,
      token: readToken(home),
    };
  }
}

/** One line for /kanban: the URL that sets the auth cookie. Null when there is no token. */
export function tokenUrl(rt: Runtime): string | null {
  const token = rt.token ?? readToken(rt.home);
  if (!token) return null;
  return `${rt.url.replace(/\/+$/, "")}/?token=${token}`;
}

async function dbOf(): Promise<{ rt: Runtime; db: Db }> {
  const rt = await kanbanRuntime();
  if (rt.db) return { rt, db: rt.db };
  // init can run in another terminal after this process started, so re-detect while null.
  const state = detectState(rt.home);
  if (state.initialized) {
    rt.state = state;
    rt.db = openHomeDatabase(rt.home).db;
    return { rt, db: rt.db };
  }
  throw new DomainError("INTERNAL",
    `kanban home ${rt.home} is not initialized (${state.status}); boot initializes a home that needs ` +
    `it, so this only happens when the server was started with init:false — run the v2 init first`);
}

// ---------------------------------------------------------------- project resolution

/** Lowercase a directory name into a v2 slug; "" when nothing legal survives. */
export function normalizeSlug(raw: string): string {
  return String(raw)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/, "")
    .slice(0, 64);
}

/**
 * The board key for a working directory: the git root's basename. Two sessions in the same
 * repo share one board. shortcut: two different roots with the same basename collapse into
 * one board; upgrade when the db can hold a path->slug map.
 */
export function projectSlugOf(cwd: string): string {
  let root = cwd;
  try {
    const top = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000,
    }).trim();
    if (top !== "") root = top;
  } catch {
    // not a repo (or no git): the cwd itself is the scope
  }
  return normalizeSlug(basename(root)) || "inbox";
}

/** `project` wins when given; otherwise the cwd. Never a leading-match against other slugs. */
function boardSlug(args: { project?: string }, env: Env): string {
  const explicit = (args.project ?? "").trim();
  if (explicit !== "") {
    const slug = normalizeSlug(explicit);
    if (slug === "") throw invalid(`project is not a usable slug: ${explicit}`);
    return slug;
  }
  return projectSlugOf(env.cwd);
}

// ---------------------------------------------------------------- field normalization

function labelsOf(v: string | string[] | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return assertLabels(v);
  const parts = v.split(",").map((s) => s.trim()).filter((s) => s !== "");
  return assertLabels(parts);
}

function commitOf(v: string | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  const s = v.trim().toLowerCase();
  if (s === "") return null;
  if (!/^[0-9a-f]{7,40}$/.test(s)) throw invalid(`commit must be 7-40 hex characters: ${v}`);
  return s;
}

function sessionOf(v: string | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  const s = v.trim();
  if (s === "") return null;
  if (!/^[A-Za-z0-9._:@-]{1,128}$/.test(s)) throw invalid(`session may only contain A-Za-z0-9._:@- (max 128): ${v}`);
  return s;
}

function blockedOf(v: string | boolean | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "boolean") return v ? "blocked" : null;
  return assertBlockedReason(v);
}

/**
 * v1's `nextFireAt` (ISO 8601, or +90m/+3h/+1d) drove the doing-loop. v2 has no fire-at
 * clock, so it is kept as the card's `due` DATE — the one scheduling field v2 has. A time
 * component is dropped on purpose (due is a date, so "today" means the same to every reader).
 */
export function dueOf(v: string | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  const raw = v.trim();
  if (raw === "") return null;
  const rel = /^\+(\d+)([mhd])$/.exec(raw);
  const at = rel
    ? new Date(Date.now() + Number(rel[1]) * (rel[2] === "m" ? 60_000 : rel[2] === "h" ? 3_600_000 : 86_400_000))
    : new Date(raw);
  if (Number.isNaN(at.getTime())) throw invalid(`nextFireAt must be ISO 8601 or +Nm/+Nh/+Nd: ${v}`);
  return at.toISOString().slice(0, 10);
}

/** A long card text keeps every character: the tail moves to `body`, the head to the title. */
function titleAndBody(text: string): { title: string; body: string } {
  const trimmed = text.trim();
  if (trimmed.length <= TITLE_MAX) return { title: assertTitle(trimmed), body: "" };
  return { title: trimmed.slice(0, TITLE_MAX).trimEnd(), body: trimmed };
}

/** `col` accepts a column id, or a kind ("todo") meaning that kind's leftmost column. */
function resolveColumn(db: Db, projectId: string, col: string): ColumnDef {
  const columns = listColumns(db, projectId);
  const direct = columns.find((c) => c.id === col);
  if (direct) return direct;
  const byKind = columnsByOrd(columns).find((c) => c.kind === col);
  if (byKind) return byKind;
  throw invalid(`no column "${col}" in ${projectId} (have: ${columns.map((c) => c.id).join(", ") || "none"})`);
}

function firstTodoColumn(db: Db, projectId: string): ColumnDef {
  const ordered = columnsByOrd(listColumns(db, projectId));
  const col = ordered.find((c) => c.kind === "todo") ?? ordered[0];
  if (!col) throw new DomainError("NOT_FOUND", `project ${projectId} has no columns`);
  return col;
}

// ---------------------------------------------------------------- rendering

const CARD_TEXT_MAX = 80;

function clip(text: string, max = CARD_TEXT_MAX): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

/** `#12 buy milk [bug] p5` — one card, one line. */
function cardLine(card: Card): string {
  const bits = [`#${card.id}`, clip(card.title ?? card.body ?? "")];
  if (card.labels && card.labels.length > 0) bits.push(`[${card.labels.join(",")}]`);
  if (card.blockedReason) bits.push("🚫");
  if (card.priority) bits.push(`p${card.priority}`);
  if (card.due) bits.push(`due:${card.due}`);
  return bits.join(" ");
}

function renderBoard(projectId: string, columns: ColumnDef[], cards: Card[]): string {
  const counts = columns
    .map((c) => `${c.name} ${cards.filter((k) => k.columnId === c.id).length}`)
    .join(" / ");
  const out = [`[project ${projectId}] ${counts}`];
  for (const col of columnsByOrd(columns)) {
    const list = sortCards(cards.filter((c) => c.columnId === col.id));
    if (col.kind === "done") {
      // DONE is rounded to the newest few: a long board must not grow the listing without bound.
      out.push(list.length === 0 ? `${col.name} (計0件)` : `${col.name} (計${list.length}件) ${list.slice(0, 5).map(cardLine).join(" / ")}`);
    } else {
      out.push(`${col.name}${list.length === 0 ? "(none)" : ` ${list.map(cardLine).join(" / ")}`}`);
    }
  }
  return out.join("\n");
}

function renderGlobal(byProject: { projectId: string; cards: Card[] }[]): string {
  const total = byProject.reduce((n, p) => n + p.cards.length, 0);
  const lines = byProject
    .filter((p) => p.cards.length > 0)
    .map((p) => `${p.projectId}: ${sortCards(p.cards).map((c) => `${p.projectId}/${cardLine(c)}`).join(" / ")}`);
  return [`[global] ${total} card(s) in ${byProject.length} project(s)`, ...lines].join("\n");
}

function deliverableLine(d: Deliverable, prefix = ""): string {
  const bits = [`#${prefix}${d.id}`, clip(d.title)];
  if (d.kind && d.kind !== "note") bits.push(`(${d.kind})`);
  if (d.ref) bits.push(`ref:${d.ref}`);
  if (d.cardId !== null && d.cardId !== undefined) bits.push(`card:#${d.cardId}`);
  return bits.join(" ");
}

// ---------------------------------------------------------------- per-turn injection

const INJECT_MAX = 2000;
const INJECT_DONE = 3;

let cachedInjection: string | null = null;

/** Sync read for pi's `before_agent_start`, which cannot await. */
export function injectionTextSync(): string | null {
  return cachedInjection;
}

/**
 * Rebuild the cached injection from this cwd's project board.
 * Deliberately the project board only: global counts are not actionable. Empty -> null.
 */
export async function refreshInjection(cwd: string): Promise<void> {
  try {
    const { rt, db } = await dbOf();
    const slug = projectSlugOf(cwd);
    if (!getProjectBySlug(db, slug)) {
      cachedInjection = null;
      return;
    }
    const text = renderInjection(rt, slug, listColumns(db, slug), listCards(db, slug));
    cachedInjection = text;
  } catch {
    // not initialized / unreadable: no injection beats a wrong one
    cachedInjection = null;
  }
}

export function renderInjection(rt: Runtime, projectId: string, columns: ColumnDef[], cards: Card[]): string | null {
  if (cards.length === 0) return null;
  const out = [`=== KANBAN (this project: ${projectId}) ===`];
  for (const col of columnsByOrd(columns)) {
    const list = sortCards(cards.filter((c) => c.columnId === col.id));
    if (col.kind === "done") {
      out.push(list.length === 0 ? "DONE(計0件)" : `DONE(計${list.length}件) ${list.slice(0, INJECT_DONE).map(cardLine).join(" / ")}`);
    } else {
      out.push(`${col.name.toUpperCase()}${list.length === 0 ? "(none)" : ` ${list.map(cardLine).join(" / ")}`}`);
    }
  }
  out.push(`GUI: open ${rt.url} in a browser.`);
  // The token value never enters the prompt (it would be replayed to the model as text).
  out.push("TOKEN: /kanban url (or the `kanban` url action) prints the link that sets the cookie.");
  const text = out.join("\n");
  if (text.length <= INJECT_MAX) return text;
  return `${text.slice(0, INJECT_MAX)}…`;
}

/**
 * Copy one local file into the media store. Only images pass (sniffImage), so an agent cannot
 * park arbitrary bytes under our origin. Paths are resolved against the cwd by the caller.
 */
function attachFile(home: string, path: string): { ok: true; blobName: string; mime: string; size: number } | { ok: false; text: string } {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    return { ok: false, text: `cannot read ${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    return { ok: false, text: `${path} is larger than ${MAX_ATTACHMENT_BYTES} bytes` };
  }
  const stored = storeBlob(home, bytes);
  if (!stored) return { ok: false, text: `${path} is not a png, jpeg, gif or webp image` };
  return { ok: true, ...stored };
}

// ---------------------------------------------------------------- kanban tool

const WRITE_ACTIONS = ["add", "move", "remove", "edit", "img", "ref"] as const;

const fail = (scope: Scope, text: string, extra: Partial<Result["details"]> = {}): Result => ({
  ok: false, text, details: { scope, cards: [], ...extra },
});

export async function executeKanban(args: KanbanArgs, env: Env): Promise<Result> {
  const scope: Scope = args.scope ?? "project";
  const actor = env.actor ?? "agent";
  const action = args.action;

  // These three are board-independent, and must answer even when the home is not initialized.
  if (action === "check") return selfTest();
  if (action === "url") {
    const rt = await kanbanRuntime();
    const url = tokenUrl(rt);
    return {
      ok: url !== null,
      text: url ?? `no token file at ${rt.home}/token: run the v2 init (backup + --confirm) first`,
      details: { scope, cards: [], ...(url === null ? {} : { url }) },
    };
  }
  const { db, rt } = await dbOf();

  // resume starts the doing-loop. Nothing here wakes a model: each tick moves the board's next
  // TODO into DOING (WIP=1), so `check` reports where it stands.
  if (action === "resume") {
    const target = args.project ?? (scope === "global" ? null : undefined);
    const projectId = target === null ? null : (target ?? boardSlug(args, env));
    if (projectId === null) {
      return { ok: false, text: "resume needs project=<slug>: a loop belongs to one board", details: { scope, cards: [] } };
    }
    if (!getProjectBySlug(db, projectId)) createProject(db, { slug: projectId, name: projectId }, actor);
    const loop = saveLoop(db, startLoop(getLoop(db, projectId), new Date().toISOString()), actor, "loop.resumed");
    return {
      ok: true,
      text: `loop running for ${projectId} (ticks ${loop.ticks})\n` +
        "each tick moves the next TODO into DOING (WIP=1) on POST /api/loop/tick; it does not wake a model",
      details: { scope: projectId === null ? "global" : "project", cards: listCards(db, projectId) },
    };
  }

  if (scope === "global") {
    if ((WRITE_ACTIONS as readonly string[]).includes(action)) {
      return fail(scope, `global board is read-only; pass scope=project${(args.project ?? "") === "" ? " (and project=<slug> when the cwd is not the board you mean)" : ""}`);
    }
    const byProject = listProjects(db).map((p) => ({ projectId: p.projectId, cards: listCards(db, p.projectId) }));
    return { ok: true, text: renderGlobal(byProject), details: { scope, cards: byProject.flatMap((p) => p.cards) } };
  }

  const projectId = boardSlug(args, env);
  let project = getProjectBySlug(db, projectId);
  if (!project) {
    if (!(WRITE_ACTIONS as readonly string[]).includes(action)) {
      return {
        ok: true,
        text: renderBoard(projectId, [], []),
        details: { scope, cards: [], nextId: 1 },
      };
    }
    // First write into this repo creates its board (with the default columns), like v1 did.
    project = createProject(db, { slug: projectId, name: projectId }, actor);
  }

  const details = (cards: Card[]): Result["details"] => ({ scope, cards, nextId: peekNextId(db, projectId, "card") });

  switch (action) {
    case "add": {
      const text = (args.text ?? "").trim();
      if (text === "") return fail(scope, "add requires a non-empty text");
      const column = args.col === undefined ? firstTodoColumn(db, projectId) : resolveColumn(db, projectId, args.col);
      const { title, body } = titleAndBody(text);
      const card = createCard(db, {
        projectId,
        columnId: column.id,
        title,
        body,
        priority: args.priority === undefined ? 0 : assertPriority(args.priority),
        labels: labelsOf(args.labels),
        sessionId: sessionOf(args.session) ?? null,
        commit: commitOf(args.commit) ?? null,
        blockedReason: blockedOf(args.blocked) ?? null,
        due: dueOf(args.nextFireAt) ?? null,
      }, actor);
      return { ok: true, text: `added #${card.id} to ${column.id} (project ${projectId})`, details: details(listCards(db, projectId)) };
    }
    case "move": {
      const id = requireId(scope, args, "move");
      if (id === null) return fail(scope, "move requires id");
      if (args.col === undefined || args.col === "") return fail(scope, "move requires col (todo | doing | done | <column id>)");
      const column = resolveColumn(db, projectId, args.col);
      const card = moveCard(db, projectId, id, column.id, { actor });
      return { ok: true, text: `moved #${card.id} to ${column.id} (project ${projectId})`, details: details(listCards(db, projectId)) };
    }
    case "remove": {
      const id = requireId(scope, args, "remove");
      if (id === null) return fail(scope, "remove requires id");
      deleteCard(db, projectId, id, { actor });
      return { ok: true, text: `removed #${id} (project ${projectId})`, details: details(listCards(db, projectId)) };
    }
    case "edit": {
      const id = requireId(scope, args, "edit");
      if (id === null) return fail(scope, "edit requires id");
      const patch: UpdateCardPatch = {};
      if (args.text !== undefined) {
        const text = args.text.trim();
        if (text === "") return fail(scope, "edit requires a non-empty text (omit text to change only the other fields)");
        const { title, body } = titleAndBody(text);
        patch.title = title;
        patch.body = body;
      }
      if (args.priority !== undefined) patch.priority = assertPriority(args.priority);
      const labels = labelsOf(args.labels);
      if (labels !== undefined) patch.labels = labels;
      const session = sessionOf(args.session);
      if (session !== undefined) patch.sessionId = session;
      const commit = commitOf(args.commit);
      if (commit !== undefined) patch.commit = commit;
      const blocked = blockedOf(args.blocked);
      if (blocked !== undefined) patch.blockedReason = blocked;
      const due = dueOf(args.nextFireAt);
      if (due !== undefined) patch.due = due;
      if (Object.keys(patch).length === 0) return fail(scope, "edit requires at least one of text, priority, labels, session, commit, blocked, nextFireAt");
      const card = updateCard(db, projectId, id, patch, { actor });
      return { ok: true, text: `edited #${card.id} (${Object.keys(patch).join(", ")}) (project ${projectId})`, details: details(listCards(db, projectId)) };
    }
    case "img": {
      const id = requireId(scope, args, "img");
      if (id === null) return fail(scope, "img requires id");
      const path = (args.image ?? "").trim();
      if (path === "") return fail(scope, "img requires image (a local file path)");
      const stored = attachFile(rt.home, resolve(env.cwd, path));
      if (!stored.ok) return fail(scope, stored.text);
      if (!listCards(db, projectId).some((c) => c.id === id)) return fail(scope, `card #${id} not found in ${projectId}`);
      const att = createAttachment(db, projectId, {
        cardId: id, deliverableId: null, name: safeAttachmentName(basename(path), stored.blobName),
        mime: stored.mime, size: stored.size,
      }, stored.blobName);
      return { ok: true, text: `attached #${att.id} to card #${id} (${stored.mime}, ${stored.size} bytes) (project ${projectId})`, details: details(listCards(db, projectId)) };
    }
    case "ref": {
      const id = requireId(scope, args, "ref");
      if (id === null) return fail(scope, "ref requires id");
      const path = (args.image ?? "").trim();
      if (path === "") return fail(scope, "ref requires image (a local file path)");
      const card = updateCard(db, projectId, id, { ref: path }, { actor });
      return { ok: true, text: `referenced ${path} on card #${card.id} (project ${projectId})`, details: details(listCards(db, projectId)) };
    }
    default: {
      return { ok: true, text: renderBoard(projectId, listColumns(db, projectId), listCards(db, projectId)), details: details(listCards(db, projectId)) };
    }
  }
}

function requireId(scope: Scope, args: { id?: number }, action: string): number | null {
  if (args.id === undefined) return null;
  if (!Number.isInteger(args.id) || args.id < 1) throw invalid(`${action} id must be an integer >= 1: ${String(args.id)}`);
  void scope;
  return args.id;
}

// ---------------------------------------------------------------- deliverable tool

export async function executeDeliverable(args: DeliverableArgs, env: Env): Promise<Result> {
  const scope: Scope = args.scope ?? "project";
  const actor = env.actor ?? "agent";
  const { db, rt } = await dbOf();

  if (scope === "global") {
    if (args.action !== "list") return { ok: false, text: "global board is read-only; pass scope=project", details: { scope, deliverables: [] } };
    // ids repeat per board, so a global listing names the board with every id.
    const rows = listProjects(db).flatMap((p) => listDeliverables(db, p.projectId).map((d) => ({ projectId: p.projectId, d })));
    return {
      ok: true,
      text: rows.length === 0 ? "[global] no deliverables" : rows.map((r) => `${r.projectId}/${deliverableLine(r.d)}`).join("\n"),
      details: { scope, deliverables: rows.map((r) => r.d) },
    };
  }

  const projectId = boardSlug(args, env);
  const listed = (): Result["details"] => ({ scope, deliverables: listDeliverables(db, projectId) });

  if (args.action === "list") {
    const rows = listDeliverables(db, projectId);
    return {
      ok: true,
      text: rows.length === 0 ? `[project ${projectId}] no deliverables` : rows.map((d) => deliverableLine(d)).join("\n"),
      details: listed(),
    };
  }

  if (!getProjectBySlug(db, projectId)) createProject(db, { slug: projectId, name: projectId }, actor);

  const text = (args.text ?? args.title ?? "").trim();

  switch (args.action) {
    case "add": {
      if (text === "") return { ok: false, text: "add requires a non-empty text", details: listed() };
      const ref = (args.ref ?? args.image ?? "").trim();
      const d = createDeliverable(db, {
        projectId, title: text, ref,
        cardId: args.cardId === undefined ? null : args.cardId,
      }, actor);
      return { ok: true, text: `added deliverable #${d.id} (project ${projectId})`, details: listed() };
    }
    case "edit": {
      if (args.id === undefined) return { ok: false, text: "edit requires id", details: listed() };
      if (text === "") return { ok: false, text: "edit requires a non-empty text", details: listed() };
      const d = updateDeliverable(db, projectId, args.id, { title: text }, actor);
      return { ok: true, text: `edited deliverable #${d.id} (project ${projectId})`, details: listed() };
    }
    case "remove": {
      if (args.id === undefined) return { ok: false, text: "remove requires id", details: listed() };
      deleteDeliverable(db, projectId, args.id, actor);
      return { ok: true, text: `removed deliverable #${args.id} (project ${projectId})`, details: listed() };
    }
    case "ref": {
      if (args.id === undefined) return { ok: false, text: "ref requires id", details: listed() };
      const path = (args.ref ?? args.image ?? "").trim();
      if (path === "") return { ok: false, text: "ref requires ref (a local file path)", details: listed() };
      const d = updateDeliverable(db, projectId, args.id, { ref: path }, actor);
      return { ok: true, text: `referenced ${path} on deliverable #${d.id} (project ${projectId})`, details: listed() };
    }
    case "img": {
      if (args.id === undefined) return { ok: false, text: "img requires id", details: listed() };
      const path = (args.image ?? args.ref ?? "").trim();
      if (path === "") return { ok: false, text: "img requires image (a local file path)", details: listed() };
      const stored = attachFile(rt.home, resolve(env.cwd, path));
      if (!stored.ok) return { ok: false, text: stored.text, details: listed() };
      if (!listDeliverables(db, projectId).some((d) => d.id === args.id)) {
        return { ok: false, text: `deliverable #${args.id} not found in ${projectId}`, details: listed() };
      }
      const att = createAttachment(db, projectId, {
        cardId: null, deliverableId: args.id, name: safeAttachmentName(basename(path), stored.blobName),
        mime: stored.mime, size: stored.size,
      }, stored.blobName);
      const d = updateDeliverable(db, projectId, args.id, { kind: "image" }, actor);
      return { ok: true, text: `attached image #${att.id} to deliverable #${d.id} (project ${projectId})`, details: listed() };
    }
    default: {
      const rows = listDeliverables(db, projectId);
      return { ok: true, text: rows.length === 0 ? `[project ${projectId}] no deliverables` : rows.map((d) => deliverableLine(d)).join("\n"), details: listed() };
    }
  }
}

/** `/kanban digest [--since 7d]`: the same Markdown the HTTP route serves. */
export async function executeDigest(args: { project?: string; since?: string }, env: Env): Promise<Result> {
  const { db } = await dbOf();
  const projectId = boardSlug(args, env);
  const until = new Date().toISOString();
  const since = parseSince(args.since, new Date(until));
  const input = digestInput(db, projectId, { since, until });
  if (!input) {
    return fail("project", `no board ${projectId}: pass project=<slug> to name another one`);
  }
  const digest = buildDigest(input);
  return { ok: true, text: digest.markdown, details: { scope: "project", cards: listCards(db, projectId), digest: digest.counts } };
}

// ---------------------------------------------------------------- self test

export async function selfTest(): Promise<Result> {
  const rt = await kanbanRuntime();
  let dbOk = false;
  let dbError: string | null = null;
  let version = 0;
  let projects = 0;
  let cards = 0;
  let deliverables = 0;
  if (rt.db) {
    try {
      one(rt.db, "SELECT 1 AS x");
      dbOk = true;
      version = schemaVersion(rt.db);
      projects = one<{ n: number }>(rt.db, "SELECT COUNT(*) AS n FROM project")?.n ?? 0;
      cards = one<{ n: number }>(rt.db, "SELECT COUNT(*) AS n FROM card")?.n ?? 0;
      deliverables = one<{ n: number }>(rt.db, "SELECT COUNT(*) AS n FROM deliverable")?.n ?? 0;
    } catch (err) {
      dbError = err instanceof Error ? err.message : String(err);
    }
  } else {
    dbError = `kanban home is not initialized (${rt.state.status})`;
  }
  const report = {
    ok: dbOk && rt.state.initialized,
    server: rt.server ? "in-process" : "attached (port already served)",
    url: rt.url,
    home: { path: rt.home, status: rt.state.status, initialized: rt.state.initialized },
    schemaVersion: version,
    counts: { projects, cards, deliverables },
    db: { ok: dbOk, error: dbError },
  };
  return { ok: report.ok, text: JSON.stringify(report, null, 2), details: { scope: "project", cards: [] } };
}
