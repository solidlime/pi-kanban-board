/**
 * kanban.ts - experimental pi extension: two-layer kanban boards.
 *
 * Two layers, one UI:
 *   global  ~/.pi/kanban/global.json          - shared by every session.
 *   session ~/.pi/kanban/sessions/<sid>.json  - owned by one pi session.
 *
 * Three surfaces, one state:
 *   Mode A `/kanban`  - select/input drilldown (dialog primitives only).
 *   Mode B `kanban`  - model-facing CRUD tool with a `scope` parameter.
 *   Mode C GUI       - a local HTTP server on 0.0.0.0:8789 serving /api/* plus
 *                      a self-contained dark dashboard.html.
 *
 * Sharing: pi-web runs many sessions in one process and calls `export default`
 * once per session. Only the HTTP server lives in MODULE scope (the first
 * session starts it, later sessions reuse it). Boards are NOT module state: each
 * handler reads the file it needs with `readBoard(path)` and passes that Board
 * around, so one session can never render or mutate another session's board.
 * board.json (pre-2-layer) is migrated to global.json once at startup.
 *
 * Per-turn injection: a `before_agent_start` handler attaches the SESSION board
 * as a request-only trailing message. It must NOT go into the system prompt: a
 * system prompt that changes on every board edit invalidates the provider prefix
 * cache for the whole conversation. The global board is never injected — the
 * model cannot act on it and its counts would only invite drift. Session board
 * empty -> nothing appended (no noise).
 *
 * Media: card images live as files under ~/.pi/kanban/media/ and a board file
 * only keeps the filename in `img`. Never base64 in JSON (bloat breaks the
 * injection size budget). Served back via GET /api/media/<file>. Both layers
 * share the directory; the random8 in each name makes collisions ignorable.
 */

/**
 * Mode D  serve   - a registered local path, read over the SAME 8789 server as
 * `/serve/<id>/<rel>`. Registration is a reference, not a copy: every request
 * re-resolves the disk, because the point is serving directories that are still
 * being written. The server never interprets the bytes (no HTML rewriting), so
 * nothing here is kanban- or H3-specific. Reads are read-only and separate from
 * /api/upload; the one write direction is POST /serve/<id>/_inbox/<name>, a single-level
 * drop box the agent picks up with ordinary `ls` / `read` / `grep` (A14 revised).
 */

import { createHash } from "node:crypto";
import {
	appendFileSync,
	createReadStream,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import type { Dirent, Stats } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { Type } from "typebox";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, SessionInfo } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types & state
// ---------------------------------------------------------------------------

type Scope = "session" | "global";
type Col = "todo" | "doing" | "done";
// movedAt/movedBy are optional on purpose: boards written before they existed still
// load. movedBy = the session id that last changed this card's COLUMN. A rename or
// an image swap does not transfer ownership, so those paths leave it untouched.
// priority is optional on purpose: boards written before it existed still load.
// Absent/invalid means 0; the autoPick order sorts by it descending (see orderTodos).
// nextFireAt/blocked/firedFor are optional too: absent = no restriction = the old
// behavior. nextFireAt is an ISO 8601 string with an offset (human-readable board
// JSON). blocked is free text; "" means cleared. firedFor records the nextFireAt
// value a wake already happened for, so re-arming = changing nextFireAt.
type Card = {
	id: number;
	text: string;
	col: Col;
	img?: string;
	movedAt?: number;
	movedBy?: string;
	priority?: number;
	nextFireAt?: string;
	blocked?: string;
	firedFor?: string;
};
type Board = { cards: Card[]; nextId: number };
// Automatic loop modes, keyed by (scope, session). The legacy flat doingLoop/autoPick
// are the DEFAULT for any (scope, sid) with no explicit entry; keep them on every write.
// stuckLimit is a settle COUNT (not minutes): intervalMin and stuckLimit are both
// numbers but measure different things, so each has its own reader and writer.
// maxLoops (#67) is the doing-loop budget; 0 = unlimited.
type ModePair = {
	doingLoop: boolean;
	autoPick: boolean;
	intervalMin?: number;
	stuckLimit?: number;
	maxLoops?: number;
};
// The two booleans only: intervalMin/stuckLimit/maxLoops are numbers and take their own writers.
type SwitchKey = "doingLoop" | "autoPick";
type ModesFile = {
	doingLoop?: boolean;
	autoPick?: boolean;
	SESSION?: Record<string, ModePair>;
	GLOBAL?: Record<string, ModePair>;
};
type LoopState = {
	count: number; // continuations granted in this session (persisted)
	halted: "limit" | "stuck" | null;
	scope: Scope | null; // board driving the loop (Phase 2+; null = session, legacy)
	stuckId: number | null;
	stuckCount: number; // consecutive settles that left this card in DOING
	// Last sign of life on THIS session (turn_start only). The timer only speaks into
	// real silence, so it gates on this as well as lastTickAt.
	lastActivityAt?: number;
};

const COLS: Col[] = ["todo", "doing", "done"];
// 7-char labels so the card bodies line up.
const LABELS: Record<Col, string> = { todo: "TODO   ", doing: "DOING  ", done: "DONE   " };
const WIDGET_KEY = "kanban";
const MAX_SHOWN = 4; // a column over this many cards shows 3 + "…ほかN件"
const INJECT_DONE = 3; // injected DONE keeps only the newest N (long sessions would grow otherwise)
const KANBAN_CUSTOM_TYPE = "kanban-board"; // customType of the per-turn trailing message
const STALE_MS = 3 * 60 * 60 * 1000; // DOING for this long without a move -> ⚠Nh in the footer
const LOOP_CUSTOM_TYPE = "kanban-loop"; // customType of the session entry holding LoopState
const LOOP_PROMPT_TYPE = "kanban-loop-continue"; // customType of the continuation prompt entry
const DEFAULT_MAX_LOOPS = 10; // continuations before doingLoop turns itself off
const MAX_LOOPS_CAP = 1000; // largest budget a caller may store (0 = unlimited, not a cap)
const DEFAULT_STUCK_LIMIT = 3; // settles on one DOING card before that card's loop stops
const MIN_STUCK_LIMIT = 1;
const MAX_STUCK_LIMIT = 20;
// autoPick priority: bigger goes first. A card with none is 0, so ids still order the board.
const MIN_PRIORITY = -99;
const MAX_PRIORITY = 99;
// The settle chain has to be started by someone. With DOING work this wakes the
// agent on its own; shorter burns turns on nothing, longer is not self-driving.
export const AUTO_TICK_MS = 5 * 60_000;
// Escape hatch for shouldAutoTick: a lastActivityAt that is refreshed forever (because
// some caller keeps stamping it) must not kill the loop. Silence on lastTickAt for this
// many intervals means the activity clock is lying, so lastTickAt alone decides.
export const STARVATION_FACTOR = 3;

// The panel needs a session id before the user touches anything; every handler
// refreshes this, and the GUI pins whatever it first receives.
let activeSessionId: string | null = null;
// A loop halt lives in one extension closure (memory + session JSONL). The HTTP server
// runs in the same process but outside that closure, so this is the only door for the
// GUI to learn WHY the loop stopped. Published by paintLoop, cleared by resume.
const haltedBySid = new Map<
	string,
	{ halted: "limit" | "stuck"; stuckId: number | null; stuckCount: number; cap: number }
>();
// #67: /api/resume cannot reach a session's closure state from the server module, so it
// parks a request here and the owning session's poll runs the resume (see resumeLoop).
const resumeRequests = new Map<string, number>();
let server: Server | null = null;
// Every non-starting state is surfaced in the footer: a dead API must never be silent.
//   up    - this process owns the port, or a process of OUR version does.
//   down  - nothing answers the port.
//   stale - a kanban server of ANOTHER version owns the port; reuse is refused.
//   fatal - the bind can never succeed as configured (EACCES/EPERM/bad port). No retry.
let apiState: "starting" | "up" | "down" | "stale" | "fatal" = "starting";
let apiStarting = false;
// #64: one pending retry while "stale" (the old server dies -> the port frees up).
let staleRetryTimer: NodeJS.Timeout | null = null;
// #64: no `ensured` flag. It was set BEFORE listen succeeded, so one failed bind
// silenced the server for the rest of the process. The guards below are the state
// itself (server/apiStarting/apiState), and apiStarting is released in a finally.
// #66: identity, so a reuse can be checked instead of assumed. package.json is read
// at load; if the loader hides it (bundled/jailed) we fall back to a constant, which
// has to be kept in sync with package.json by hand.
const SERVER_VERSION: string = (() => {
	try {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
		if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
	} catch {
		// fall through to the constant
	}
	return "0.2.0"; // must match package.json when it cannot be read at runtime
})();
// #66: set once we actually own the port (a reused server has someone else's clock).
let serverStartedAt: number = 0;
let lastFooter: { ctx: ExtensionContext; sid: string } | null = null;
// Auto-tick bookkeeping (lastTickAt / tickInFlight) is per session: it lives inside
// the factory. Module scope made every session share one 5-minute window, so one
// session firing delayed a sibling's next wake.

// ---------------------------------------------------------------------------
// Paths & persistence (atomic write, missing/corrupt file = empty board)
// ---------------------------------------------------------------------------

const KANBAN_DIR = join(homedir(), ".pi", "kanban");
const GLOBAL_JSON = join(KANBAN_DIR, "global.json");
const MODES_JSON = join(KANBAN_DIR, "modes.json");
const SESSIONS_DIR = join(KANBAN_DIR, "sessions");
const LEGACY_JSON = join(KANBAN_DIR, "board.json");
const DASHBOARD_HTML_PATH = join(KANBAN_DIR, "dashboard.html");
const SERVER_LOG = join(KANBAN_DIR, "server.log");
const MEDIA_DIR = join(KANBAN_DIR, "media");
const SERVE_JSON = join(KANBAN_DIR, "serve.json"); // the registry (A5/A6)
const SERVE_ALLOW_JSON = join(KANBAN_DIR, "serve-allow.json"); // optional allowlist override (A10)
const SERVE_HOST_JSON = join(KANBAN_DIR, "serve-host.json"); // #20: host reported by the board page
const INBOX_SEEN_JSON = join(KANBAN_DIR, "inbox-seen.json"); // ack watermarks, per entry id
const INBOX = "_inbox"; // the one writable subdirectory of a served path
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_UPLOAD = 8 * 1024 * 1024; // images and inbox files
const MAX_UPLOAD_VIDEO = 64 * 1024 * 1024; // a video needs room the image budget cannot give
const INBOX_NUDGE_NAMES = 3; // filenames per INBOX row before collapsing to `+N more`
const OK_EXTS = ["png", "jpg", "gif", "webp", "avif", "mp4", "webm"];
const MIME_BY_EXT: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	mp4: "video/mp4",
	webm: "video/webm",
};

/** The one place the image/video upload split lives: 8MB for images, 64MB for video. */
function uploadLimitOf(ext: string): number {
	return (MIME_BY_EXT[ext] ?? "").startsWith("video/") ? MAX_UPLOAD_VIDEO : MAX_UPLOAD;
}

const fmtMB = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))}MB`;

/** The one place that maps (scope, sessionId) to a file. */
function boardPath(scope: Scope, sessionId: string): string {
	if (scope === "global") return GLOBAL_JSON;
	// The id becomes a filename, so strip anything path-like.
	return join(SESSIONS_DIR, `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

const parseScope = (value: string | null): Scope => (value === "global" ? "global" : "session");

function readRaw(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

/** Pure: parse one board file. */
function readBoard(path: string): Board {
	try {
		const raw = JSON.parse(readRaw(path)) as Board;
		if (raw && Array.isArray(raw.cards) && typeof raw.nextId === "number") {
			return { cards: raw.cards, nextId: raw.nextId };
		}
	} catch {
		// fall through to empty
	}
	return { cards: [], nextId: 1 };
}

/**
 * The loop switches. A missing (or unreadable) file is created with both modes off,
 * so "no config" and "off" behave identically.
 */
/**
 * `repair: false` is the poll path (every 1.5s): a corrupt file must not be rewritten
 * on every poll. Every other caller repairs, so the file still gets fixed once.
 */
function readModesFile(opts: { repair?: boolean } = {}): ModesFile {
	try {
		const raw = JSON.parse(readRaw(MODES_JSON)) as ModesFile;
		if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) return raw;
	} catch {
		// fall through to defaults
	}
	// Both default ON: a fresh session loops without the user arming it (m01207).
	const defaults: ModesFile = { doingLoop: true, autoPick: true };
	if (opts.repair !== false) writeModesFile(defaults);
	return defaults;
}

function writeModesFile(f: ModesFile): void {
	try {
		mkdirSync(KANBAN_DIR, { recursive: true });
		writeFileSync(MODES_JSON, JSON.stringify(f, null, 2));
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		process.stderr.write(`kanban: modes write failed (${MODES_JSON}): ${e.code ?? "error"}: ${e.message}\n`);
	}
}

/** One (scope, sid) pair, falling back to the legacy flat keys when it has no entry. */
function modesFor(f: ModesFile, sid: string, scope: Scope): ModePair {
	const scoped = scope === "global" ? f.GLOBAL : f.SESSION;
	// Absent key means ON; only an explicit false turns a switch off.
	const base: ModePair = { doingLoop: f.doingLoop !== false, autoPick: f.autoPick !== false };
	const entry = scoped?.[sid];
	if (!entry) return base;
	// #61: a stored entry can be PARTIAL (written by an older build, or hand-edited).
	// Read as-is, the missing key stayed `undefined` and the GUI renders `!!m.autoPick`
	// — so the board showed "ピック OFF" while the loop still picked. Fill from base.
	return {
		...entry,
		doingLoop: typeof entry.doingLoop === "boolean" ? entry.doingLoop : base.doingLoop,
		autoPick: typeof entry.autoPick === "boolean" ? entry.autoPick : base.autoPick,
	};
}

/** read-modify-write one (scope, sid) pair. The flat legacy keys are never touched. */
function setMode(f: ModesFile, sid: string, scope: Scope, key: SwitchKey, val: boolean): void {
	const next = (scope === "global" ? f.GLOBAL : f.SESSION) ?? {};
	next[sid] = { ...modesFor(f, sid, scope), [key]: val };
	if (scope === "global") f.GLOBAL = next;
	else f.SESSION = next;
}

/** Persist one board's auto-tick interval (minutes); same read-modify-write as setMode. */
function setIntervalMin(f: ModesFile, sid: string, scope: Scope, minutes: number): void {
	const next = (scope === "global" ? f.GLOBAL : f.SESSION) ?? {};
	next[sid] = { ...modesFor(f, sid, scope), intervalMin: minutes };
	if (scope === "global") f.GLOBAL = next;
	else f.SESSION = next;
}

/** Persist one board's stuck threshold (settle count); same read-modify-write as setMode. */
function setStuckLimit(f: ModesFile, sid: string, scope: Scope, count: number): void {
	const next = (scope === "global" ? f.GLOBAL : f.SESSION) ?? {};
	next[sid] = { ...modesFor(f, sid, scope), stuckLimit: count };
	if (scope === "global") f.GLOBAL = next;
	else f.SESSION = next;
}

/** Persist one board's doing-loop budget; same read-modify-write as setMode. */
function setMaxLoops(f: ModesFile, sid: string, scope: Scope, n: number): void {
	const next = (scope === "global" ? f.GLOBAL : f.SESSION) ?? {};
	next[sid] = { ...modesFor(f, sid, scope), maxLoops: n };
	if (scope === "global") f.GLOBAL = next;
	else f.SESSION = next;
}

/** Displayed minutes for a pair: an entry written before intervalMin existed still means 5. */
export function intervalMinOf(m: { intervalMin?: number }): number {
	const v = m.intervalMin;
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : AUTO_TICK_MS / 60_000;
}

export function intervalMsOf(m: { intervalMin?: number }): number {
	return intervalMinOf(m) * 60_000;
}

/** A stuckLimit is usable only as an integer inside [1,20]; anything else falls back. */
export function isValidStuckLimit(n: unknown): n is number {
	return typeof n === "number" && Number.isInteger(n) && n >= MIN_STUCK_LIMIT && n <= MAX_STUCK_LIMIT;
}

/**
 * Settle threshold for a pair. The reader never throws: a hand-edited modes.json
 * with 0 / 2.5 / "3" still yields a usable number (the default).
 */
export function stuckLimitOf(m: { stuckLimit?: number }): number {
	const v = m.stuckLimit;
	return isValidStuckLimit(v) ? v : DEFAULT_STUCK_LIMIT;
}

/** A maxLoops is usable only as an integer inside [0,1000]; 0 means unlimited. */
export function isValidMaxLoops(n: unknown): n is number {
	return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= MAX_LOOPS_CAP;
}

/**
 * The doing-loop budget for a pair. Absent/invalid (hand-edited "10", 2.5, 5000) means
 * the old hard-coded 10, so an existing modes.json keeps its behavior; 0 or less = 0 =
 * unlimited, which is what the dashboard writes to lift the cap.
 */
export function maxLoopsOf(m: { maxLoops?: number } | undefined | null): number {
	const v = m?.maxLoops;
	if (typeof v !== "number" || !Number.isInteger(v)) return DEFAULT_MAX_LOOPS;
	if (v <= 0) return 0;
	return v <= MAX_LOOPS_CAP ? v : DEFAULT_MAX_LOOPS;
}

/** "3/10" or "3/∞" — the footer's budget fraction (∞ = no cap). */
export function loopRestText(cap: number, count: number): string {
	return cap <= 0 ? `${count}/∞` : `${Math.max(0, cap - count)}/${cap}`;
}

/** "残り 3/10" / "残り 3/∞" for the status line and the tool reply. */
export function loopBudgetText(cap: number, count: number): string {
	return `残り ${loopRestText(cap, count)}`;
}

type MaxLoopsInput = { scope?: string | null; sid?: string | null; n?: string | null };

/**
 * #71/#011: what /api/maxloops should do with a query — no writes, no reads, so this is
 * the whole rule set in one testable place. A missing/unknown scope means session, the
 * same reading parseScope has (the dashboard always sends one).
 *
 * scope=global needs no sid: it writes the GLOBAL layer keyed by the active session (so
 * it does need one of those) — answering "scope=session requires sid" there was a lie.
 */
export function maxLoopsRequest(q: MaxLoopsInput): { kind: "error"; error: string } | { kind: "ok"; scope: Scope; sid: string; n: number } {
	const raw = q.scope ?? "";
	if (raw !== "" && raw !== "global" && raw !== "session") {
		return { kind: "error", error: "scope must be global or session" };
	}
	const scope: Scope = raw === "global" ? "global" : "session";
	const given = q.sid ?? "";
	if (scope === "session") {
		if (given === "") return { kind: "error", error: "scope=session requires sid" };
		return { kind: "ok", scope, sid: given, n: Number(q.n) };
	}
	// GLOBAL is still per-session: modesFor(..., "global") reads f.GLOBAL[sid].
	const sid = given === "" ? (activeSessionId ?? "") : given;
	if (sid === "") return { kind: "error", error: "scope=global requires sid (or an active session)" };
	return { kind: "ok", scope, sid, n: Number(q.n) };
}

/** A priority is usable only as an integer inside [-99,99]; anything else is not a priority. */
export function isValidPriority(n: unknown): n is number {
	return typeof n === "number" && Number.isInteger(n) && n >= MIN_PRIORITY && n <= MAX_PRIORITY;
}

/**
 * A card's priority. The reader never throws: a hand-edited board with
 * "priority": "5" or 1e9 still yields a usable number (0 = no priority).
 */
export function priorityOf(c: { priority?: number }): number {
	const v = c.priority;
	return isValidPriority(v) ? v : 0;
}

/**
 * blocked = "do not touch": it is outside the time axis, so it wins over nextFireAt.
 * Absent or "" (cleared) means no restriction, i.e. pre-Phase-12 behavior.
 */
export function isBlockedCard(c: { blocked?: string }): boolean {
	return typeof c.blocked === "string" && c.blocked.trim().length > 0;
}

/** nextFireAt as epoch ms, or null when absent/unparseable (= no restriction). */
export function fireAtMs(c: { nextFireAt?: string }): number | null {
	if (typeof c.nextFireAt !== "string" || c.nextFireAt.length === 0) return null;
	const t = Date.parse(c.nextFireAt);
	return Number.isNaN(t) ? null : t;
}

/**
 * Silent right now: blocked, scheduled in the future, or already spoken for this exact
 * nextFireAt (firedFor). Every absent field means no restriction, so a card written
 * before these fields existed is picked exactly as it was before.
 */
export function isSilent(c: Card, now: number = Date.now()): boolean {
	if (isBlockedCard(c)) return true;
	const at = fireAtMs(c);
	if (at === null) return false;
	if (at > now) return true;
	return c.firedFor === c.nextFireAt;
}

/**
 * Resolve input to an absolute ISO 8601 string (UTC, ends in Z). Relative "+90m/+3h/+1d"
 * are resolved against `now` BEFORE saving: a relative value on disk would be
 * reinterpreted differently by every reader. "" -> null (clear).
 */
export function normalizeFireAt(input: string, now: number = Date.now()): string | null {
	const s = input.trim();
	if (s.length === 0) return null;
	const rel = /^\+(\d+)([mhd])$/.exec(s);
	if (rel !== null) {
		const n = Number(rel[1]);
		const ms = rel[2] === "m" ? 60_000 : rel[2] === "h" ? 3_600_000 : 86_400_000;
		return new Date(now + n * ms).toISOString();
	}
	const t = Date.parse(s);
	return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * autoPick order for a set of cards: priority descending, ties by id ascending.
 * The id tiebreak is the pre-Phase-7 order, so a board without priorities is unchanged.
 * Callers pass one column's cards; the input array itself is left alone.
 */
export function orderTodos(cards: Card[]): Card[] {
	return [...cards].sort((a, c) => priorityOf(c) - priorityOf(a) || a.id - c.id);
}

/**
 * The settle-chain step: which card are we stuck on and how many times in a row.
 * Pure so the threshold rule is testable without an event loop.
 */
export function nextStuckState(
	prev: { scope: Scope | null; stuckId: number | null; stuckCount: number },
	cardId: number,
	scope: Scope,
	limit: number,
): { stuckId: number; stuckCount: number; stuck: boolean } {
	const same = (prev.scope ?? "session") === scope && prev.stuckId === cardId;
	const stuckCount = same ? prev.stuckCount + 1 : 1;
	return { stuckId: cardId, stuckCount, stuck: stuckCount >= limit };
}

function writeBoardHtml(): void {
	try {
		mkdirSync(KANBAN_DIR, { recursive: true });
		writeFileSync(DASHBOARD_HTML_PATH, DASHBOARD_HTML);
	} catch (err) {
		// best-effort mirror; the JSON remains the source of truth
		const e = err as NodeJS.ErrnoException;
		process.stderr.write(
			`kanban: html write failed (${DASHBOARD_HTML_PATH}): ${e.code ?? "error"}: ${e.message}\n`,
		);
	}
}

/**
 * Persist one board atomically (tmp + rename).
 * Returns the persist error (null on success) — the caller may surface it.
 * Write failure is not fatal: the board keeps being served from memory.
 */
function writeBoard(path: string, b: Board): string | null {
	let persistError: string | null = null;
	try {
		mkdirSync(dirname(path), { recursive: true });
		// pid-unique tmp: a fixed name lets a concurrent writer (the resident
		// server vs. the in-process extension) rename our tmp and persist ITS
		// content under our name, silently dropping cards.
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(b, null, 2));
		renameSync(tmp, path);
	} catch (err) {
		// best-effort; keep serving from memory, but never silently
		const e = err as NodeJS.ErrnoException;
		persistError = `${e.code ?? "error"}: ${e.message}`;
		process.stderr.write(`kanban: board write failed (${path}): ${persistError}\n`);
	}
	return persistError;
}

/**
 * Stamp a column change. movedBy = the session that last changed this card's
 * column; rename / image swap leave it alone.
 */
function stampMove(card: Card, sid: string): void {
	card.movedAt = Date.now();
	card.movedBy = sid;
}

/** Modes entry <=> board file: create the empty session board if it is missing. */
function ensureSessionBoard(sid: string): void {
	const path = boardPath("session", sid);
	if (!existsSync(path)) writeBoard(path, { cards: [], nextId: 1 });
}

/** Once per process: the pre-2-layer board becomes the global layer. */
function migrateLegacyBoard(): void {
	try {
		if (existsSync(LEGACY_JSON) && !existsSync(GLOBAL_JSON)) renameSync(LEGACY_JSON, GLOBAL_JSON);
	} catch {
		// a failed move only leaves the legacy file unread; never block startup
	}
}

/** Once per process: drop session boards nobody touched for 30 days. */
function sweepSessions(): void {
	let names: string[];
	try {
		names = readdirSync(SESSIONS_DIR);
	} catch {
		return; // no sessions dir yet
	}
	const cutoff = Date.now() - SESSION_TTL_MS;
	let swept = 0;
	for (const name of names) {
		if (!name.endsWith(".json")) continue; // leave tmp files alone: a live writer owns them
		try {
			const path = join(SESSIONS_DIR, name);
			if (statSync(path).mtimeMs < cutoff) {
				unlinkSync(path);
				swept++;
			}
		} catch {
			// raced with another process or unreadable -> not fatal
		}
	}
	if (swept > 0) process.stderr.write(`kanban: swept ${swept} session board(s) older than 30d\n`);

	// A modes entry whose board file is gone (and that is not the live session) is a
	// dead key: both scope buckets are keyed by session id.
	const f = readModesFile();
	let pruned = 0;
	for (const scope of ["SESSION", "GLOBAL"] as const) {
		const bucket = f[scope];
		if (bucket === undefined) continue;
		for (const sid of Object.keys(bucket)) {
			if (sid === activeSessionId || existsSync(boardPath("session", sid))) continue;
			delete bucket[sid];
			pruned++;
		}
	}
	if (pruned > 0) {
		writeModesFile(f);
		process.stderr.write(`kanban: pruned ${pruned} orphan modes entr(ies)\n`);
	}
}

// ---------------------------------------------------------------------------
// Rendering (widget lines + per-turn injection text)
// ---------------------------------------------------------------------------

function cardsIn(b: Board, col: Col): Card[] {
	return b.cards.filter((c) => c.col === col);
}

function formatCard(c: Card): string {
	// #57: `c.img` is already the media/ filename, so show it as-is (no path, no basename).
	return `#${c.id} ${c.text ?? ""}${c.img ? `🖼${c.img}` : ""}`;
}

/** Short "[⛔理由 ⏰ISO]" suffix so a tool result shows a gated card's state. */
function gateNote(c: Card): string {
	const parts: string[] = [];
	if (isBlockedCard(c)) parts.push(`⛔${c.blocked}`);
	if (typeof c.nextFireAt === "string" && c.nextFireAt.length > 0) parts.push(`⏰${c.nextFireAt}`);
	return parts.length === 0 ? "" : ` [${parts.join(" ")}]`;
}

/** One priority-list row: `#3 (p=5) 優先順位機能の実装`. */
function formatPriorityCard(c: Card): string {
	return `#${c.id} (p=${priorityOf(c)}) ${c.text}`;
}

function renderColumn(b: Board, col: Col): string {
	const list = cardsIn(b, col).map(formatCard);
	let body: string;
	if (list.length === 0) body = "(なし)";
	else if (list.length > MAX_SHOWN) body = `${list.slice(0, 3).join(" / ")} …ほか${list.length - 3}件`;
	else body = list.join(" / ");
	return `■ ${LABELS[col]}${body}`;
}

function renderLines(b: Board): string[] {
	return COLS.map((col) => renderColumn(b, col));
}

/** The footer's per-board summary: todo/doing only — DONE never needs attention. */
function countsOf(b: Board): string {
	return `${cardsIn(b, "todo").length} todo / ${cardsIn(b, "doing").length} doing`;
}

/**
 * " ⚠Nh" for the oldest DOING card past STALE_MS, else "". Cards with no movedAt
 * are skipped: an unstamped card's age is unknown, and guessing one would be a lie.
 */
function staleTag(b: Board, now = Date.now()): string {
	let oldest = Number.POSITIVE_INFINITY;
	for (const c of cardsIn(b, "doing")) {
		if (typeof c.movedAt === "number" && c.movedAt < oldest) oldest = c.movedAt;
	}
	const ageMs = now - oldest;
	return ageMs >= STALE_MS ? ` ⚠${Math.floor(ageMs / 3_600_000)}h` : "";
}

/**
 * Redraw the footer widget from disk. Reading both layers here (instead of
 * accepting callers' copies) is what keeps a session from rendering a sibling's
 * board; the cost is two small reads per draw.
 *
 * Two lines, fixed: the footer is a summary plus a stale warning, never a board.
 * Cards themselves belong to /kanban, the `kanban` tool and the dashboard.
 */
function refresh(ctx: ExtensionContext, sessionId: string): void {
	if (!ctx.hasUI) return;
	lastFooter = { ctx, sid: sessionId };
	const session = readBoard(boardPath("session", sessionId));
	const global = readBoard(GLOBAL_JSON);
	const f = readModesFile();
	// Appended to the existing GLOBAL line: still exactly two lines, no third.
	// #64: `stale` and `fatal` are states the human must see, not just "DOWN".
	const apiTag =
		apiState === "down"
			? " API DOWN"
			: apiState === "stale"
				? " STALE"
				: apiState === "fatal"
					? " PORT BLOCKED"
					: "";
	// Same line again: a loop halt is a status tag, not a third row.
	ctx.ui.setWidget(
		WIDGET_KEY,
		[
			`GLOBAL: ${countsOf(global)}${staleTag(global)}${apiTag}${loopTagFor(sessionId, "global")}${modeTags(f, sessionId, "global")}`,
			`SESSION: ${displayName(nameOf(ctx))}: ${countsOf(session)}${staleTag(session)}${loopTagFor(sessionId, "session")}${modeTags(f, sessionId, "session")}`,
		],
		{ placement: "aboveEditor" },
	);
}

/** " HALTED:limit" / " HALTED:stuck #n" — the leading space lets callers append it directly. */
function haltTag(l: LoopState): string {
	if (l.halted === "limit") return " HALTED:limit";
	if (l.halted !== "stuck") return "";
	// Card id 0 never exists, so a missing id means it was lost on restore (#4502). Show the reason only.
	return typeof l.stuckId === "number" ? ` HALTED:stuck #${l.stuckId}` : " HALTED:stuck";
}

const loopTags = new Map<string, string>();
// The COUNT per (session, board), never the rendered " 3/10": the cap is read at every
// draw (see modeTags), so a cap change shows up in the footer without another settle.
const loopCount = new Map<string, number>();

const tagKey = (sessionId: string, scope: Scope): string => `${sessionId}|${scope}`;

/** " HALTED:limit" / " HALTED:stuck #n" for one (session, board), "" otherwise. */
function loopTagFor(sessionId: string, scope: Scope): string {
	return loopTags.get(tagKey(sessionId, scope)) ?? "";
}

/** " loop pick 3/10" — only what is ON is shown, so an idle footer never grows. */
function modeTags(f: ModesFile, sessionId: string, scope: Scope): string {
	const m = modesFor(f, sessionId, scope);
	const tags = `${m.doingLoop ? " loop" : ""}${m.autoPick ? " pick" : ""}`;
	if (tags === "") return "";
	const count = loopCount.get(tagKey(sessionId, scope));
	return tags + (count === undefined ? "" : ` ${loopRestText(maxLoopsOf(m), count)}`);
}

/** The count this session has used, for the dashboard's 「残り N / 上限」 row. */
function loopCountOf(sessionId: string): number {
	return Math.max(loopCount.get(tagKey(sessionId, "session")) ?? 0, loopCount.get(tagKey(sessionId, "global")) ?? 0);
}

/** Redraw the last footer we drew (the listen race resolves long after session_start). */
function redrawFooter(): void {
	if (lastFooter === null) return;
	try {
		refresh(lastFooter.ctx, lastFooter.sid);
	} catch {
		// the session that drew it may be gone; the next session_start redraws
	}
}

/**
 * Human label for this session: explicit name > first user message > id prefix.
 * Never throws: the footer must keep drawing even on an old/unreadable session.
 */
function nameOf(ctx: ExtensionContext): string {
	let sid: string;
	try {
		sid = ctx.sessionManager.getSessionId();
	} catch {
		return "?";
	}
	try {
		const named = ctx.sessionManager.getSessionName();
		if (named !== undefined && named.trim().length > 0) return named.trim();
	} catch {
		// no session_info support -> fall through
	}
	try {
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "message" || entry.message.role !== "user") continue;
			const content = entry.message.content;
			const text = (
				typeof content === "string"
					? content
					: content.map((part) => (part.type === "text" ? part.text : "")).join(" ")
			).trim();
			if (text.length > 0) return text.slice(0, 30);
		}
	} catch {
		// entries unreadable -> fall through
	}
	return sid.slice(0, 8);
}

/**
 * One-line, tag-free label for anywhere a name leaves the widget: the footer is a
 * single line of text, so a `/skill <name>` title (which carries `<` and `"`) used
 * to cut the footer in half at the tag. `nameOf` stays raw — only this side bends.
 * maxLen 40 because the footer shares its width with the counts and tags.
 */
export function displayName(raw: string, maxLen = 40): string {
	const flat = raw
		.replace(/[<>"']/g, "")
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.replace(/ {2,}/g, " ")
		.trim();
	if (flat.length === 0) return "(unnamed)"; // an empty name would print `SESSION: : 0 todo`
	return flat.slice(0, maxLen).trimEnd();
}

/**
 * Per-turn injection text: the session board only. Global counts stay out of the
 * prompt on purpose — the model cannot act on them and they only invite drift.
 * DONE is rounded to the newest few cards so a long session cannot grow the
 * injected text without bound. Returns null for an empty board.
 */
export function renderInjectionText(b: Board): string | null {
	if (b.cards.length === 0) return null;
	// #38-10: a DOING row carries how long it has been there, from the existing
	// movedAt stamp (no new state). An unstamped card says nothing rather than "0分".
	const doingAge = (c: Card): string => {
		const mins = typeof c.movedAt === "number" ? Math.floor((Date.now() - c.movedAt) / 60_000) : null;
		return mins === null ? "" : `(${mins}分前から)`;
	};
	const line = (col: Col): string => {
		const list = cardsIn(b, col).map((c) => `${formatCard(c)}${col === "doing" ? doingAge(c) : ""}`);
		if (col === "done") {
			const total = list.length;
			if (total === 0) return `${LABELS[col]}(none)`;
			return `${LABELS[col]}(計${total}件) ${list.slice(-INJECT_DONE).join(" / ")}`;
		}
		return `${LABELS[col]}${list.length === 0 ? "(none)" : list.join(" / ")}`;
	};
	const inbox = inboxNudgeLine(); // null when nothing is unread: no empty line
	return [
		"=== KANBAN (this session) ===",
		line("todo"),
		line("doing"),
		line("done"),
		...(inbox === null ? [] : [inbox]),
		`GUI: open http://${hostname()}:${PORT}/ in a browser.`,
		"Use the `kanban` tool to add/move/remove cards and keep them in sync with the user's real tasks.",
		"=== END KANBAN ===",
	].join("\n");
}

// ---------------------------------------------------------------------------
// Automatic loop (doingLoop / autoPick)
//
// `agent_before_settle` is the only place that can keep a run alive: returning
// { continue: true } makes pi issue one more provider request, and entries[] are
// committed as real session entries first, so a `custom_message` draft is how the
// continuation gets words. A card counts as finished only when it is in DONE on
// disk — the model's claim is never trusted.
// ---------------------------------------------------------------------------

const CARD_TEXT_MAX = 80; // card text lands in a prompt: keep it one flowable line

/**
 * Bound a card's text without splitting a UTF-16 pair.
 * A hand-edited board file can carry a card with no `text`: treat it as "" and keep
 * driving it (a skipped card would silently stall the loop) instead of throwing
 * `Array.from(undefined)` out of the settle/poll path.
 */
function cardTextForPrompt(text: string | undefined): string {
	const src = typeof text === "string" ? text : "";
	const chars = Array.from(src);
	return chars.length > CARD_TEXT_MAX ? `${chars.slice(0, CARD_TEXT_MAX).join("")}…` : src;
}

export function continuationPrompt(card: Card, scope: Scope): string {
	// A global card and a session card can share an id, so the prompt must name the board.
	const body = `#${card.id} "${cardTextForPrompt(card.text)}" を完了させろ。終わったら kanban ツール`;
	// Phase 10: a TODO wake must ask for the move first. The DOING wording is unchanged.
	if (card.col === "todo") {
		const head = scope === "global" ? `GLOBAL TODO #${card.id}` : `TODO #${card.id}`;
		const tail = scope === "global" ? " (scope=global) で DOING" : " で DOING";
		return `${head} "${cardTextForPrompt(card.text)}" を着手しろ。kanban ツール${tail} に移してから作業しろ。`;
	}
	return scope === "global"
		? `GLOBAL DOING ${body} (scope=global) で DONE に移せ。`
		: `DOING ${body} で DONE に移せ。`;
}

/**
 * The card at the head of DOING: lowest id, so a done→todo requeue goes last.
 * Silent cards (blocked / not yet due / already fired) are removed before the sort:
 * a muted head must not starve the due card behind it.
 */
function headDoing(b: Board, now: number): Card | undefined {
	return cardsIn(b, "doing")
		.filter((c) => !isSilent(c, now))
		.sort((a, c) => a.id - c.id)[0];
}

/**
 * Head of DOING among the cards THIS session moved. In the global layer a card with
 * no movedBy has no known owner: picking it would drive a sibling session's work.
 * One `/api/move` stamps it, and it becomes eligible.
 */
function headOwnedDoing(b: Board, sid: string, now: number): Card | undefined {
	return cardsIn(b, "doing")
		.filter((c) => c.movedBy === sid && !isSilent(c, now))
		.sort((a, c) => a.id - c.id)[0];
}

/** The DOING card a scope holds, ignoring that scope's switch. */
function doingHeadOf(sid: string, scope: Scope, now: number = Date.now()): Card | undefined {
	return scope === "global"
		? headOwnedDoing(readBoard(GLOBAL_JSON), sid, now)
		: headDoing(readBoard(boardPath("session", sid)), now);
}

/** The card a scope may drive: nothing at all when its doingLoop switch is off. */
function candidates(sid: string, scope: Scope, f: ModesFile): Card | undefined {
	return modesFor(f, sid, scope).doingLoop ? doingHeadOf(sid, scope) : undefined;
}

/**
 * Head of DOING for a scope, from cards already in hand. Same ownership rule as
 * headOwnedDoing: GLOBAL only counts cards THIS session moved.
 */
export function tickCardFor(cards: Card[], scope: Scope, sid: string, now: number = Date.now()): Card | undefined {
	const doing = cards.filter((c) => c.col === "doing");
	const owned = scope === "global" ? doing.filter((c) => c.movedBy === sid) : doing;
	return owned
		.filter((c) => !isSilent(c, now))
		.sort((a, c) => a.id - c.id)[0];
}

/**
 * Pure: the gate verdict plus WHY it lost. `shouldAutoTick` is the boolean view of
 * this, so the KANBAN_DEBUG trace can never disagree with what the timer does.
 */
export function autoTickVerdict(i: {
	isIdle: boolean;
	doingLoop: boolean;
	card: Card | undefined;
	halted: LoopState["halted"];
	lastTickAt: number;
	lastActivityAt?: number; // undefined = no activity recorded: treat as "just active"
	now: number;
	intervalMs?: number; // omit -> AUTO_TICK_MS (legacy entries)
	menuOpen?: boolean; // a /kanban dialog is on screen: never speak behind it
}): { fire: boolean; reason: string; quiet: boolean } {
	const interval = i.intervalMs ?? AUTO_TICK_MS;
	// Starvation guard: lastActivityAt is a heuristic. If something keeps stamping it,
	// the quiet gate below would never open and the loop would stall forever. Silence
	// on lastTickAt for STARVATION_FACTOR intervals overrides the activity clock.
	const starved = i.now - i.lastTickAt >= interval * STARVATION_FACTOR;
	// Unknown activity means the user may be right here: skipping one wake is far
	// cheaper than talking over them, so an absent clock never fires (unless starved).
	const quiet = starved || (i.lastActivityAt !== undefined && i.now - i.lastActivityAt >= interval);
	// Both clocks must be silent for a full interval. lastTickAt alone only proves the
	// last injection is old; a user message a second ago would still pass it.
	const reason =
		i.menuOpen === true
			? "menu"
			: !i.doingLoop
				? "loop-off"
				: i.card === undefined
					? "no-card"
					: !i.isIdle
						? "busy"
						: i.halted !== null
							? `halted:${i.halted}`
							: i.now - i.lastTickAt < interval
								? "interval"
								: !quiet
									? "not-quiet"
									: "";
	return { fire: reason === "", reason, quiet };
}

/**
 * Pure: may the timer wake the agent right now? Kept side-effect free so every gate
 * (idle, switch, work present, halt, interval, starvation) is testable without a timer or disk.
 */
export function shouldAutoTick(i: Parameters<typeof autoTickVerdict>[0]): boolean {
	return autoTickVerdict(i).fire;
}

/**
 * Pure: is the head (last) message the user's, i.e. did the user just speak? Only then
 * is the run the user's and a continuation the steer noise. Unknowable input
 * (undefined / not an array / empty) returns false = inject: a loop that silently stops
 * is the worse failure.
 * Head-only on purpose: scanning the whole history would let one old prompt freeze the
 * loop for the rest of the session, and no settle would ever bump the loop count.
 */
export function isUserInputHead(messages: unknown[] | undefined): boolean {
	if (!Array.isArray(messages) || messages.length === 0) return false;
	const last = messages[messages.length - 1];
	return typeof last === "object" && last !== null && (last as { role?: unknown }).role === "user";
}

/**
 * Suppress auto-tick while a /kanban menu is open. The flag is cleared in `finally`,
 * so a throw out of ctx.ui (dialog interrupted) cannot leave auto-tick disabled forever.
 */
export async function withMenuGuard<T>(state: { menuOpen: boolean }, fn: () => Promise<T>): Promise<T> {
	state.menuOpen = true;
	try {
		return await fn();
	} finally {
		state.menuOpen = false;
	}
}

const MODE_KEY: Record<string, SwitchKey> = { loop: "doingLoop", pick: "autoPick" };

/** Classification of /kanban argv. Pure, so every branch is testable without UI. */
export type KanbanArgs =
	| { kind: "menu" }
	| { kind: "help" }
	| { kind: "add"; text: string }
	| { kind: "mode"; key: SwitchKey; value: boolean; scope?: Scope }
	| { kind: "modeStatus"; key: SwitchKey; scope?: Scope }
	| { kind: "interval"; scope: Scope; minutes: number }
	| { kind: "intervalStatus"; scope: Scope }
	| { kind: "stuck"; scope: Scope; count: number }
	| { kind: "stuckStatus"; scope: Scope }
	// #67: the doing-loop budget; n === 0 means unlimited.
	| { kind: "maxLoops"; scope: Scope; n: number }
	| { kind: "maxLoopsStatus"; scope: Scope }
	// id/value undefined = bare `/kanban priority` = list; id only = show one card.
	| { kind: "priority"; id: number | undefined; value: number | undefined }
	| { kind: "img"; id: number; path: string }
	| { kind: "take" }
	| { kind: "reject"; reason: string };

const KANBAN_HELP =
	"/kanban <タスク内容>  TODO に追加（add は省略可）\n" +
	"/kanban add <タスク内容>  同じ（空のカードは作りません）\n" +
	"/kanban priority <id> [n]  優先度（大きいほど先に autoPick、-99〜99。無指定で表示、id 無しで TODO 一覧）\n" +
	"/kanban img <id> <path>  ローカル画像を #id に添付（media/ にコピー、8MBまで）\n" +
	"/kanban interval [global] <分>  自動再開の間隔（無指定で現在値）\n" +
	"/kanban stuck [global] <回>  スタック判定の閾値（無指定で現在値）\n" +
	"/kanban maxloops [global] <回>  ループ上限（無指定で現在値、0 = 無制限）\n" +
	"/kanban loop on|off|status [global] / pick on|off\n" +
	"/kanban take  auto-tick の駆動元をこのセッションに切り替える\n" +
	"/kanban  メニュー";

/**
 * Reserved first words: loop / pick / interval / add / take / help. Anything else is a card.
 * `add` is stripped, so `/kanban 買い物` and `/kanban add 買い物` classify identically.
 */
export function parseKanbanArgs(argv: string[]): KanbanArgs {
	const head = argv[0];
	if (head === undefined) return { kind: "menu" };
	if (head === "help") return { kind: "help" };
	// `/kanban take`: ownership is process-global, so any scope word after it is ignored.
	if (head === "take") return { kind: "take" };
	if (head === "add") {
		const text = argv.slice(1).join(" ").trim();
		return text.length === 0 ? { kind: "reject", reason: "使い方: /kanban add <タスク内容>（空のカードは作りません）" } : { kind: "add", text };
	}
	const key = MODE_KEY[head];
	if (key !== undefined) {
		const sub = argv[1];
		if (sub !== undefined && sub !== "on" && sub !== "off" && sub !== "status") {
			return { kind: "reject", reason: "使い方: /kanban loop on|off|status [session|global] / /kanban pick on|off" };
		}
		const scope: Scope | undefined = argv.slice(2).includes("global") ? "global" : undefined;
		if (sub === "on" || sub === "off") {
			return { kind: "mode", key, value: sub === "on", ...(scope === undefined ? {} : { scope }) };
		}
		return { kind: "modeStatus", key, ...(scope === undefined ? {} : { scope }) };
	}
	if (head === "interval") {
		const global = argv[1] === "global";
		const minutesTok = global ? argv[2] : argv[1];
		const scope: Scope = global ? "global" : "session";
		if (minutesTok === undefined) return { kind: "intervalStatus", scope };
		const minutes = Number(minutesTok);
		if (!Number.isFinite(minutes) || minutes <= 0) {
			return { kind: "reject", reason: `使い方: /kanban interval [global] <分>（0より大きい数値）: ${minutesTok}` };
		}
		return { kind: "interval", scope, minutes };
	}
	if (head === "priority") {
		const idTok = argv[1];
		if (idTok === undefined) return { kind: "priority", id: undefined, value: undefined };
		const id = Number(idTok);
		if (!Number.isInteger(id) || id < 1) {
			return { kind: "reject", reason: `使い方: /kanban priority <id> [n]（id は 1 以上の整数）: ${idTok}` };
		}
		const valueTok = argv[2];
		if (valueTok === undefined) return { kind: "priority", id, value: undefined };
		const value = Number(valueTok);
		if (!isValidPriority(value)) {
			return { kind: "reject", reason: `使い方: /kanban priority <id> [n]（${MIN_PRIORITY}〜${MAX_PRIORITY}の整数）: ${valueTok}` };
		}
		return { kind: "priority", id, value };
	}
	if (head === "img") {
		const idTok = argv[1];
		const id = Number(idTok);
		if (idTok === undefined || !Number.isInteger(id) || id < 1) {
			return { kind: "reject", reason: `使い方: /kanban img <id> <path>（id は 1 以上の整数）: ${idTok ?? ""}` };
		}
		// A path the user quotes keeps its spaces: join everything after the id back together.
		const path = argv.slice(2).join(" ").trim();
		if (path.length === 0) {
			return { kind: "reject", reason: "使い方: /kanban img <id> <path>（画像ファイルのパスが必要）" };
		}
		return { kind: "img", id, path };
	}
	if (head === "stuck") {
		const global = argv[1] === "global";
		const countTok = global ? argv[2] : argv[1];
		const scope: Scope = global ? "global" : "session";
		if (countTok === undefined) return { kind: "stuckStatus", scope };
		const count = Number(countTok);
		if (!isValidStuckLimit(count)) {
			return { kind: "reject", reason: `使い方: /kanban stuck [global] <回>（1〜${MAX_STUCK_LIMIT}の整数）: ${countTok}` };
		}
		return { kind: "stuck", scope, count };
	}
	if (head === "maxloops") {
		// #67: 0 = 無制限. Same shape as `stuck`, one number, same scope syntax.
		const global = argv[1] === "global";
		const nTok = global ? argv[2] : argv[1];
		const scope: Scope = global ? "global" : "session";
		if (nTok === undefined) return { kind: "maxLoopsStatus", scope };
		const n = Number(nTok);
		if (!isValidMaxLoops(n)) {
			return { kind: "reject", reason: `使い方: /kanban maxloops [global] <回>（0〜${MAX_LOOPS_CAP}の整数、0 = 無制限）: ${nTok}` };
		}
		return { kind: "maxLoops", scope, n };
	}
	return { kind: "add", text: argv.join(" ").trim() };
}

function setLoopTag(sessionId: string, scope: Scope, tag: string): void {
	if (tag.length === 0) loopTags.delete(tagKey(sessionId, scope));
	else loopTags.set(tagKey(sessionId, scope), tag);
}

/**
 * TODO cards THIS session may pick. The mirror of headOwnedDoing, and the rule is the
 * opposite on purpose: DOING means "someone is on it", so an unowned DOING card is off
 * limits. A TODO means "nobody started it yet", so in the global layer an unstamped one
 * is still fair game -- it only becomes someone else's once a /api/move stamps movedBy.
 * Session boards are ours alone: every TODO there qualifies.
 */
function ownedTodos(cards: Card[], scope: Scope, sid: string): Card[] {
	const todo = cards.filter((c) => c.col === "todo");
	return scope === "global" ? todo.filter((c) => c.movedBy === undefined || c.movedBy === sid) : todo;
}

/**
 * Pure: the TODO autoPick would move next, without moving it. `pickFirstTodo` uses
 * this too, so the poll's wake card is the same card the settle will pick.
 */
export function nextTodo(cards: Card[], scope: Scope, sid: string, now: number = Date.now()): Card | undefined {
	// orderTodos: priority descending, then id ascending (the old rule at equal priority).
	// Silent cards are dropped before ordering, so a blocked/scheduled head cannot
	// starve the pickable card behind it (autoPick as a whole stays alive).
	return orderTodos(ownedTodos(cards, scope, sid).filter((c) => !isSilent(c, now)))[0];
}

/**
 * Move the first TODO card into DOING. Returns the card, or null when there is no
 * TODO left. autoPick keeps a card moving, so the stale warning starts now.
 */
export function pickFirstTodo(sessionId: string, scope: Scope): Card | null {
	const path = boardPath(scope, sessionId);
	const b = readBoard(path);
	const first = nextTodo(b.cards, scope, sessionId);
	if (first === undefined) return null;
	first.col = "doing";
	stampMove(first, sessionId);
	writeBoard(path, b);
	return first;
}

/**
 * Record that the wake for THIS schedule happened: firedFor = the nextFireAt we acted
 * on, so `nextFireAt !== firedFor` means "armed again". nextFireAt itself is never moved
 * (the user decides when it fires next). Call ONLY after a successful injection: a
 * pre-write would turn a failed wake into permanent silence.
 * 同じ nextFireAt の再設定では再発火しない（firedFor と等値）。再点火したいなら値をずらす。
 */
function markFired(card: Card, sid: string, scope: Scope): void {
	if (fireAtMs(card) === null) return;
	const path = boardPath(scope, sid);
	const b = readBoard(path);
	const live = b.cards.find((c) => c.id === card.id);
	if (live === undefined || fireAtMs(live) === null || live.firedFor === live.nextFireAt) return;
	live.firedFor = live.nextFireAt;
	writeBoard(path, b);
	card.firedFor = live.firedFor;
}

// ---------------------------------------------------------------------------
// Local HTTP server (0.0.0.0:8789) for the pi-web right-panel iframe
// ---------------------------------------------------------------------------

// KANBAN_PORT keeps the API testable when a running pi-web already owns 8789.
// #66: validate it. `listen(NaN)` throws ERR_SOCKET_BAD_PORT with no hint about the
// cause, so a typo would look like an outage. Junk -> default + one warning.
const PORT_VALID = (() => {
	const raw = process.env.KANBAN_PORT;
	if (raw === undefined) return 8789;
	const n = Number(raw);
	if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
	process.stderr.write(`kanban: KANBAN_PORT=${JSON.stringify(raw)} is not a port (1-65535); using 8789\n`);
	return 8789;
})();
const PORT = PORT_VALID;
const HOST = "0.0.0.0";
const LISTEN_ATTEMPTS = 4;
const LISTEN_RETRY_MS = 250; // 250 + 500 + 750ms of backoff between the 4 attempts
// #64: after "stale", keep probing for the port to free up, but slowly: a sibling
// pi that never exits must not turn this into a spin. unref() so it never holds the
// process open (pi calls process.exit() anyway; this is for the test harness).
const STALE_RETRY_MS = 30000;
// Gate trace for the auto-loop. Read per call so a test (and KANBAN_DEBUG=1) can toggle it;
// off by default because this runs every 1.5s.
const pollDebugEnabled = (): boolean => /^(1|true|yes)$/i.test(process.env.KANBAN_DEBUG ?? "");

// #76: no wildcard. A page must not be able to read /serve and /api answers from another
// origin, so the ACAO value is decided per request (corsHeaders) and only same-host
// origins are reflected.
const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
	"Access-Control-Max-Age": "600",
};

/**
 * Hostname of a browser-supplied Origin, or null when there is none to compare. "" is the
 * sentinel for "present but origin-less" (literal null, or unparseable), never matching.
 *
 * #76: hostname, not host — the dashboard builds an absolute `http://<host>:8789/api/`
 * URL, so Origin and Host carry DIFFERENT ports by construction. Comparing host (port
 * included) would 403 the dashboard's own fetches.
 */
function originHostname(req: IncomingMessage): string | null {
	const origin = req.headers.origin;
	if (typeof origin !== "string") return null;
	if (origin === "null") return ""; // sentinel: present but origin-less
	try {
		return new URL(origin).hostname;
	} catch {
		return ""; // unparseable: same sentinel, never matches a Host
	}
}

function isSameHostOrigin(req: IncomingMessage): boolean {
	const hostname = originHostname(req);
	if (hostname === null || hostname === "") return false;
	const host = (req.headers.host ?? "").toLowerCase();
	const bare = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
	return hostname.toLowerCase() === bare;
}

/**
 * #76: the CORS answer for one request. No Origin = no CORS headers (nothing to allow).
 * Same-host Origin is reflected (the right panel builds an absolute :8789 URL, so its
 * answer is useless to the page without this); anything else is left without an
 * allow-origin header at all — "null" would be a value a browser accepts, which is the
 * hole this removes. Vary is set because the answer depends on the caller's Origin.
 */
function corsHeaders(req: IncomingMessage): Record<string, string> {
	if (req.headers.origin === undefined) return { ...CORS_HEADERS };
	if (!isSameHostOrigin(req)) return { ...CORS_HEADERS, Vary: "Origin" };
	return { ...CORS_HEADERS, "Access-Control-Allow-Origin": String(req.headers.origin), Vary: "Origin" };
}

/**
 * #67/#76: refuse a browser-originated cross-origin write before it reaches a handler.
 * Sec-Fetch-* is forbidden header name territory: a page cannot set or omit it, so its
 * presence means a browser sent it. A request with no Sec-Fetch-Site is not a browser
 * (curl, a peer pi, probeServer's fetch, the agent tools) and is outside the CSRF threat
 * model, so it is allowed — making this header mandatory would break every script caller.
 *
 * Sec-Fetch-Site is judged FIRST (same-site included: the right panel runs on another
 * port of this host), because Origin is the weaker signal: judging Origin first would let
 * an attacker who can shape Origin widen the null-origin hole. Origin is then compared
 * host-to-host, not origin-to-origin — the panel's own port is not PORT.
 * Origin: null (sandboxed iframe, some privacy modes) carries no host to compare, so it is
 * refused outright; it used to be waved through.
 */
function crossOriginWriteRefusal(req: IncomingMessage): string | null {
	const site = req.headers["sec-fetch-site"];
	if (typeof site === "string") {
		const v = site.trim().toLowerCase();
		if (v !== "same-origin" && v !== "same-site" && v !== "none") return `cross-origin write refused (Sec-Fetch-Site: ${v})`;
	}
	const origin = req.headers.origin;
	if (origin === undefined) return null; // no Origin: not a page (or a page's subresource)
	if (origin === "null") return "cross-origin write refused (Origin: null)";
	const hostname = originHostname(req);
	if (hostname === null) return null;
	if (hostname === "") return "cross-origin write refused (Origin: unparseable)";
	if (!isSameHostOrigin(req)) return `cross-origin write refused (Origin: ${origin})`;
	return null;
}

/**
 * #76: every path in here mutates process state (board, modes, registry, inbox bytes).
 * Reads are deliberately absent: gating them would break the served file viewer.
 * Verb-independent on purpose — /api/add and friends are still GET + query, so a verb
 * check would let the whole write surface through.
 */
function isWritePath(pathname: string, method: string): boolean {
	if (pathname === "/api/upload" || pathname === "/api/selftest") return true;
	if (pathname === "/api/host" || pathname === "/api/serve") return true;
	if (method === "POST" && (pathname === SERVE_PREFIX || pathname.startsWith(`${SERVE_PREFIX}/`))) return true;
	if (method !== "GET") return false;
	switch (pathname) {
		case "/api/add":
		case "/api/move":
		case "/api/remove":
		case "/api/rename":
		case "/api/modes":
		case "/api/interval":
		case "/api/stuck":
		case "/api/maxloops":
		case "/api/resume":
		case "/api/priority":
		case "/api/schedule":
			return true;
		default:
			return false;
	}
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// Local path serving (/serve/<id>/...) on the existing 8789 server (A11/A14)
// ---------------------------------------------------------------------------

type ServeEntry = { id: string; path: string; title?: string; createdAt?: string; permanent?: boolean; expiresAt?: string };
type DirEntry = { name: string; type: "dir" | "file"; size: number; mtime: number };

const SERVE_PREFIX = "/serve";

/** A4: the URL id is a pure function of the absolute path, so re-adding is stable. */
function serveIdFor(absPath: string): string {
	return createHash("sha256").update(absPath).digest("hex").slice(0, 16);
}

/** Read the registry. Corrupt/missing file = empty; malformed entries are dropped. */
function readServeFile(): ServeEntry[] {
	try {
		const raw = JSON.parse(readRaw(SERVE_JSON)) as { entries?: unknown };
		if (!Array.isArray(raw.entries)) return [];
		const out: ServeEntry[] = [];
		for (const item of raw.entries) {
			if (item === null || typeof item !== "object") continue;
			const e = item as { id?: unknown; path?: unknown; title?: unknown; createdAt?: unknown; permanent?: unknown; expiresAt?: unknown };
			if (typeof e.id === "string" && e.id.length > 0 && typeof e.path === "string" && isAbsolute(e.path)) {
				const entry: ServeEntry = { id: e.id, path: e.path };
				if (typeof e.title === "string" && e.title.length > 0) entry.title = e.title;
				if (typeof e.createdAt === "string") entry.createdAt = e.createdAt;
				if (e.permanent === true) entry.permanent = true;
				if (typeof e.expiresAt === "string") entry.expiresAt = e.expiresAt;
				out.push(entry);
			}
		}
		return out;
	} catch {
		return [];
	}
}

/** Same atomic tmp+rename discipline as writeBoard: a reader never sees a half file. */
function writeServeFile(entries: ServeEntry[]): string | null {
	try {
		mkdirSync(dirname(SERVE_JSON), { recursive: true });
		const tmp = `${SERVE_JSON}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify({ entries }, null, 2));
		renameSync(tmp, SERVE_JSON);
		return null;
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		const msg = `${e.code ?? "error"}: ${e.message}`;
		process.stderr.write(`kanban: serve write failed (${SERVE_JSON}): ${msg}\n`);
		return msg;
	}
}

// --- 期限 (A5): 既定 7 日、permanent で無期限 ------------------------------------
// 判定は serveExpiry 一本。読み取り経路は serveLookup を通し、期限切れは 410 で
// 404 と区別する（「在ったが消えた」は「無い」とは意味が違う）。

const SERVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SERVE_SWEEP_MS = 60 * 60 * 1000;
let lastServeSweep = 0;

/** 無期限なら null。expiresAt は明示期限（今は登録側から書かないが分岐は残す）。 */
function serveExpiry(e: ServeEntry): number | null {
	if (e.permanent === true) return null;
	if (e.expiresAt) {
		const t = Date.parse(e.expiresAt);
		if (!Number.isNaN(t)) return t;
	}
	if (e.createdAt) {
		const t = Date.parse(e.createdAt);
		if (!Number.isNaN(t)) return t + SERVE_TTL_MS;
	}
	return null; // createdAt の無い既存エントリは推測で埋めない・消さない
}

function serveIsExpired(e: ServeEntry, now: number): boolean {
	const at = serveExpiry(e);
	return at !== null && at <= now;
}

/** 期限の ISO（無期限は ""）。dashboard の残り時間表示がこれを使う。 */
function serveExpiresAtIso(e: ServeEntry): string {
	const at = serveExpiry(e);
	return at === null ? "" : new Date(at).toISOString();
}

type ServeLookup = { expired: boolean; entry: ServeEntry };

/** serve の全経路の入口。見つからない null と期限切れ expired:true を区別する。 */
function serveLookup(id: string): ServeLookup | null {
	const entry = readServeFile().find((e) => e.id === id);
	if (entry === undefined) return null;
	return { expired: serveIsExpired(entry, Date.now()), entry };
}

/** 期限切れを serve.json から実削除する（読み取り時の隠蔽だけでは溜まり続ける）。 */
function sweepServe(): void {
	const entries = readServeFile();
	const now = Date.now();
	const live = entries.filter((e) => !serveIsExpired(e, now));
	const removed = entries.length - live.length;
	if (removed === 0) return;
	const err = writeServeFile(live);
	if (err === null) process.stderr.write(`kanban: swept ${removed} expired serve entr(ies)\n`);
	else process.stderr.write(`kanban: serve sweep failed: ${err}\n`);
}

/** 毎 tick ではなく 1 時間に 1 回だけ。 */
function sweepServeThrottled(): void {
	const now = Date.now();
	if (now - lastServeSweep < SERVE_SWEEP_MS) return;
	lastServeSweep = now;
	sweepServe();
}

/** Realpath when it exists, else the input. Used to compare symlinks honestly. */
function realOrSelf(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

/** A10: ~/workspace by default; serve-allow.json overrides wholesale. */
function serveAllowRoots(): string[] {
	// #66-security: KANBAN_DIR is deliberately NOT a default root. It holds global.json,
	// sessions/*.json and media/, so allowing it published the whole board unauthenticated
	// through /serve/. Serving it is still possible by naming it in serve-allow.json.
	const defaults = [join(homedir(), "workspace")];
	try {
		const raw = JSON.parse(readRaw(SERVE_ALLOW_JSON)) as { roots?: unknown };
		if (Array.isArray(raw.roots)) {
			const roots = raw.roots
				.filter((r): r is string => typeof r === "string" && r.length > 0)
				.map((r) => realOrSelf(resolve(r)));
			if (roots.length > 0) return roots; // an empty list is not a way to widen anything
		}
	} catch {
		// unreadable override -> defaults
	}
	return defaults.map((r) => realOrSelf(resolve(r)));
}

/** Lexical containment: `abs` is `root` itself or a descendant. */
function isUnder(abs: string, roots: string[]): boolean {
	return roots.some((r) => {
		const base = r.endsWith(sep) ? r.slice(0, -1) : r;
		return abs === base || abs.startsWith(base + sep);
	});
}

/** #20: scheme-less and trailing-slash input is routine; only an http(s) URL survives. */
function normalizeBaseUrl(input: string): string | null {
	const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `http://${input}`;
	let url: URL;
	try {
		url = new URL(scheme);
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	if (url.hostname.length === 0) return null;
	if (url.port === "") url.port = String(PORT); // baseUrl names a host, the port is ours
	return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * #20: the host part of every emitted /serve URL, in priority order:
 * KANBAN_BASE_URL -> serve-allow.json `baseUrl` -> the host learned from the board page
 * or a /serve Host header -> the container hostname. A malformed explicit value is logged
 * and skipped, never allowed to take the listing down.
 */
function serveBaseUrl(): string {
	const fallback = `http://${hostname()}:${PORT}`;
	const explicit = (process.env.KANBAN_BASE_URL ?? "").trim();
	if (explicit.length > 0) {
		const normalized = normalizeBaseUrl(explicit);
		if (normalized !== null) return normalized;
		logServer(`serve: ignoring malformed KANBAN_BASE_URL ${JSON.stringify(explicit)}`);
	}
	let baseUrl: unknown;
	try {
		baseUrl = (JSON.parse(readRaw(SERVE_ALLOW_JSON)) as { baseUrl?: unknown }).baseUrl;
	} catch {
		baseUrl = undefined;
	}
	if (typeof baseUrl === "string" && baseUrl.trim().length > 0) {
		const normalized = normalizeBaseUrl(baseUrl.trim());
		if (normalized !== null) return normalized;
		logServer(`serve: ignoring malformed baseUrl ${JSON.stringify(baseUrl)} in ${SERVE_ALLOW_JSON}`);
	}
	// The learned host is a bare name (location.hostname or a Host header's hostname):
	// normalizeBaseUrl() adds OUR port.
	const learned = learnedServeHost();
	if (learned !== null) return normalizeBaseUrl(learned) ?? fallback;
	return fallback;
}

/**
 * #20: nothing inside this container knows the address the user's browser uses
 * (hostname = container id, the docker IP is unreachable, no tailscale). The board
 * page knows: inside pi-web's `<iframe srcdoc>` it sees the parent's location.hostname.
 * #22: loopback is accepted. location.hostname is the host the user's browser actually
 * reached pi-web at, so for a user on http://127.0.0.1:8787 that IS the right answer.
 */
function hostNameOf(host: string): string {
	const h = host.trim();
	if (h.startsWith("[")) {
		const end = h.indexOf("]");
		return (end < 0 ? h.slice(1) : h.slice(1, end)).toLowerCase();
	}
	return (h.split(":")[0] ?? "").toLowerCase();
}

/**
 * #24: loopback is the ambiguous half of the serve-host evidence. In a Host header it is
 * equally "the user's browser reached us at 127.0.0.1" and "curl inside the container hit
 * us by IP", and nothing in the request tells the two apart. Only these four spellings
 * count; the whole 127/8 block was never met in practice (#22), so it stays out.
 * The argument is expected to be hostNameOf()'s output: lowercased, port and brackets gone.
 */
function isLoopbackHost(name: string): boolean {
	return name === "127.0.0.1" || name === "localhost" || name === "::1" || name === "::ffff:127.0.0.1";
}

function isUsableServeHost(host: string): boolean {
	if (host.length === 0 || host.length > 253) return false;
	if (!/^[A-Za-z0-9.\-[\]:]+$/.test(host)) return false;
	const name = hostNameOf(host);
	if (name.length === 0) return false;
	// #22: the container id stays rejected on purpose. It is the exact value serveBaseUrl()
	// already falls back to, and no browser reaches this box by that name, so learning it
	// would persist a host that never works. Loopback is not that: it is reachable, and it
	// came from the user's browser, so it must be kept.
	return name !== hostname().toLowerCase();
}

/** serve-host.json: the host reported by the board page or learned from a /serve Host. */
function learnedServeHost(): string | null {
	try {
		const raw = (JSON.parse(readRaw(SERVE_HOST_JSON)) as { host?: unknown }).host;
		return typeof raw === "string" && isUsableServeHost(raw) ? raw : null;
	} catch {
		return null;
	}
}

/**
 * #23: /serve is browser traffic — handle() routes every /serve path here and nothing
 * else — so its Host header names the host the user actually reached us at, and it
 * survives a sandboxed iframe whose page JS is dead. `/api/*` is deliberately NOT a
 * source: our own tools and curl call it with `Host: 127.0.0.1`, and that machine value
 * would overwrite what a real browser taught us. The header itself is outside the trust
 * boundary, so it passes the same isUsableServeHost gate as POST /api/host and only the
 * normalized hostname is ever persisted. A bad header is skipped in silence: it must
 * never turn a 200 into an error.
 */
function learnServeHostFromHeader(raw: string | undefined): void {
	if (raw === undefined) return;
	const value = raw.trim();
	if (!isUsableServeHost(value)) return;
	// The port is dropped on purpose (hostNameOf): serve-host.json holds the *name* the
	// browser used, and normalizeBaseUrl() supplies our port. A proxy on another port
	// stays expressible through KANBAN_BASE_URL / serve-allow.json `baseUrl`.
	const name = hostNameOf(value);
	// #24: an incidental loopback Host must never displace a host that only a browser could
	// have named. Real accident: the user opened http://nas:8789/serve/, then a curl inside
	// this container hit 127.0.0.1 — "last value wins" flipped serve-host.json to
	// 127.0.0.1, an address no browser on the LAN can reach. Non-loopback is therefore
	// always strong evidence, and loopback only wins against nothing, or against loopback.
	if (isLoopbackHost(name)) {
		const prev = learnedServeHost();
		if (prev !== null && !isLoopbackHost(hostNameOf(prev))) return;
	}
	const host = name.includes(":") ? `[${name}]` : name; // ipv6 keeps its brackets
	try {
		mkdirSync(KANBAN_DIR, { recursive: true });
		writeFileSync(SERVE_HOST_JSON, JSON.stringify({ host, at: new Date().toISOString() }));
	} catch {
		// a read-only HOME must still serve
	}
}

/**
 * #23: the last resort in serveBaseUrl() is the container id, which no browser reaches.
 * Say so once, and only while it is actually the answer: an explicit env/baseUrl or a
 * learned host means there is nothing for the user to teach.
 */
function serveHostFallbackHint(): string | null {
	if (serveBaseUrl() !== `http://${hostname()}:${PORT}`) return null;
	return `hint: open http://${hostname()}:${PORT}${SERVE_PREFIX}/ once in your browser so the board learns your host.`;
}

/**
 * POST /api/host { host }: the one trusted source, because a page sent it.
 * #24: the loopback priority rule of learnServeHostFromHeader() deliberately does NOT
 * apply here. A page names the host it is running on, so a reported 127.0.0.1 IS the
 * answer for that user — it is not the ambiguous, mechanical by-IP read an incidental
 * /serve Host can be. Making it refuse to update would also strand a stale non-loopback
 * name (e.g. the user moved from nas to localhost). #22 and serve-allow.test.mjs 20-12 /
 * 20-12b pin this: after "myhost.ts.net", reporting "127.0.0.1" then "localhost" must be
 * recorded. So this path keeps its last-write-wins behavior.
 */
function handleHostReport(req: IncomingMessage, res: ServerResponse): void {
	collectBody(req, res, 1024, (buf) => {
		if (buf === null) return; // 413/400 already sent
		let host: unknown;
		try {
			host = (JSON.parse(buf.toString("utf8")) as { host?: unknown }).host;
		} catch {
			sendJson(res, 400, { ok: false, error: "bad json" });
			return;
		}
		const value = typeof host === "string" ? host.trim() : "";
		if (!isUsableServeHost(value)) {
			sendJson(res, 400, { ok: false, error: "bad host" });
			return;
		}
		try {
			mkdirSync(KANBAN_DIR, { recursive: true });
			writeFileSync(SERVE_HOST_JSON, JSON.stringify({ host: value, at: new Date().toISOString() }));
		} catch (e) {
			sendJson(res, 500, { ok: false, error: `write failed: ${(e as { code?: string }).code ?? "error"}` });
			return;
		}
		sendJson(res, 200, { ok: true, host: value });
	});
}

type ServeAddResult = { ok: true; entry: ServeEntry } | { ok: false; status: number; error: string };

/**
 * C1: one absolute path in, one URL's worth of registry out. Allowlist is checked
 * here (A10) on the realpath, so a symlink can't smuggle an outside target past it.
 */
function serveAdd(input: string, permanent = false, title?: string): ServeAddResult {
	if (!isAbsolute(input)) return { ok: false, status: 400, error: "path must be absolute" };
	const abs = resolve(input);
	// #19: the allowlist decides before the filesystem does. A denial must look the same
	// whether or not the path exists, or a 404 would leak the existence of outside paths.
	if (!isUnder(realOrSelf(abs), serveAllowRoots())) {
		return { ok: false, status: 403, error: `outside the serve allowlist: ${abs}` };
	}
	let st: Stats;
	try {
		st = statSync(abs);
	} catch {
		return { ok: false, status: 404, error: `not found: ${abs}` };
	}
	if (!st.isDirectory() && !st.isFile()) return { ok: false, status: 400, error: "not a file or directory" };
	const id = serveIdFor(abs);
	const entries = readServeFile();
	const existing = entries.find((e) => e.id === id);
	if (existing !== undefined) {
		// A4: same path -> same URL. permanent is the only thing a re-add may change.
		if (permanent && existing.permanent !== true) {
			existing.permanent = true;
			const err = writeServeFile(entries);
			if (err !== null) return { ok: false, status: 500, error: `write failed: ${err}` };
		}
		return { ok: true, entry: existing };
	}
	const entry: ServeEntry = { id, path: abs, createdAt: new Date().toISOString() };
	if (permanent) entry.permanent = true;
	// #50: 人間が読む名前。省略可（無ければダッシュボードは URL だけ出す）。
	const named = typeof title === "string" ? title.trim().slice(0, 200) : "";
	if (named.length > 0) entry.title = named;
	const persist = writeServeFile([...entries, entry]);
	if (persist !== null) return { ok: false, status: 500, error: `write failed: ${persist}` };
	return { ok: true, entry };
}

/** A6: accept the id, or the original path (so an already-deleted path can still be removed). */
function serveRemove(input: string): ServeEntry | null {
	const entries = readServeFile();
	// An exact id hit always wins: ids are opaque, so a stored id is never ambiguous with a path.
	// (Matching on /^[0-9a-f]{16}$/ instead dropped hand-written ids into the path branch.)
	const targetId = entries.some((e) => e.id === input) ? input : serveIdFor(resolve(input));
	const removed = entries.find((e) => e.id === targetId) ?? null;
	if (removed === null) return null;
	writeServeFile(entries.filter((e) => e.id !== targetId));
	return removed;
}

/** A9: a registry entry whose path is gone (or whose deadline passed) is not listed. */
function serveLiveEntries(): ServeEntry[] {
	const now = Date.now();
	return readServeFile().filter((e) => existsSync(e.path) && !serveIsExpired(e, now));
}

/** 永久トグル。true で無期限、false で既定 7 日期限に戻す。 */
function serveSetPermanent(id: string, value: boolean): ServeEntry | null {
	const entries = readServeFile();
	const entry = entries.find((e) => e.id === id);
	if (entry === undefined) return null;
	if (value) entry.permanent = true;
	else delete entry.permanent;
	writeServeFile(entries);
	return entry;
}

function serveUrlFor(entry: ServeEntry): string {
	let dir = false;
	try {
		dir = statSync(entry.path).isDirectory();
	} catch {
		// gone -> the bare id URL still 404s cleanly
	}
	return `${serveBaseUrl()}${SERVE_PREFIX}/${entry.id}${dir ? "/" : ""}`;
}

// --- _inbox: the one write direction (A14 revised) ------------------------------------
// A served page can only ever write into `<path>/_inbox/<name>`, one level, no slashes.
// The bytes are plain files on disk, so the agent picks them up with the ordinary
// `ls` / `read` / `grep` tools — there is no read path to add, only a write path.

/**
 * Why a delivered write would be unsafe (A2). A symlinked `_inbox` could point outside
 * the served directory, so its realpath is compared against the served root too.
 */
function inboxRejection(root: string, name: string): { status: number; error: string } | null {
	if (name.length === 0 || name === "." || name === ".." || /[\/\\\0]/.test(name)) {
		return { status: 400, error: "bad name" };
	}
	const dir = join(root, INBOX);
	if (!isUnder(realOrSelf(dir), [root])) return { status: 403, error: "inbox escapes the served path" };
	const target = join(dir, name);
	if (!isUnder(realOrSelf(target), [root])) return { status: 403, error: "inbox escapes the served path" };
	return null;
}

/** Persist the raw body. refusals (400/403/413) answer without touching the disk. */
function writeInbox(req: IncomingMessage, res: ServerResponse, entry: ServeEntry, name: string): void {
	// The allowlist was checked at registration, but the served dir can be re-pointed
	// afterwards: re-check the write destination itself, right before writing.
	const served = resolve(entry.path);
	if (!isUnder(realOrSelf(served), serveAllowRoots())) {
		sendJson(res, 403, { ok: false, error: "write denied: served path is outside the allowlist" });
		req.resume();
		return;
	}
	collectBody(req, res, MAX_UPLOAD, (buf) => {
		if (buf === null) return; // 413/400 already sent
		let root: string;
		let realRoot: string;
		try {
			root = resolve(entry.path);
			realRoot = realpathSync(root);
		} catch {
			sendJson(res, 404, { ok: false, error: "registered path is gone" });
			return;
		}
		const rejected = inboxRejection(realRoot, name);
		if (rejected !== null) {
			sendJson(res, rejected.status, { ok: false, error: rejected.error });
			return;
		}
		const dir = join(root, INBOX);
		const target = join(dir, name);
		try {
			mkdirSync(dir, { recursive: true, mode: 0o755 });
			writeFileSync(target, buf);
		} catch (err) {
			const e = err as NodeJS.ErrnoException;
			sendJson(res, 500, { ok: false, error: `write failed: ${e.code ?? "error"}: ${e.message}` });
			return;
		}
		logServer(`inbox write ${target} (${buf.length} B)`);
		sendJson(res, 200, { ok: true, path: target, name, bytes: buf.length });
	});
}

// --- inbox unread tracking (ack + nudge) ----------------------------------------------

type SeenMap = Record<string, number>;

function readSeen(): SeenMap {
	try {
		const raw = JSON.parse(readRaw(INBOX_SEEN_JSON)) as unknown;
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
		const out: SeenMap = {};
		for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
			if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
		}
		return out;
	} catch {
		return {};
	}
}

/** Atomic tmp+rename, same discipline as writeBoard: a reader never sees half a file. */
function writeSeen(seen: SeenMap): string | null {
	try {
		mkdirSync(dirname(INBOX_SEEN_JSON), { recursive: true });
		const tmp = `${INBOX_SEEN_JSON}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(seen, null, 2));
		renameSync(tmp, INBOX_SEEN_JSON);
		return null;
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		const msg = `${e.code ?? "error"}: ${e.message}`;
		process.stderr.write(`kanban: inbox-seen write failed (${INBOX_SEEN_JSON}): ${msg}\n`);
		return msg;
	}
}

/**
 * Files in `<entry.path>/_inbox` newer than the entry's watermark. No record = 0, so
 * every existing file counts as unread until an `ack` moves the watermark.
 */
function inboxUnread(entry: ServeEntry, seen: SeenMap): { name: string; mtime: number }[] {
	const since = seen[entry.id] ?? 0;
	let names: Dirent[];
	try {
		names = readdirSync(join(entry.path, INBOX), { withFileTypes: true });
	} catch {
		return []; // no _inbox yet -> nothing unread
	}
	const out: { name: string; mtime: number }[] = [];
	for (const d of names) {
		let st: Stats;
		try {
			st = statSync(join(entry.path, INBOX, d.name));
		} catch {
			continue;
		}
		if (!st.isFile() || st.mtimeMs <= since) continue;
		out.push({ name: d.name, mtime: st.mtimeMs });
	}
	return out.sort((a, b) => a.mtime - b.mtime);
}

/** One INBOX line for the per-turn injection, or null when every inbox is empty. */
function inboxNudgeLine(): string | null {
	const seen = readSeen();
	const rows = serveLiveEntries()
		.map((e) => ({ label: basename(e.path), unread: inboxUnread(e, seen) }))
		.filter((r) => r.unread.length > 0);
	if (rows.length === 0) return null;
	const total = rows.reduce((n, r) => n + r.unread.length, 0);
	const parts = rows.map((r) => {
		const names = r.unread.slice(0, INBOX_NUDGE_NAMES).map((u) => u.name);
		const more = r.unread.length - names.length;
		return `${r.label}: ${names.join(", ")}${more > 0 ? ` +${more} more` : ""}`;
	});
	return `INBOX  ${total} unread (${parts.join("; ")})`;
}

type AckResult = { ok: true; acked: number } | { ok: false; status: number; error: string };

/**
 * ack = move a watermark. It never deletes: removing a file stays an `rm` decision.
 * The watermark is one timestamp per entry id, so acking one name also marks the other
 * files already in that entry's `_inbox` as read — the granularity the spec fixes.
 */
function serveAck(id: string | undefined, name: string | undefined): AckResult {
	if (name !== undefined && id === undefined) return { ok: false, status: 400, error: "name requires id" };
	const registered = readServeFile();
	const entries = id === undefined ? registered : registered.filter((e) => e.id === id);
	if (id !== undefined && entries.length === 0) return { ok: false, status: 404, error: `no served path with id ${id}` };
	if (name !== undefined) {
		const rejected = inboxRejection(realOrSelf(entries[0].path), name);
		if (rejected !== null) return { ok: false, ...rejected };
	}
	const seen = readSeen();
	const now = Date.now();
	let acked = 0;
	for (const e of entries) {
		const unread = inboxUnread(e, seen);
		acked += name === undefined ? unread.length : unread.filter((u) => u.name === name).length;
		seen[e.id] = now;
	}
	const err = writeSeen(seen);
	if (err !== null) return { ok: false, status: 500, error: `write failed: ${err}` };
	return { ok: true, acked };
}

// --- content type / caching / listing -------------------------------------------------

const SERVE_MIME: Record<string, string> = {
	html: "text/html",
	htm: "text/html",
	css: "text/css",
	js: "text/javascript",
	mjs: "text/javascript",
	json: "application/json",
	map: "application/json",
	txt: "text/plain",
	md: "text/markdown",
	csv: "text/csv",
	svg: "image/svg+xml",
	xml: "application/xml",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	ico: "image/x-icon",
	mp4: "video/mp4",
	m4v: "video/mp4",
	webm: "video/webm",
	mov: "video/quicktime",
	mkv: "video/x-matroska",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	m4a: "audio/mp4",
	ogg: "audio/ogg",
	pdf: "application/pdf",
	zip: "application/zip",
	wasm: "application/wasm",
};

function serveExt(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * #67: MIMEs a browser would *execute* in our origin. /serve is unauthenticated and
 * anyone on the LAN can drop a file into a served dir, so these are downgraded to
 * text/plain + attachment (see serveFileOpts). Images, audio, video, PDF and zip stay
 * as they are: the dashboard renders them, and none of them run script in our origin.
 */
const SERVE_ACTIVE_MIME = new Set([
	"text/html",
	"application/xhtml+xml",
	"image/svg+xml",
	"text/javascript",
	"application/javascript",
	"application/x-javascript",
	"application/ecmascript",
	"text/ecmascript",
	"application/xml",
	"text/xml",
	"application/wasm",
]);

/** B3: text/* needs an explicit charset or the browser guesses (mojibake). */
function serveMimeOf(name: string): string {
	const type = SERVE_MIME[serveExt(name)] ?? "application/octet-stream";
	// #67: an executable type is not merely relabelled here; serveFileOpts also attaches
	// Content-Disposition: attachment, so the browser downloads instead of rendering.
	if (SERVE_ACTIVE_MIME.has(type)) return "text/plain; charset=utf-8";
	return type.startsWith("text/") ? `${type}; charset=utf-8` : type;
}

/** B4: generated files grow, so HTML/JSON must not be cached; media is immutable enough. */
function serveCacheOf(name: string): string {
	const ext = serveExt(name);
	return ext === "html" || ext === "htm" || ext === "json" ? "no-store" : "public, max-age=60";
}

function serveDirEntries(dir: string): DirEntry[] {
	let names: Dirent[];
	try {
		names = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: DirEntry[] = [];
	for (const d of names.sort((a, b) => a.name.localeCompare(b.name))) {
		let st: Stats;
		try {
			st = statSync(join(dir, d.name)); // follows symlinks; a broken one is skipped
		} catch {
			continue;
		}
		out.push({ name: d.name, type: st.isDirectory() ? "dir" : "file", size: st.size, mtime: st.mtimeMs });
	}
	return out;
}

function escHtml(s: string): string {
	return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

function serveText(res: ServerResponse, status: number, type: string, body: string, isHead: boolean): void {
	res.writeHead(status, {
		"Content-Type": type,
		"Cache-Control": "no-store",
		"Content-Length": Buffer.byteLength(body),
	});
	if (isHead) {
		res.end();
		return;
	}
	res.end(body);
}

/** B1: a 416 still carries the unsatisfiable-range Content-Range so the client can resync. */
function serve416(res: ServerResponse, size: number): void {
	res.writeHead(416, {
		"Content-Range": `bytes */${size}`,
		"Content-Type": "text/plain; charset=utf-8",
		"Cache-Control": "no-store",
		"Accept-Ranges": "bytes",
	});
	res.end("range not satisfiable\n");
}

/**
 * The per-route differences /serve and /api/media must keep: the Content-Type rule
 * (serveMimeOf vs MIME_BY_EXT) and Cache-Control rule (serveCacheOf vs no-store).
 * Last-Modified stays optional so media keeps the headers it had before.
 */
type FileServeOpts = { contentType: string; cacheControl: string; lastModified?: string; download?: boolean };

/**
 * One byte-range serve shared by /serve and /api/media. Single range only; a
 * multi-range request is answered 416. HEAD gets the headers and no body.
 */
function serveFile(req: IncomingMessage, res: ServerResponse, abs: string, st: Stats, opts: FileServeOpts): void {
	const size = st.size;
	const headers: Record<string, string | number> = {
		"Content-Type": opts.contentType,
		"Cache-Control": opts.cacheControl,
		"Accept-Ranges": "bytes",
	};
	if (opts.lastModified !== undefined) headers["Last-Modified"] = opts.lastModified;
	if (opts.download === true) headers["Content-Disposition"] = "attachment";
	let status = 200;
	let start = 0;
	let end = size - 1;
	const range = req.headers.range;
	if (typeof range === "string" && range.trim().length > 0) {
		const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
		if (m === null || (m[1].length === 0 && m[2].length === 0)) {
			serve416(res, size);
			return;
		}
		if (m[1].length === 0) {
			const n = Number(m[2]); // bytes=-N: the last N bytes
			start = Math.max(0, size - n);
			end = size - 1;
		} else {
			start = Number(m[1]);
			end = m[2].length === 0 ? size - 1 : Number(m[2]);
		}
		if (size === 0 || !Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
			serve416(res, size);
			return;
		}
		if (end > size - 1) end = size - 1;
		status = 206;
		headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
	}
	headers["Content-Length"] = size === 0 ? 0 : end - start + 1;
	res.writeHead(status, headers);
	if (req.method === "HEAD" || size === 0) {
		res.end();
		return;
	}
	const stream = createReadStream(abs, { start, end });
	stream.on("error", () => res.destroy());
	stream.pipe(res);
}

function serveDirHtml(res: ServerResponse, dir: string, entries: DirEntry[], isHead: boolean): void {
	const rows = entries
		.map((e) => {
			const suffix = e.type === "dir" ? "/" : "";
			const href = encodeURIComponent(e.name) + suffix;
			return `<li><a href="${href}">${escHtml(e.name)}${suffix}</a> <span class="m">${e.size} B</span></li>`;
		})
		.join("\n");
	const body = `<!doctype html><meta charset="utf-8"><title>${escHtml(dir)}</title>
<style>body{background:#111;color:#ddd;font:14px/1.6 ui-monospace,monospace;padding:1.5rem}a{color:#9cf;text-decoration:none}a:hover{text-decoration:underline}.m{color:#777}ul{list-style:none;padding:0}</style>
<h1>${escHtml(dir)}</h1><p class="m">${entries.length} entries</p><ul>
<li><a href="../">../</a></li>
${rows}
</ul>`;
	serveText(res, 200, "text/html; charset=utf-8", body, isHead);
}

/**
 * A8: the browser entry point for <host>:8789/serve. Dead paths are hidden (A9).
 * Unread inbox files are counted here so the page shows what the agent has not acked.
 */
function serveRegistry(res: ServerResponse, isHead: boolean): void {
	const entries = serveLiveEntries();
	const seen = readSeen();
	const rows = entries
		.map((e) => {
			const unread = inboxUnread(e, seen).length;
			const badge = unread > 0 ? ` <span class="u">inbox ${unread}</span>` : "";
			// #20: absolute href so the registry agrees with `serve list` and survives
			// being opened at a host other than the configured baseUrl.
			const href = `${serveBaseUrl()}${SERVE_PREFIX}/${encodeURIComponent(e.id)}/`;
			return `<li><a href="${escHtml(href)}">${escHtml(e.id)}</a> <span class="m">${escHtml(e.path)}</span>${badge}</li>`;
		})
		.join("\n");
	const body = `<!doctype html><meta charset="utf-8"><title>serve</title>
<style>body{background:#111;color:#ddd;font:14px/1.6 ui-monospace,monospace;padding:1.5rem}a{color:#9cf;text-decoration:none}a:hover{text-decoration:underline}.m{color:#777}.u{color:#fbbf24}ul{list-style:none;padding:0}</style>
<h1>serve</h1><p class="m">${entries.length} registered paths</p><ul>
${rows.length > 0 ? rows : '<li class="m">(none)</li>'}
</ul>`;
	serveText(res, 200, "text/html; charset=utf-8", body, isHead);
}

/**
 * POST /serve/<id>/_inbox/<name>. The path is parsed from the raw request target, not
 * from `new URL()`: WHATWG normalization eats a literal `..` before a handler can see
 * it, and a write path must be able to refuse traversal with a 400, not silently
 * rewrite it (A2). One level only; everything else is 403/400.
 */
function serveInbox(req: IncomingMessage, res: ServerResponse): void {
	const raw = (req.url ?? "").split("?")[0];
	const rest = raw.startsWith(SERVE_PREFIX) ? raw.slice(SERVE_PREFIX.length) : raw;
	const parts: string[] = [];
	try {
		for (const seg of rest.split("/")) {
			if (seg === "") continue;
			parts.push(decodeURIComponent(seg));
		}
	} catch {
		sendJson(res, 400, { ok: false, error: "bad path encoding" });
		req.resume();
		return;
	}
	if (parts.length < 2 || parts[1] !== INBOX) {
		sendJson(res, 403, { ok: false, error: `writes are only allowed under ${SERVE_PREFIX}/<id>/${INBOX}/<name>` });
		req.resume();
		return;
	}
	if (parts.length !== 3) {
		sendJson(res, 400, { ok: false, error: "name must be one path segment" });
		req.resume();
		return;
	}
	const lookup = serveLookup(parts[0] ?? "");
	if (lookup === null) {
		sendJson(res, 404, { ok: false, error: `no served path with id ${parts[0] ?? ""}` });
		req.resume();
		return;
	}
	if (lookup.expired) {
		sendJson(res, 410, { ok: false, error: "expired" });
		req.resume();
		return;
	}
	writeInbox(req, res, lookup.entry, parts[2] ?? "");
}

/**
 * B2: the lexical resolve catches `..`, then realpath catches a symlink that points
 * outside. Both must pass before a byte is read. Every request stats the disk (A2).
 */
function handleServe(req: IncomingMessage, res: ServerResponse, url: URL): void {
	const isHead = req.method === "HEAD";
	// #67: every /serve response refuses content sniffing, on every branch (file, dir
	// listing, registry, _inbox, errors). Set here so no branch can forget it.
	res.setHeader("X-Content-Type-Options", "nosniff");
	// #23: listing, file, Range and _inbox POST requests all arrive here with a Host
	// header; learn before the method checks so even a refused verb teaches the host.
	learnServeHostFromHeader(req.headers.host);
	// The only write direction: POST /serve/<id>/_inbox/<name>. Anything else on POST
	// (or any other verb) is refused before a byte is read.
	// #67: _inbox is the one write direction on /serve. #76: the refusal now happens in
	// handle() before dispatch, so this branch exists only to dispatch.
	if (req.method === "POST") {
		serveInbox(req, res);
		return;
	}
	if (req.method !== "GET" && !isHead) {
		res.setHeader("Allow", "GET, HEAD, POST");
		sendJson(res, 405, { ok: false, error: "method not allowed" });
		req.resume();
		return;
	}
	res.setHeader("Accept-Ranges", "bytes"); // B1: advertised on every /serve response

	const rest = url.pathname.slice(SERVE_PREFIX.length);
	if (rest === "" || rest === "/") {
		serveRegistry(res, isHead);
		return;
	}
	if (!rest.startsWith("/")) {
		sendJson(res, 404, { ok: false, error: "not found" });
		return;
	}
	const inner = rest.slice(1);
	const slash = inner.indexOf("/");
	const rawId = slash < 0 ? inner : inner.slice(0, slash);
	const rawRel = slash < 0 ? null : inner.slice(slash + 1);
	const trailingSlash = rawRel !== null && (rawRel === "" || rawRel.endsWith("/"));

	let id: string;
	const segments: string[] = [];
	try {
		id = decodeURIComponent(rawId);
		for (const part of (rawRel ?? "").split("/")) {
			if (part === "") continue; // trailing slash
			const d = decodeURIComponent(part);
			if (d.includes("/") || d.includes("\\") || d.includes("\0")) {
				sendJson(res, 403, { ok: false, error: "path traversal denied" });
				return;
			}
			segments.push(d);
		}
	} catch {
		sendJson(res, 400, { ok: false, error: "bad path encoding" });
		return;
	}
	if (id.length === 0 || id.includes("/") || id.includes("\\")) {
		sendJson(res, 400, { ok: false, error: "bad path" });
		return;
	}

	const lookup = serveLookup(id);
	if (lookup === null) {
		sendJson(res, 404, { ok: false, error: `no served path with id ${id}` });
		return;
	}
	if (lookup.expired) {
		// 墓石: 登録はあったが期限で消えた。404（無い）とは区別する。
		sendJson(res, 410, { ok: false, error: "expired" });
		return;
	}
	const entry = lookup.entry;
	let root: string;
	try {
		root = realpathSync(entry.path);
	} catch {
		sendJson(res, 404, { ok: false, error: "registered path is gone" });
		return;
	}
	const lexical = resolve(root, ...segments);
	if (!isUnder(lexical, [root])) {
		sendJson(res, 403, { ok: false, error: "path traversal denied" });
		return;
	}
	let target: string;
	try {
		target = realpathSync(lexical);
	} catch {
		sendJson(res, 404, { ok: false, error: "not found" });
		return;
	}
	if (!isUnder(target, [root])) {
		sendJson(res, 403, { ok: false, error: "path traversal denied" });
		return;
	}
	let st: Stats;
	try {
		st = statSync(target);
	} catch {
		sendJson(res, 404, { ok: false, error: "not found" });
		return;
	}

	if (st.isDirectory()) {
		if (!trailingSlash) {
			res.writeHead(301, { Location: `${url.pathname}/${url.search}`, "Cache-Control": "no-store" });
			res.end();
			return;
		}
		// A7b wins over index.html: a page must always be able to enumerate a directory.
		const wantJson = url.searchParams.get("list") === "json" || (req.headers.accept ?? "").includes("application/json");
		const entries = serveDirEntries(target);
		if (wantJson) {
			serveText(res, 200, "application/json; charset=utf-8", JSON.stringify(entries), isHead);
			return;
		}
		const indexPath = join(target, "index.html");
		let ist: Stats | null = null;
		try {
			ist = statSync(indexPath);
		} catch {
			// no index.html -> the generated listing (A7)
		}
		if (ist !== null && ist.isFile()) {
			serveFile(req, res, indexPath, ist, serveFileOpts(indexPath, ist));
			return;
		}
		serveDirHtml(res, target, entries, isHead);
		return;
	}
	if (!st.isFile()) {
		sendJson(res, 403, { ok: false, error: "not a regular file" });
		return;
	}
	serveFile(req, res, target, st, serveFileOpts(target, st));
}

/** /serve's MIME + B4 cache rules, kept in one place for both call sites. */
function serveFileOpts(abs: string, st: Stats): FileServeOpts {
	const raw = SERVE_MIME[serveExt(abs)] ?? "application/octet-stream";
	return {
		contentType: serveMimeOf(abs),
		cacheControl: serveCacheOf(abs),
		lastModified: new Date(st.mtimeMs).toUTCString(),
		// #67: only a *downgraded* type is attached — a plain .txt stays inline. The
		// downgrade alone is not enough anyway (text/plain is sniffable back into HTML);
		// attachment keeps the dashboard's <a target=_blank> a download, not a page.
		download: SERVE_ACTIVE_MIME.has(raw),
	};
}

function parseCol(value: string | null): Col | undefined {
	return value === "todo" || value === "doing" || value === "done" ? value : undefined;
}

/** A bare filename directly under MEDIA_DIR (no path traversal). */
function isSafeMediaName(name: string): boolean {
	return name.length > 0 && !name.includes("..") && !name.includes("/") && !name.includes("\\");
}

/** 8 hex chars. Math.random is fine here: names only need per-card uniqueness. */
function randHex8(): string {
	return Math.random().toString(16).slice(2, 10).padEnd(8, "0");
}

/** Write bytes as a card's media file; returns the stored filename, or null on failure. */
function writeMedia(cardId: number, ext: string, bytes: Buffer): string | null {
	const name = `${cardId}-${randHex8()}.${ext}`;
	try {
		mkdirSync(MEDIA_DIR, { recursive: true });
		writeFileSync(join(MEDIA_DIR, name), bytes);
	} catch {
		return null;
	}
	return name;
}

/** Best-effort delete of a card's media file. Missing file is not an error. */
function removeMedia(card: Card): void {
	if (!card.img || !isSafeMediaName(card.img)) return;
	try {
		unlinkSync(join(MEDIA_DIR, card.img));
	} catch {
		// already gone / not ours -> ignore
	}
}

function serveMedia(req: IncomingMessage, res: ServerResponse, rawName: string): void {
	let name: string;
	try {
		name = decodeURIComponent(rawName);
	} catch {
		sendJson(res, 400, { ok: false, error: "bad filename" });
		return;
	}
	if (!isSafeMediaName(name)) {
		sendJson(res, 400, { ok: false, error: "bad filename" });
		return;
	}
	const type = MIME_BY_EXT[name.slice(name.lastIndexOf(".") + 1).toLowerCase()];
	if (type === undefined) {
		sendJson(res, 415, { ok: false, error: "unsupported media type" });
		return;
	}
	const abs = join(MEDIA_DIR, name);
	let st: Stats;
	try {
		st = statSync(abs);
	} catch {
		sendJson(res, 404, { ok: false, error: "not found" });
		return;
	}
	if (!st.isFile()) {
		sendJson(res, 404, { ok: false, error: "not found" });
		return;
	}
	// Same byte-range core as /serve; media keeps its own MIME rule and no-store.
	serveFile(req, res, abs, st, { contentType: type, cacheControl: "no-store" });
}

/** Collect a raw request body up to `limit`. Calls done(null) after sending 413/400. */
function collectBody(
	req: IncomingMessage,
	res: ServerResponse,
	limit: number,
	done: (buf: Buffer | null) => void,
): void {
	const chunks: Buffer[] = [];
	let size = 0;
	let failed = false;
	req.on("data", (chunk: Buffer) => {
		if (failed) return;
		size += chunk.length;
		if (size > limit) {
			failed = true;
			sendJson(res, 413, { ok: false, error: `body too large (max ${fmtMB(limit)})` });
			req.resume();
			return;
		}
		chunks.push(chunk);
	});
	req.on("end", () => {
		if (!failed) done(Buffer.concat(chunks));
	});
	req.on("error", () => {
		if (failed) return;
		failed = true;
		sendJson(res, 400, { ok: false, error: "read error" });
	});
}

/** Explicit name > first user message > id prefix, for sessions we only see through SessionInfo. */
function labelOf(name: string | undefined, firstMessage: string | undefined, id: string): string {
	const n = (name ?? "").trim();
	if (n.length > 0) return n;
	const f = (firstMessage ?? "").trim();
	if (f.length > 0) return f.slice(0, 30);
	return id.slice(0, 8);
}

let sessionInfoCache: { at: number; byId: Map<string, SessionInfo> } | null = null;
const SESSION_INFO_TTL_MS = 30_000;

/** SessionManager.listAll() rescans every session file, so its result is kept briefly. */
async function sessionInfoById(): Promise<Map<string, SessionInfo>> {
	if (sessionInfoCache !== null && Date.now() - sessionInfoCache.at < SESSION_INFO_TTL_MS) {
		return sessionInfoCache.byId;
	}
	let byId = new Map<string, SessionInfo>();
	try {
		byId = new Map((await SessionManager.listAll()).map((s) => [s.id, s]));
	} catch {
		// unreadable session store -> labels fall back to the id prefix
	}
	sessionInfoCache = { at: Date.now(), byId };
	return byId;
}

type SessionRow = {
	id: string;
	name: string;
	cwd: string;
	mine: boolean;
	modified: number;
	counts: { todo: number; doing: number; done: number };
	modes: { session: ModePair; global: ModePair };
	// Why this session's doing-loop is stopped; null = running. Process memory, so it is
	// read from haltedBySid and not from any file (see the note at that map).
	halted: { halted: "limit" | "stuck"; stuckId: number | null; stuckCount: number; cap: number } | null;
	// The doing-loop count this session has used (process memory, same door as `halted`).
	loops: number;
	cards: Card[];
};

/** The per-column card counts every board view shows. */
function countCols(b: Board): { todo: number; doing: number; done: number } {
	return { todo: cardsIn(b, "todo").length, doing: cardsIn(b, "doing").length, done: cardsIn(b, "done").length };
}

/**
 * Every session board on disk (plus this session even before its first write).
 * The single source shared by GET /api/sessions and GET /api/dashboard — one scan,
 * two shapes.
 */
async function sessionRows(): Promise<{ activeSessionId: string | null; sessions: SessionRow[] }> {
	const info = await sessionInfoById();
	const f = readModesFile(); // per-row modes: another session's toggles are read-only here
	let names: string[] = [];
	try {
		names = readdirSync(SESSIONS_DIR);
	} catch {
		// no sessions dir yet -> nothing to list
	}
	const sessions: SessionRow[] = names
		.filter((n) => n.endsWith(".json"))
		.map((n) => {
			const id = n.slice(0, -5);
			const path = join(SESSIONS_DIR, n);
			const b = readBoard(path);
			const meta = info.get(id);
			let modified = 0;
			try {
				modified = statSync(path).mtimeMs;
			} catch {
				// deleted mid-scan -> sort it last
			}
			return {
				id,
				name: labelOf(meta?.name, meta?.firstMessage, id),
				cwd: meta?.cwd ?? "",
				// driver (auto-tick の駆動元) を示す。編集可否とは無関係。
				mine: id === activeSessionId,
				modified,
				counts: countCols(b),
				modes: { session: modesFor(f, id, "session"), global: modesFor(f, id, "global") },
				halted: haltedBySid.get(id) ?? null,
				loops: loopCountOf(id),
				cards: b.cards,
			};
		});
	// An untouched session has no file yet; show it anyway so its board is reachable.
	if (activeSessionId !== null && !sessions.some((s) => s.id === activeSessionId)) {
		const meta = info.get(activeSessionId);
		sessions.push({
			id: activeSessionId,
			name: labelOf(meta?.name, meta?.firstMessage, activeSessionId),
			cwd: meta?.cwd ?? "",
			// Not `driver`: this sid has no board file, so its pi may already be gone.
			// Listing it is enough; the ACTIVE badge would outlive the session.
			mine: false,
			modified: Date.now(),
			counts: { todo: 0, doing: 0, done: 0 },
			modes: {
				session: modesFor(f, activeSessionId, "session"),
				global: modesFor(f, activeSessionId, "global"),
			},
			halted: haltedBySid.get(activeSessionId) ?? null,
			loops: loopCountOf(activeSessionId),
			cards: [],
		});
	}
	sessions.sort((a, b) => Number(b.mine) - Number(a.mine) || b.modified - a.modified);
	return { activeSessionId, sessions };
}

/** GET /api/sessions: the board page's session picker. */
async function sendSessions(res: ServerResponse): Promise<void> {
	const { activeSessionId, sessions } = await sessionRows();
	sendJson(res, 200, { ok: true, activeSessionId, sessions });
}

/** Files directly under ~/.pi/kanban/media (the dashboard's `media` stat). */
function mediaFileCount(): number {
	try {
		return readdirSync(MEDIA_DIR, { withFileTypes: true }).filter((d) => d.isFile()).length;
	} catch {
		return 0;
	}
}

/** GET /api/dashboard: one request carrying everything the dashboard renders. */
async function dashboardPayload(): Promise<unknown> {
	const { sessions } = await sessionRows();
	const gb = readBoard(GLOBAL_JSON);
	const globalCounts = countCols(gb);
	// The GLOBAL board's switches live under scope=global, keyed by the active session.
	const f = readModesFile();
	// stats.todo/doing/done = GLOBAL plus every session board.
	const totals = { ...globalCounts };
	for (const s of sessions) {
		totals.todo += s.counts.todo;
		totals.doing += s.counts.doing;
		totals.done += s.counts.done;
	}
	// Dead registrations stay listed; `exists` is the flag that tells the UI.
	// 期限切れも残す: dashboard が「期限切れ」と出し、そこから解除できるようにする。
	const serve = readServeFile().map((e) => ({
		id: e.id,
		url: serveUrlFor(e),
		path: e.path,
		title: e.title ?? "",
		createdAt: e.createdAt ?? "",
		permanent: e.permanent === true,
		expiresAt: serveExpiresAtIso(e),
		exists: existsSync(e.path),
	}));
	return {
		host: learnedServeHost() ?? hostname(),
		// #66: identity, so the dashboard can name a stale server instead of rendering
		// whatever answers the port.
		version: SERVER_VERSION,
		startedAt: serverStartedAt,
		// #65: 分単位に丸める。クライアントの再描画 sig が毎ポーリングで変わり、編集中の
		// textarea を DOM ごと捨てていた（形は ISO 文字列のまま。相対時刻の粒度は 1 分）。
		// #74: クライアントはもうこの値を描画に使わない（sigOf が除外する）。API の形と
		// この丸めはそのまま（他が読んでいる。消すと毎ポーリングで sig が変わる）。
		now: new Date(Math.floor(Date.now() / 60000) * 60000).toISOString(),
		// #40: which session's ctx drives auto-tick. Read-only on purpose: switching is
		// `/kanban take` only, so the dashboard has no write path to race.
		driver: activeSessionId,
		stats: {
			sessions: sessions.length,
			active: sessions.filter((s) => s.mine).length,
			todo: totals.todo,
			doing: totals.doing,
			done: totals.done,
			serve: serve.length,
			media: mediaFileCount(),
		},
		global: { counts: globalCounts, cards: gb.cards, modes: modesFor(f, activeSessionId ?? "", "global") },
		sessions: sessions.map((s) => ({
			id: s.id,
			name: s.name, // raw on purpose: the dashboard sets it with textContent
			cwd: s.cwd,
			isActive: s.mine, // driver か。もう書き込みロックの印ではない
			updatedAt: new Date(s.modified).toISOString(),
			modes: s.modes,
			counts: s.counts,
			cards: s.cards,
			// null = running. The loop state is process memory, which this module shares;
			// the GUI's ON/OFF toggle only writes modes.json and cannot clear it.
			halted: s.halted,
			// #67: the doing-loop count this session has used. The cap rides on `modes`;
			// the dashboard draws 「残り N / 上限」 from the two.
			loops: loopCountOf(s.id),
		})),
		serve,
	};
}

/**
 * Board file for a write. Any session's board is writable: the caller names it with sid.
 * A concurrent write from that session's own pi can still overwrite us, but that is the
 * same condition GLOBAL writes already accept — so it is not a reason to refuse here.
 */
function writeBoardPath(q: URLSearchParams): string | null {
	if (parseScope(q.get("scope")) === "global") return GLOBAL_JSON;
	const sid = q.get("sid");
	if (sid === null || sid === "") return null; // sid required: no activeSession fallback
	return boardPath("session", sid);
}

/** The session credited for a move made through the HTTP API. */
function actorOf(q: URLSearchParams): string {
	const sid = q.get("sid");
	// Session writes already required sid in writeBoardPath; only scope=global can reach
	// here without one, and there the active session is the attribution.
	if (sid !== null && sid !== "") return sid;
	return activeSessionId ?? "";
}

/** POST /api/upload?scope=&sid=&id=&col=&ext= : raw body -> media file (+ new card when id is omitted). */
function handleUpload(req: IncomingMessage, res: ServerResponse, q: URLSearchParams): void {
	const ext = (q.get("ext") ?? "").toLowerCase();
	if (!OK_EXTS.includes(ext)) {
		sendJson(res, 415, { ok: false, error: `ext must be ${OK_EXTS.join("|")}` });
		req.resume();
		return;
	}
	const path = writeBoardPath(q);
	if (path === null) {
		sendJson(res, 400, { ok: false, error: "scope=session requires sid" });
		req.resume();
		return;
	}
	collectBody(req, res, uploadLimitOf(ext), (buf) => {
		if (buf === null) return; // 413/400 already sent
		const b = readBoard(path);
		const idParam = q.get("id");
		let card: Card;
		if (idParam === null) {
			card = { id: b.nextId++, text: "", col: parseCol(q.get("col")) ?? "todo" };
			stampMove(card, actorOf(q));
			card.text = `#${card.id} (${MIME_BY_EXT[ext].startsWith("video/") ? "video" : "image"})`;
			b.cards.push(card);
		} else {
			const found = b.cards.find((c) => c.id === Number(idParam));
			if (found === undefined) {
				sendJson(res, 404, { ok: false, error: `no card with id ${idParam}` });
				return;
			}
			removeMedia(found); // replacing media drops the old file
			card = found;
		}
		const name = writeMedia(card.id, ext, buf);
		if (name === null) {
			sendJson(res, 500, { ok: false, error: "media write failed" });
			return;
		}
		card.img = name;
		writeBoard(path, b);
		sendJson(res, 200, { ok: true, card });
	});
}

const MEDIA_PREFIX = "/api/media/";

// ---------------------------------------------------------------------------
// #38-1 selftest: name the layer that is broken instead of guessing
// ---------------------------------------------------------------------------

type SelfTestCheck = { name: string; ok: boolean; detail: string };
// #66: display-only. `pid` is never fed to process.kill(): any listener on 127.0.0.1
// could claim any pid, and this API has no auth.
type SelfTestIdentity = { version: string; startedAt: number; pid: number };

/** One row: run the probe, keep the thrown message as the detail when it fails. */
function selfTestLayer(name: string, probe: () => string): SelfTestCheck {
	try {
		return { name, ok: true, detail: probe() };
	} catch (err) {
		return { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * The four layers every other route depends on: board files, modes.json, the serve
 * registry and media/. Each probe parses the real file (rather than going through the
 * forgiving readers, which turn a corrupt file into an empty board and hide the cause).
 */
/**
 * #66: identity of the process behind the port. `pid` is display-only - nothing may
 * signal a probed pid (any listener on 127.0.0.1 could claim one).
 */
function serverIdentity(): SelfTestIdentity {
	return { version: SERVER_VERSION, startedAt: serverStartedAt, pid: process.pid };
}

function runSelfTest(): { ok: boolean; checks: SelfTestCheck[]; identity: SelfTestIdentity } {
	const checks = [
		selfTestLayer("board", () => {
			const paths = [GLOBAL_JSON, activeSessionId === null ? null : boardPath("session", activeSessionId)];
			let seen = 0;
			for (const p of paths) {
				if (p === null || !existsSync(p)) continue;
				const raw = JSON.parse(readFileSync(p, "utf8")) as Board;
				if (!raw || !Array.isArray(raw.cards)) throw new Error(`cards is not an array: ${p}`);
				seen += 1;
			}
			// #66-security: the session id is a secret-free capability for this board; a
			// unauthenticated selftest must not leak it. The count is enough to debug.
			return `session=${activeSessionId === null ? "none" : "active"} board files=${seen}`;
		}),
		selfTestLayer("modes", () => {
			if (existsSync(MODES_JSON)) JSON.parse(readFileSync(MODES_JSON, "utf8"));
			return existsSync(MODES_JSON) ? MODES_JSON : "missing (defaults: both ON)";
		}),
		selfTestLayer("serve", () => {
			if (existsSync(SERVE_JSON)) JSON.parse(readFileSync(SERVE_JSON, "utf8"));
			return `${readServeFile().length} entr(ies)`;
		}),
		selfTestLayer("media", () => {
			mkdirSync(MEDIA_DIR, { recursive: true });
			// A real write: mkdir succeeding on a read-only mount is not proof.
			const probe = join(MEDIA_DIR, `.selftest-${process.pid}`);
			writeFileSync(probe, "");
			unlinkSync(probe);
			return `${MEDIA_DIR} (${readdirSync(MEDIA_DIR).length} file(s))`;
		}),
	];
	return { ok: checks.every((c) => c.ok), checks, identity: serverIdentity() };
}


/**
 * #38-14: `?fields=id,col,text` projects each card down to those keys. No fields =
 * the exact old payload, so the GUI and every existing caller stay untouched.
 */
const CARD_FIELDS = [
	"id",
	"text",
	"col",
	"img",
	"movedAt",
	"movedBy",
	"priority",
	"nextFireAt",
	"blocked",
	"firedFor",
] as const;

function projectBoard(b: Board, keys: string[]): Board {
	const keep = keys.filter((k): k is (typeof CARD_FIELDS)[number] =>
		(CARD_FIELDS as readonly string[]).includes(k),
	);
	if (keep.length === 0) return b;
	const cards = b.cards.map((c) => {
		const out: Record<string, unknown> = {};
		for (const k of keep) {
			const v = (c as Record<string, unknown>)[k];
			if (v !== undefined) out[k] = v;
		}
		return out as unknown as Card;
	});
	return { cards, nextId: b.nextId };
}


function handle(req: IncomingMessage, res: ServerResponse): void {
	// #76: the allow-origin value is per-caller now, so it is decided here rather than in a
	// module constant. Vary: Origin rides along or a shared cache serves one caller's answer
	// to another.
	const cors = corsHeaders(req);
	for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);

	const url = new URL(req.url ?? "/", "http://127.0.0.1");

	// #76: the gate sits before dispatch and covers the whole write surface, verb-independently.
	// It used to guard only POST /api/host and POST /serve/**/_inbox, which left the eleven
	// GET+query state changes reachable from any page.
	if (isWritePath(url.pathname, req.method ?? "GET")) {
		const refusal = crossOriginWriteRefusal(req);
		if (refusal !== null) {
			sendJson(res, 403, { ok: false, error: refusal });
			req.resume();
			return;
		}
	}

	if (req.method === "OPTIONS") {
		// #76: preflight answers on the same rule as everything else, so a cross-origin page
		// is told nothing it could use. Unconditional 204 used to advertise the API to any
		// page on the machine.
		if (crossOriginWriteRefusal(req) !== null) {
			res.writeHead(403);
			res.end();
			return;
		}
		res.writeHead(204);
		res.end();
		return;
	}

	const q = url.searchParams;

	// Path-based route: switch() cannot match it.
	if (url.pathname.startsWith(MEDIA_PREFIX)) {
		if (req.method !== "GET" && req.method !== "HEAD") {
			sendJson(res, 405, { ok: false, error: "method not allowed" });
			req.resume();
			return;
		}
		serveMedia(req, res, url.pathname.slice(MEDIA_PREFIX.length));
		return;
	}
	// Local path serving rides the same server (A11); GET/HEAD only, handled inside.
	if (url.pathname === SERVE_PREFIX || url.pathname.startsWith(`${SERVE_PREFIX}/`)) {
		handleServe(req, res, url);
		return;
	}
	if (req.method === "POST") {
		if (url.pathname === "/api/host") {
			// #76: the gate above already refused a cross-origin page here; this branch only
			// has to dispatch.
			handleHostReport(req, res);
			return;
		}
		// #38-1 self-diagnosis: POST-only, so it cannot be hit by a page prefetch.
		if (url.pathname === "/api/selftest") {
			const report = runSelfTest();
			sendJson(res, report.ok ? 200 : 503, report);
			return;
		}
		if (url.pathname !== "/api/upload") {
			sendJson(res, 405, { ok: false, error: "method not allowed" });
			req.resume();
			return;
		}
		handleUpload(req, res, q);
		return;
	}
	if (req.method !== "GET") {
		sendJson(res, 405, { ok: false, error: "method not allowed" });
		req.resume();
		return;
	}

	// ブラウザは毎ロード /favicon.ico を取りに来る。持っていないので 204（本文なし）。
	if (url.pathname === "/favicon.ico") {
		res.writeHead(204);
		res.end();
		return;
	}

	const colParam = q.get("col");
	const idParam = q.get("id");

	// Read-only routes first: they resolve the session themselves.
	if (url.pathname === "/") {
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(DASHBOARD_HTML);
		return;
	}
	if (url.pathname === "/api/dashboard") {
		void dashboardPayload().then(
			(body) => sendJson(res, 200, body),
			() => sendJson(res, 500, { ok: false, error: "dashboard failed" }),
		);
		return;
	}
	if (url.pathname === "/api/kanban") {
		// #67: no activeSessionId fallback for the session board — that let another session's
		// board be read with no sid at all. Same rule as writeBoardPath: an explicit
		// scope=session demands a sid, scope=global reads GLOBAL with no sid. A bare call
		// (no scope) stays a 200 global-only read: it is the readiness probe every caller
		// and test uses, and sid===null already means "no session board", never someone else's.
		const sidRaw = q.get("sid");
		const sid = sidRaw === null || sidRaw === "" ? null : sidRaw;
		if (q.get("scope") === "session" && sid === null) {
			sendJson(res, 400, { ok: false, error: "scope=session requires sid" });
			return;
		}
		const f = readModesFile();
		// #38-14: absent fields = the unchanged payload; present = cards are projected.
		const fieldsRaw = q.get("fields");
		const keys = fieldsRaw === null ? null : fieldsRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
		const global = readBoard(GLOBAL_JSON);
		const session = sid === null ? { cards: [], nextId: 1 } : readBoard(boardPath("session", sid));
		sendJson(res, 200, {
			ok: true,
			sessionId: sid,
			global: keys === null ? global : projectBoard(global, keys),
			session: keys === null ? session : projectBoard(session, keys),
			// GLOBAL mode is keyed by session: the panel shows THIS session's switches.
			modes: {
				session: modesFor(f, sid ?? "", "session"),
				global: modesFor(f, activeSessionId ?? "", "global"),
			},
		});
		return;
	}
	if (url.pathname === "/api/sessions") {
		void sendSessions(res).catch(() =>
			sendJson(res, 500, { ok: false, error: "session list failed" }),
		);
		return;
	}
	if (url.pathname === "/api/serve") {
		// Serve registry is not board-scoped: no sid. There is no per-entry process to
		// stop, so "停止" is deregistration (the shared server keeps running and
		// /serve/<id>/ starts 404ing). Deleting the file is NOT an HTTP action.
		const id = q.get("id");
		const action = q.get("action");
		if (id === null || id === "") {
			sendJson(res, 400, { ok: false, error: "id is required" });
			return;
		}
		if (action === "permanent") {
			// 永久トグル: value=1 -> 無期限、それ以外 -> 既定 7 日期限に戻す。
			const entry = serveSetPermanent(id, q.get("value") === "1");
			if (entry === null) {
				sendJson(res, 404, { ok: false, error: "not registered" });
				return;
			}
			sendJson(res, 200, { ok: true, id: entry.id, permanent: entry.permanent === true });
			return;
		}
		if (action !== "remove") {
			sendJson(res, 400, { ok: false, error: "action=remove or action=permanent and id are required" });
			return;
		}
		const removed = serveRemove(id);
		if (removed === null) {
			sendJson(res, 404, { ok: false, error: "not registered" });
			return;
		}
		// #66-security: a served file is never deleted over HTTP. `del=1` used to unlink
		// the target, i.e. any <img src> on any page could delete a file. Deregistration
		// is all the dashboard may do; deleting is a local filesystem action.
		sendJson(res, 200, { ok: true, id: removed.id });
		return;
	}

	// #71/#011: /api/maxloops dispatches before the board gate below — that gate answers
	// "scope=session requires sid" for anything it cannot name a board file for, which hid
	// the scope rule (scope=foo reported the session wording). Its own rules live in
	// maxLoopsRequest, so the wording and the branch can only agree.
	if (url.pathname === "/api/maxloops") {
		const plan = maxLoopsRequest({ scope: q.get("scope"), sid: q.get("sid"), n: q.get("n") });
		if (plan.kind === "error") {
			sendJson(res, 400, { ok: false, error: plan.error });
			return;
		}
		const { scope, sid } = plan;
		const n = plan.n;
		if (!isValidMaxLoops(n)) {
			sendJson(res, 400, { ok: false, error: `n must be an integer 0..${MAX_LOOPS_CAP} (0 = unlimited)` });
			return;
		}
		const f = readModesFile();
		if (scope === "session") ensureSessionBoard(sid);
		setMaxLoops(f, sid, scope, n);
		writeModesFile(f);
		sendJson(res, 200, {
			ok: true,
			modes: { session: modesFor(f, sid, "session"), global: modesFor(f, sid, "global") },
		});
		return;
	}

	// #84: the right-panel template was retired, so its 404 guard went with it. A stale
	// caller now falls through to the board gate's sid 400 — still "no such document"
	// for the #83 probe, which only needs "not served".

	const path = writeBoardPath(q);
	if (path === null) {
		sendJson(res, 400, { ok: false, error: "scope=session requires sid" });
		return;
	}
	const b = readBoard(path);

	switch (url.pathname) {
		case "/api/add": {
			const text = (q.get("text") ?? "").trim();
			if (text.length === 0) {
				sendJson(res, 400, { ok: false, error: "text required" });
				return;
			}
			const col = parseCol(colParam) ?? "todo";
			const card: Card = { id: b.nextId++, text, col };
			stampMove(card, actorOf(q));
			b.cards.push(card);
			writeBoard(path, b);
			sendJson(res, 200, { ok: true, cards: b.cards });
			return;
		}
		case "/api/move": {
			const col = parseCol(colParam);
			if (col === undefined) {
				sendJson(res, 400, { ok: false, error: "col must be todo|doing|done" });
				return;
			}
			const card = b.cards.find((c) => c.id === Number(idParam));
			if (!card) {
				sendJson(res, 404, { ok: false, error: `no card with id ${idParam}` });
				return;
			}
			card.col = col;
			stampMove(card, actorOf(q));
			writeBoard(path, b);
			sendJson(res, 200, { ok: true, cards: b.cards });
			return;
		}
		case "/api/remove": {
			const id = Number(idParam);
			const card = b.cards.find((c) => c.id === id);
			if (!card) {
				sendJson(res, 404, { ok: false, error: `no card with id ${idParam}` });
				return;
			}
			removeMedia(card);
			b.cards = b.cards.filter((c) => c.id !== id);
			writeBoard(path, b);
			sendJson(res, 200, { ok: true, cards: b.cards });
			return;
		}
		case "/api/rename": {
			const text = (q.get("text") ?? "").trim();
			const card = b.cards.find((c) => c.id === Number(idParam));
			if (!card || text.length === 0) {
				sendJson(res, 400, { ok: false, error: "id and text required" });
				return;
			}
			card.text = text;
			writeBoard(path, b);
			sendJson(res, 200, { ok: true, cards: b.cards });
			return;
		}
		case "/api/modes": {
			// scope=global may omit sid (it falls back to the driver); a session write must
			// name one. Any sid is accepted — there is no per-session write lock.
			// #67: the fallback stays on purpose. A global switch is *keyed* by session, and
			// the dashboard writes the global panel without a sid, so demanding one here
			// would only break the UI; nothing is read from another session by it.
			const sid = q.get("sid") ?? (parseScope(q.get("scope")) === "global" ? activeSessionId : null);
			if (sid === null || sid === "") {
				sendJson(res, 400, { ok: false, error: "scope=session requires sid" });
				return;
			}
			const key = q.get("key");
			if (key !== "doingLoop" && key !== "autoPick") {
				sendJson(res, 400, { ok: false, error: "key must be doingLoop or autoPick" });
				return;
			}
			const value = q.get("value");
			if (value !== "on" && value !== "off") {
				sendJson(res, 400, { ok: false, error: "value must be on or off" });
				return;
			}
			const scope = parseScope(q.get("scope"));
			const f = readModesFile();
			// modes entry <=> board file, same invariant as runModeCommand.
			if (scope === "session") ensureSessionBoard(sid);
			setMode(f, sid, scope, key, value === "on");
			writeModesFile(f);
			sendJson(res, 200, {
				ok: true,
				modes: { session: modesFor(f, sid, "session"), global: modesFor(f, sid, "global") },
			});
			return;
		}
		case "/api/interval": {
			// Same sid rule as every other write (writeBoardPath above); names only the interval.
			const sid = q.get("sid") ?? (parseScope(q.get("scope")) === "global" ? activeSessionId : null);
			if (sid === null || sid === "") {
				sendJson(res, 400, { ok: false, error: "scope=session requires sid" });
				return;
			}
			const minutes = Number(q.get("min"));
			if (!Number.isFinite(minutes) || minutes <= 0) {
				sendJson(res, 400, { ok: false, error: "min must be a positive number" });
				return;
			}
			const scope = parseScope(q.get("scope"));
			const f = readModesFile();
			if (scope === "session") ensureSessionBoard(sid);
			setIntervalMin(f, sid, scope, minutes);
			writeModesFile(f);
			sendJson(res, 200, {
				ok: true,
				modes: { session: modesFor(f, sid, "session"), global: modesFor(f, sid, "global") },
			});
			return;
		}
		case "/api/stuck": {
			// Same sid rule and naming as /api/interval; n is a settle COUNT, not minutes.
			const sid = q.get("sid") ?? (parseScope(q.get("scope")) === "global" ? activeSessionId : null);
			if (sid === null || sid === "") {
				sendJson(res, 400, { ok: false, error: "scope=session requires sid" });
				return;
			}
			const n = Number(q.get("n"));
			if (!isValidStuckLimit(n)) {
				sendJson(res, 400, { ok: false, error: `n must be an integer 1..${MAX_STUCK_LIMIT}` });
				return;
			}
			const scope = parseScope(q.get("scope"));
			const f = readModesFile();
			if (scope === "session") ensureSessionBoard(sid);
			setStuckLimit(f, sid, scope, n);
			writeModesFile(f);
			sendJson(res, 200, {
				ok: true,
				modes: { session: modesFor(f, sid, "session"), global: modesFor(f, sid, "global") },
			});
			return;
		}
		case "/api/resume": {
			// #67: ダッシュボードの「再開」。(sid,scope) は他の書き込みと同じで、実際の書き換えは
			// そのセッションの poll が行う（halt はサーバではなく拡張プロセスのメモリ）。
			// ここは 202 で受けるだけ: 見つからないときは 404 を返さない
			// （セッションはいるが今は止まっていない、が普通なので）。
			const sid = q.get("sid") ?? (parseScope(q.get("scope")) === "global" ? activeSessionId : null);
			if (sid === null || sid === "") {
				sendJson(res, 400, { ok: false, error: "scope=session requires sid" });
				return;
			}
			// One counter of outstanding requests: a stuck consumer must not grow the map.
			const pending = (resumeRequests.get(sid) ?? 0) + 1;
			resumeRequests.set(sid, Math.min(pending, 5));
			sendJson(res, 202, { ok: true, queued: true, sid });
			return;
		}
		case "/api/priority": {
			// Same sid rule and naming as /api/stuck; n is a card's autoPick priority (not minutes).
			const sid = q.get("sid") ?? (parseScope(q.get("scope")) === "global" ? activeSessionId : null);
			if (sid === null || sid === "") {
				sendJson(res, 400, { ok: false, error: "scope=session requires sid" });
				return;
			}
			const n = Number(q.get("n"));
			if (!isValidPriority(n)) {
				sendJson(res, 400, { ok: false, error: `n must be an integer ${MIN_PRIORITY}..${MAX_PRIORITY}` });
				return;
			}
			const card = b.cards.find((c) => c.id === Number(idParam));
			if (!card) {
				sendJson(res, 404, { ok: false, error: `no card with id ${idParam}` });
				return;
			}
			// 0 is the default: store nothing rather than an explicit 0.
			if (n === 0) delete card.priority;
			else card.priority = n;
			writeBoard(path, b);
			sendJson(res, 200, { ok: true, cards: b.cards });
			return;
		}
		case "/api/schedule": {
			// Same GET+query write path (and sid rule) as every other card edit.
			// Nothing to set = a caller typo; 400 instead of a silent no-op write.
			if (q.get("at") === null && q.get("blocked") === null) {
				sendJson(res, 400, { ok: false, error: "at or blocked is required" });
				return;
			}
			const card = b.cards.find((c) => c.id === Number(idParam));
			if (!card) {
				sendJson(res, 404, { ok: false, error: `no card with id ${idParam}` });
				return;
			}
			const at = q.get("at");
			if (at !== null) {
				const iso = normalizeFireAt(at);
				// Non-empty but unparseable is a user mistake, not a clear.
				if (iso === null && at.trim().length > 0) {
					sendJson(res, 400, { ok: false, error: "at must be ISO 8601 or +Nm/+Nh/+Nd" });
					return;
				}
				if (iso === null) {
					delete card.nextFireAt;
					delete card.firedFor;
				} else card.nextFireAt = iso;
			}
			const blocked = q.get("blocked");
			if (blocked !== null) {
				const t = blocked.trim();
				if (t.length === 0) delete card.blocked;
				else card.blocked = t;
			}
			writeBoard(path, b);
			sendJson(res, 200, { ok: true, cards: b.cards });
			return;
		}
		default:
			sendJson(res, 404, { ok: false, error: "not found" });
	}
}

/** Server log file. One `tail` shows the whole story. */
function logServer(line: string): void {
	process.stderr.write(`kanban: ${line}\n`);
	try {
		mkdirSync(KANBAN_DIR, { recursive: true });
		appendFileSync(SERVER_LOG, `[${new Date().toISOString()}] kanban: ${line}\n`);
	} catch {
		// logging must never take the extension down with it
	}
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * #66: what the process on our port says about itself. Reading the identity is what
 * separates "our sibling pi" (reuse) from "an old kanban left running" (stale).
 * `startedAt`/`pid` are display-only: nothing here ever signal()s a probed pid.
 */
type Probe = {
	reachable: boolean;
	version?: string;
	pid?: number;
	startedAt?: number;
	servesDashboard?: boolean;
	// #83b: generation fingerprints. `servesDashboard` alone is not enough - a kanban
	// from before #67 answers `/api/kanban` and `/api/kanban.html` and 404s `/` and
	// `/api/dashboard`, which is the exact shape that made the old probe say "not a kanban".
	servesBoard?: boolean;
	servesLegacyPanel?: boolean;
};

/** 200 + a JSON object, or null. One helper for every fingerprint below. */
async function probeJson(path: string): Promise<Record<string, unknown> | null> {
	try {
		const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { signal: AbortSignal.timeout(1500) });
		if (r.status !== 200) return null;
		const body: unknown = await r.json();
		return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** #83: does the listener on PORT answer /api/dashboard with JSON? Current-gen kanban only. */
async function servesDashboard(): Promise<boolean> {
	return (await probeJson("/api/dashboard")) !== null;
}

/** #83b: `/api/kanban` is the fingerprint every generation keeps. `sessionId` is null on a
 * bare read, so its PRESENCE (plus ok:true) is the test - never cards/modes/stats, which
 * differ between generations. */
async function servesBoard(): Promise<boolean> {
	const body = await probeJson("/api/kanban");
	return body !== null && body.ok === true && "sessionId" in body;
}

/** #83b: `/api/kanban.html` is served only before #67 (the pi-web split deleted it). */
async function servesLegacyPanel(): Promise<boolean> {
	try {
		const r = await fetch(`http://127.0.0.1:${PORT}/api/kanban.html`, { signal: AbortSignal.timeout(1500) });
		return r.status === 200 && (r.headers.get("content-type") ?? "").includes("text/html");
	} catch {
		return false;
	}
}

/**
 * Ask whatever answers PORT who it is. A /api/selftest that 404s (or has no identity)
 * is an older build: reachable, version unknown. Only a non-404 answer with a readable
 * body proves *this* API is behind the port, so an unrelated listener is not reused.
 */
async function probeServer(): Promise<Probe> {
	let res: Response;
	try {
		res = await fetch(`http://127.0.0.1:${PORT}/api/selftest`, {
			method: "POST",
			signal: AbortSignal.timeout(1500),
		});
	} catch {
		return { reachable: false };
	}
	// #83: pre-#66 kanban - no identity. One more question tells an old kanban from a
	// listener that has nothing to do with us, which is the difference between
	// "kill pid X" and "find out what owns this port".
	if (res.status === 404) {
		const [dash, board, legacy] = await Promise.all([servesDashboard(), servesBoard(), servesLegacyPanel()]);
		return { reachable: true, servesDashboard: dash, servesBoard: board, servesLegacyPanel: legacy };
	}
	try {
		const body = (await res.json()) as { identity?: { version?: unknown; pid?: unknown; startedAt?: unknown } };
		const id = body.identity;
		if (id === undefined) return { reachable: false }; // answered, but not our API
		return {
			reachable: true,
			...(typeof id.version === "string" ? { version: id.version } : {}),
			...(typeof id.pid === "number" ? { pid: id.pid } : {}),
			...(typeof id.startedAt === "number" ? { startedAt: id.startedAt } : {}),
		};
	} catch {
		return { reachable: false };
	}
}

/**
 * Start the shared server once. Later sessions (server non-null) reuse it.
 * #64: the guard is the state itself. There is no one-shot flag, so a bind that failed
 * earlier can still be retried, and a "stale" server keeps looking for the port to free up.
 */
function ensureServer(): void {
	if (server !== null || apiStarting) return;
	// "up" means our own server or a same-version sibling; either way, nothing to do.
	if (apiState === "up") return;
	// A bind error is permanent until the config changes - retrying would only log noise.
	if (apiState === "fatal") return;
	if (staleRetryTimer !== null) return; // a stale retry is already queued
	apiStarting = true;
	if (server === null && serverStartedAt === 0) {
		// Startup work belongs to a real attempt, not to a retry that may never run.
		migrateLegacyBoard();
		sweepSessions();
		sweepServe(); // 起動時に一度。以降は poll が 1 時間 throttle で回す。
		lastServeSweep = Date.now();
		writeBoardHtml();
	}
	void startListening();
}

/**
 * Bind PORT, retrying a few times: the port can be busy for a second while a
 * test process exits. Never swallow the failure - log it, and if nothing
 * answers the API afterwards mark it down so the footer says "API DOWN".
 * #64: apiStarting is released in a finally - an exception must not brick the server.
 */
async function startListening(): Promise<void> {
	try {
		await listenLoop();
	} finally {
		apiStarting = false;
		redrawFooter();
	}
}

async function listenLoop(): Promise<void> {
	for (let attempt = 1; attempt <= LISTEN_ATTEMPTS; attempt++) {
		const s = createServer(handle);
		try {
			await new Promise<void>((resolve, reject) => {
				s.once("error", reject);
				s.listen(PORT, HOST, () => {
					s.off("error", reject);
					resolve();
				});
			});
		} catch (err) {
			s.close();
			const e = err as NodeJS.ErrnoException;
			// #66: a permission error is not a race - another 3 attempts cannot fix it.
			// 8789 is baked into the right panel and the serve URLs, so we never move ports.
			if (e.code === "EACCES" || e.code === "EPERM") {
				apiState = "fatal";
				logServer(
					`listen failed on ${HOST}:${PORT}: ${e.code}. Port may be in a Windows excluded range. Run: netsh int ipv4 show excludedportrange protocol=tcp`,
				);
				return;
			}
			// Another pi already holds the port: retrying only buys 3 more EADDRINUSE
			// lines per subagent start. Fall through to the reuse probe below instead.
			if (e.code === "EADDRINUSE") {
				const p = await probeServer();
				if (p.reachable) {
					await decideReuse(p);
					return;
				}
			}
			logServer(
				`listen attempt ${attempt}/${LISTEN_ATTEMPTS} failed on ${HOST}:${PORT}: ${e.code ?? "error"} ${e.message}`,
			);
			if (attempt < LISTEN_ATTEMPTS) await sleep(LISTEN_RETRY_MS * attempt);
			continue;
		}
		server = s;
		serverStartedAt = Date.now();
		// Errors after a successful bind have no promise to reject into.
		s.on("error", (err: NodeJS.ErrnoException) => {
			apiState = "down";
			logServer(`runtime error on ${HOST}:${PORT}: ${err.code ?? "error"} ${err.message}`);
			redrawFooter();
		});
		apiState = "up";
		logServer(`listening on ${HOST}:${PORT} (attempt ${attempt})`);
		return;
	}
	// Every attempt failed without a usable probe answer. If something still answers
	// the API the board is reachable, so this is not an outage; otherwise say so.
	const p = await probeServer();
	if (p.reachable) {
		await decideReuse(p);
		return;
	}
	apiState = "down";
	// #83: the port is taken by something that never answers our API. The two commands
	// below separate "another process", "Windows reserved the range" and "stale handle".
	// One line each - server.log has room, the footer stays the one-word API DOWN.
	logServer(`API DOWN: no listener on ${HOST}:${PORT} after ${LISTEN_ATTEMPTS} attempts`);
	logServer(
		`${PORT} diagnostics: another process? ${portOwnerHint(PORT)}`,
	);
	logServer(
		`${PORT} diagnostics: reserved range (Hyper-V/WSL2)? netsh int ipv4 show excludedportrange protocol=tcp`,
	);
}

/** #83b: the one command that names the process on PORT, for THIS platform. Both OS forms
 * are named because the pi that logs may not be the machine holding the port (remote). */
function portOwnerHint(port: number): string {
	const win = `netstat -ano | findstr :${port}`;
	const nix = `ss -tlnp | grep ${port}`;
	return process.platform === "win32" ? `${win} (Windows) or ${nix} (Linux)` : `${nix} (Linux) or ${win} (Windows)`;
}

/**
 * #66: reuse only a server of OUR version. Anything else is an old process squatting
 * on the port - reusing it means the dashboard silently talks to stale code.
 */
async function decideReuse(p: Probe): Promise<void> {
	if (p.version === SERVER_VERSION) {
		apiState = "up";
		if (p.startedAt !== undefined && p.pid !== undefined) {
			logServer(`${HOST}:${PORT} already served by another process (v${p.version}, pid ${p.pid}); reusing it`);
		} else {
			logServer(`${HOST}:${PORT} already served by another process (v${p.version}); reusing it`);
		}
		return;
	}
	apiState = "stale";
	// #83: say WHICH process to kill - a pid-less "restart the owning pi" is useless
	// when the owner is an unrelated window on another desktop.
	const owner =
		p.pid === undefined
			? "pid unknown (pre-#66 kanban reports no pid)"
			: `pid ${p.pid}${p.startedAt === undefined ? "" : ` (started ${new Date(p.startedAt).toISOString()})`}`;
	logServer(
		`refusing to reuse stale server: expected v${SERVER_VERSION}, got v${p.version ?? "unknown"}, ${owner}.`,
	);
	if (p.version === undefined) {
		// #83b: name the generation. `servesDashboard` alone called a pre-#67 kanban
		// "not a kanban" - it answers /api/kanban and /api/kanban.html but not /api/dashboard.
		const isKanban = p.servesBoard === true || p.servesDashboard === true || p.servesLegacyPanel === true;
		if (!isKanban) {
			logServer(
				`${HOST}:${PORT} is held by something that is not a kanban (no /api/selftest, /api/kanban, /api/dashboard).`,
			);
			logServer(`find it: ${portOwnerHint(PORT)}; or start pi with KANBAN_PORT=8790.`);
		} else if (p.servesLegacyPanel === true && p.servesDashboard !== true) {
			// Pre-#67: the extension loaded in that pi-web is the old code. Restarting pi-web
			// is the ONLY fix, and the port holder is pi-web itself - killing it is not a fix.
			const who =
				p.pid === undefined
					? "the port holder is pi-web itself"
					: `the port holder is pi-web itself, pid ${p.pid}${p.startedAt === undefined ? "" : ` (started ${new Date(p.startedAt).toISOString()})`}`;
			logServer(`${HOST}:${PORT} is held by an old kanban (pre-#67): /api/kanban.html answers, dashboard does not.`);
			logServer('so the dashboard shows {"ok":false,"error":"not found"}. pi-web must be restarted (再起動).');
			logServer(`${who}; do not kill it, that takes pi-web down. Or start pi with KANBAN_PORT=8790.`);
		} else {
			// A kanban, but not this generation's: its `/` is not our dashboard.
			logServer(`${HOST}:${PORT} is held by an old kanban: /api/dashboard answers, / does not.`);
			logServer(
				`that is why the dashboard shows "not found". Kill ${p.pid === undefined ? "that process" : `pid ${p.pid}`}, or start pi with KANBAN_PORT=8790.`,
			);
		}
	} else {
		logServer(
			`that server is v${p.version}. Kill ${p.pid === undefined ? "it" : `pid ${p.pid}`} or start pi with KANBAN_PORT=8790 to reuse the dashboard at once.`,
		);
	}
	// The old process may exit later. Keep looking for the freed port, slowly.
	if (staleRetryTimer === null) {
		staleRetryTimer = setTimeout(() => {
			staleRetryTimer = null;
			ensureServer();
		}, STALE_RETRY_MS);
		staleRetryTimer.unref();
	}
}

// ---------------------------------------------------------------------------
// Dashboard shell (GET /). The constant is the original; ~/.pi/kanban/dashboard.html
// is the generated mirror. #84: the old right-panel template was retired; this is the
// only one left.
// ---------------------------------------------------------------------------

// Card-body markdown (view only). ONE definition, injected into the dashboard script.
// Card text is stored raw; md() escapes FIRST and only
// then expands the whitelisted subset, and links are restricted to http(s).
export const KANBAN_MD_JS = `
  function esc(s){return String(s).replace(/[&<>\"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;"}[c];});}
  function md(s){
    var e = esc(s);
    e = e.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, function(m, label, url){
      var low = url.toLowerCase();
      var ok = low.indexOf("http://") === 0 || low.indexOf("https://") === 0;
      return ok ? '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + '</a>' : m;
    });
    e = e.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
    e = e.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
    var lines = e.split('\\n'), res = [], list = [];
    var flush = function(){ if (list.length){ res.push('<ul>' + list.join('') + '</ul>'); list = []; } };
    for (var i = 0; i < lines.length; i++){
      var li = /^- (.*)$/.exec(lines[i]);
      if (li) list.push('<li>' + li[1] + '</li>');
      else { flush(); res.push(lines[i]); }
    }
    flush();
    return res.join('<br>');
  }
`;

// #76: リロードを跨ぐ記憶（列のスクロール位置 / 展開中のカード）。ONE definition,
// injected into the dashboard。列のスクロール位置は画面ごとに別物なので、キーは
// LS_NS で分ける = kb-scroll/{ns} / kb-open/{ns}。#84 で右パネルが消えたので、今
// 書き込むのは dash だけ（関数は純関数テスト用にそのまま残す）。
// 既存の kb-collapse は形もキーも触らない（#72/#73 の再描画越しの復元はそのまま残す）。
export const KANBAN_MEMORY_JS = `
  var LS_SCROLL = "kb-scroll", LS_OPEN = "kb-open";
  var MAX_CARD_OPEN = 40;      // 展開状態を覚えるカードの上限（超えたら挿入順の古い方から捨てる）
  var SCROLL_DEBOUNCE_MS = 150; // 毎スクロールで書かない。書き込みは止まってから
  // localStorage は信用しない。壊れた JSON / 配列 / null は「保存なし」に落とす。
  function memParse(raw){
    if (raw == null) return null;
    try {
      var v = JSON.parse(raw);
      return v && typeof v === "object" && !Array.isArray(v) ? v : null;
    } catch (e) { return null; }
  }
  function memRead(key){
    try { return memParse(localStorage.getItem(key)); } catch (e) { return null; }
  }
  function memWrite(key, val){
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }
  function memLoad(key, ns){
    var all = memRead(key), v = all && all[ns];
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  }
  function memSave(key, ns, obj){
    var all = memRead(key) || {};
    all[ns] = obj;
    memWrite(key, all);
  }
  // 列が縮んだときに下の空白へ飛ばないよう、今の最大スクロール量に丸める。
  function memClamp(v, scrollHeight, clientHeight){
    if (typeof v !== "number" || !isFinite(v) || v <= 0) return 0;
    var sh = typeof scrollHeight === "number" && isFinite(scrollHeight) ? scrollHeight : 0;
    var ch = typeof clientHeight === "number" && isFinite(clientHeight) ? clientHeight : 0;
    var max = sh - ch;
    if (!(max > 0)) return 0;
    return v > max ? max : v;
  }
  // 記憶する価値のある展開か。DONE は数十枚あり容量も食うので対象外（閉じた状態に戻す）。
  function memKeepable(ckey){
    return /:(todo|doing)$/.test(String(ckey || ""));
  }
  // 保存前に掃除: DONE を落とし、上限を超えた分は挿入順の古い方から捨てる。
  function memCompactCards(obj, max){
    var out = {}, keys = Object.keys(obj || {}), n = keys.length;
    if (max == null) max = MAX_CARD_OPEN;
    for (var i = 0; i < n; i++){
      if (!memKeepable(keys[i].split("#")[0])) continue;
      if (obj[keys[i]] !== true) continue;
      out[keys[i]] = true;
    }
    keys = Object.keys(out);
    for (var j = 0; j + max < keys.length; j++) delete out[keys[j]];
    return out;
  }
  // 消えたカードの id を保存から落とす（列単位。消えたときだけ true を返す）。
  function memPruneColumn(obj, ckey, ids){
    var live = {}, pruned = false, prefix = ckey + "#";
    (ids || []).forEach(function(id){ live[prefix + id] = true; });
    Object.keys(obj || {}).forEach(function(k){
      if (k.indexOf(prefix) === 0 && !live[k]) { delete obj[k]; pruned = true; }
    });
    return pruned;
  }
`;

const DASHBOARD_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>KANBAN - __KB_HOST__</title>
<script>
(function(){
  // before any CSS: no FOUC. explicit pick wins; otherwise follow the OS scheme
  var t = "dark";
  try {
    var sv = localStorage.getItem("kb-theme");
    if (sv === "light" || sv === "dark") t = sv;
    else if (window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches) t = "light";
  } catch (e) {}
  if (t === "light") document.documentElement.setAttribute("data-theme", "light");
})();
</script>
<style>
  /* dark tokens = the existing palette, untouched; light tokens override the same names */
  :root{color-scheme:dark;--bg:#18181b;--panel:#1f1f23;--card:#27272a;--border:#27272a;--border-strong:#3f3f46;--text:#e4e4e7;--muted:#a1a1aa;--accent:#a78bfa;--accent-hover:#c4b5fd;--accent-soft:#241f38;--accent-soft-2:#1e1b2e;--ok:#4ade80;--bad-dot:#f87171;--danger-bg:#7f1d1d;--danger-fg:#fee2e2;--danger-soft-fg:#fecaca;--danger-border:#7f1d1d;--empty-big:#52525b}
  :root[data-theme="light"]{color-scheme:light;--bg:#fafafa;--panel:#ffffff;--card:#ececf1;--border:#e4e4e7;--border-strong:#d4d4d8;--text:#18181b;--muted:#62626b;--accent:#6d28d9;--accent-hover:#7c3aed;--accent-soft:#ede9fa;--accent-soft-2:#e4e0f7;--ok:#15803d;--bad-dot:#dc2626;--danger-bg:#b91c1c;--danger-fg:#fef2f2;--danger-soft-fg:#b91c1c;--danger-border:#dc2626;--empty-big:#a1a1aa}
  *{box-sizing:border-box}
  body{margin:0;padding:14px;background:var(--bg);color:var(--text);font:13px/1.5 system-ui,-apple-system,sans-serif}
  a{color:var(--accent)}
  a:hover{color:var(--accent-hover)}
  :focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
  .wrap{max-width:1200px;margin:0 auto}
  h1{margin:0 0 12px;font-size:16px;letter-spacing:.08em;color:var(--accent);display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  h2{margin:0 0 8px;font-size:11px;letter-spacing:.08em;color:var(--muted);font-weight:600}
  .hd{font-size:11px;letter-spacing:.08em;color:var(--accent);margin:18px 0 8px}
  /* theme toggle: fixed set of two inline SVGs, icon shows the theme it switches TO */
  #theme{flex:none;margin-left:auto;width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;background:transparent;border:1px solid var(--border-strong);border-radius:999px;color:var(--muted);cursor:pointer;padding:0}
  #theme:hover{border-color:var(--accent);color:var(--accent)}
  #theme svg{width:14px;height:14px;display:block;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
  #theme .ic-moon{display:none}
  :root[data-theme="light"] #theme .ic-sun{display:none}
  :root[data-theme="light"] #theme .ic-moon{display:block}
  /* connection status: text + dot, never color alone */
  #conn{font-size:11px;letter-spacing:.05em;color:var(--muted);border:1px solid var(--border-strong);border-radius:999px;padding:2px 10px;display:inline-flex;align-items:center;gap:6px}
  #conn::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--ok);flex:none}
  #conn.ok::before{background:var(--ok)}
  #conn.bad{color:var(--danger-soft-fg);border-color:var(--danger-border)}
  #conn.bad::before{background:var(--bad-dot)}
  #banner{display:none;background:var(--danger-bg);color:var(--danger-fg);padding:6px 10px;border-radius:6px;margin-bottom:10px;font-size:12px}
  #banner.on{display:block}
  #note{background:var(--panel);border:1px solid var(--border-strong);color:var(--text);padding:6px 10px;border-radius:6px;margin-bottom:10px;font-size:12px}
  /* stats */
  .stats{display:grid;grid-template-columns:repeat(7,1fr);gap:8px;margin-bottom:6px}
  .stat{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:10px 12px}
  .stat .n{display:block;font-size:24px;font-weight:600;line-height:1.2;color:var(--text);font-variant-numeric:tabular-nums}
  .stat .l{display:block;font-size:10px;letter-spacing:.1em;color:var(--muted);text-transform:uppercase}
  .stat.hot .n{color:var(--accent)}
  /* boards */
  .cols{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}
  .col{background:var(--panel);border-radius:8px;padding:8px;min-height:52px}
  .col h3{margin:0 0 6px;font-size:11px;letter-spacing:.08em;color:var(--muted);font-weight:600}
  .col h3 .c{color:var(--accent);margin-left:4px}
  .col.doingcol h3{color:var(--accent)}
  /* #38-9: DOING 列の強調（左ボーダー＋淡い背景で「今これ」と分かる） */
  .col.doingcol{border-left:3px solid var(--accent);background:var(--accent-soft-2)}
  .card{background:var(--card);border-radius:6px;padding:6px 8px;margin-bottom:6px;font-size:12px;display:flex;gap:4px;align-items:baseline;flex-wrap:wrap}
  .card .id{color:var(--accent);flex:none}
  .card .t{flex:1;min-width:0;overflow-wrap:anywhere;white-space:pre-wrap}
  /* #38-5: 60 字超は 3 行で切ってクリック展開 */
  .card .t.clampable:not(.open){display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;cursor:pointer}
  /* #38-10/#38-11: DOING の経過（「N分前から」）と 2 時間超の ⏳。色は既存トークンのみ */
  .card .since{color:var(--muted);margin-right:4px;font-variant-numeric:tabular-nums}
  .card .stale{color:var(--muted);margin-right:4px}
  /* #74: ⏳ は常に DOM に置き、2 時間未満は CSS で隠す（ticker が構造を変えないため）。 */
  .card .stale.empty{display:none}
  /* #38-7: 見出しクリックで列ごと畳む（中身は描画したまま display だけ落とす） */
  .col h3{cursor:pointer}
  .col.collapsed .card,.col.collapsed .more,.col.collapsed .addbtn,.col.collapsed .addin{display:none}
  /* 画像/動画サムネはカードの幅いっぱいの次の行。64px に抑えて 1 行の高さに収める。 */
  .card img,.card video{flex-basis:100%;max-width:100%;max-height:64px;border-radius:4px;display:block;margin-top:4px}
  .card .badimg{flex-basis:100%;font-size:11px;color:var(--muted);margin-top:4px}
  /* #36 前半: 掴んでいる手応え（派手にしない）+ ドロップ先の強調 */
  .card[draggable="true"]{cursor:grab}
  .card.dragging{opacity:.4;box-shadow:0 10px 22px rgba(0,0,0,.4);cursor:grabbing}
  .col.over{outline:2px dashed var(--accent);outline-offset:-2px}
  /* #52: ファイルを掴んでカードの上に来たとき */
  .card.fileover{outline:2px dashed var(--accent);outline-offset:-2px}
  @media (prefers-reduced-motion: no-preference){
    .card.dragging{transform:rotate(2.5deg) scale(.98)}
  }
  /* #36 カード本文のインライン編集 */
  .card .ted{flex:1 1 100%;width:100%;min-height:3.5em;font:inherit;font-size:12px;line-height:1.5;color:var(--text);background:var(--card);border:1px solid var(--accent);border-radius:4px;resize:vertical}
  /* #30 card ops: schedule / priority / blocked, existing tokens only */
  .card .prio{flex:none;font-size:10px;color:var(--accent);border:1px solid var(--border-strong);border-radius:999px;padding:0 5px}
  .card .blocked{flex:none;font-size:10px;color:var(--danger-soft-fg);border:1px solid var(--danger-border);border-radius:999px;padding:0 5px}
  .card .sched{flex:none;font-size:10px;color:var(--muted);font-variant-numeric:tabular-nums}
  .card .ops,.srv .ops{display:flex;gap:3px;flex-wrap:wrap;align-items:center;flex-basis:100%}
  .srv .ops{flex-basis:auto}
  /* ▲▼ は組で一行に保つ（折返しで片方だけ落ちない） */
  .card .ops .pair{display:flex;gap:3px;flex:none}
  button.mini{font:inherit;font-size:10px;line-height:1.5;color:var(--muted);background:var(--panel);border:1px solid var(--border-strong);border-radius:4px;padding:0 5px;cursor:pointer}
  button.mini:hover{color:var(--accent);border-color:var(--accent)}
  button.mini[disabled]{opacity:.45;cursor:default}
  /* #45 列末尾の追加 UI とカード削除（色は既存トークンのみ） */
  /* 読み取り専用は aria-disabled: ネイティブ disabled はクリックを飲んで理由を出せない */
  .col .addbtn{width:100%;margin-top:2px}
  .col .addin{width:100%;font:inherit;font-size:11px;background:var(--card);color:var(--text);border:1px solid var(--accent);border-radius:4px;padding:2px 4px}
  button.mini[aria-disabled="true"]{opacity:.45;cursor:default}
  .card .ops button.del{color:var(--danger-soft-fg);border-color:var(--danger-border)}
  .card .ops button.del:hover{color:var(--danger-fg);border-color:var(--danger-border)}
  /* #36 任意時刻の発火指定（datetime-local 直入力） */
  .card .ops input[type=datetime-local]{font:inherit;font-size:10px;background:var(--panel);color:var(--text);border:1px solid var(--border-strong);border-radius:4px;padding:1px 3px}
  /* #31 board switches: doingLoop / autoPick / interval / DOING stop */
  .ctl{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:2px 0 8px;font-size:11px;color:var(--muted)}
  button.sw{font:inherit;font-size:10px;letter-spacing:.05em;border-radius:999px;padding:1px 8px;border:1px solid var(--border-strong);background:transparent;color:var(--muted);cursor:pointer}
  button.sw.on{border-color:var(--ok);color:var(--ok)}
  button.sw[disabled]{opacity:.45;cursor:default}
  .ctl input[type=number]{width:56px;font:inherit;font-size:11px;background:var(--panel);color:var(--text);border:1px solid var(--border-strong);border-radius:4px;padding:1px 4px}
  /* #67: 残り N / 上限 は同じ行のまま（幅を取るので折返し単位にする） */
  .ctl .rest{font-variant-numeric:tabular-nums;white-space:nowrap}
  /* #66: ラベルと入力欄は 1 つの nowrap 群（幅が足りなければ行ごと折り返す） */
  .ctl .grp{display:inline-flex;align-items:center;gap:8px;flex-wrap:nowrap;white-space:nowrap}
  /* #68: WCAG 2.5.8 の 24×24。見た目は padding で稼ぎ、文字は 10px のまま */
  button.mini{min-width:24px;min-height:24px;padding:3px 6px}
  @media (max-width:479px){
    .ctl{gap:6px}
    .ctl .grp{gap:5px}
    .ctl input[type=number]{width:44px}
  }
  .more{font-size:11px;color:var(--muted);padding:2px 4px}
  /* sessions */
  .sess{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:10px}
  .sess.doing{border-color:var(--accent);background:var(--accent-soft);outline:1px solid var(--accent);outline-offset:-1px}
  .sess-hd{display:flex;gap:6px 14px;align-items:baseline;flex-wrap:wrap;margin-bottom:8px}
  .sess-t{font-size:13px;font-weight:600;overflow-wrap:anywhere;display:inline-flex;align-items:center;gap:6px}
  .sess-cwd{font-size:11px;color:var(--muted);overflow-wrap:anywhere}
  .sess-meta{font-size:11px;color:var(--muted);margin-left:auto;white-space:nowrap;font-variant-numeric:tabular-nums}
  /* #48: セッションはヘッダのクリックで畳める（既定は全開） */
  /* #49: 10px/var(--muted) の ▾ は見えなかった。本文色 + 13px + hover で「畳める」ことを示す。
     caret は文字のまま差し替える（回転より読み上げ・コピーに強い）。
     GLOBAL のヘッダは .sess-hd をレイアウト流用しているだけなので role で限定する。*/
  .sess-hd[role="button"]{cursor:pointer;border-radius:6px;margin:-4px -6px 8px;padding:4px 6px;user-select:none;-webkit-user-select:none}
  .sess-hd[role="button"]:hover{background:var(--accent-soft)}
  .sess .caret{flex:none;font-size:13px;line-height:1;color:var(--text);width:1em;text-align:center;margin-right:4px}
  /* #62: GLOBAL のヘッダも同じ caret を使う（.sess の外にあるので別セレクタ） */
  .sess-hd>.caret{flex:none;font-size:13px;line-height:1;color:var(--text);width:1em;text-align:center;margin-right:4px}
  .sess-empty{border:1px dashed var(--border-strong);border-radius:6px;padding:10px;text-align:center;color:var(--muted);font-size:12px}
  /* #48: カード検索（列の絞り込み。色は既存トークンのみ） */
  .q{width:100%;max-width:320px;font:inherit;font-size:12px;background:var(--panel);color:var(--text);border:1px solid var(--border-strong);border-radius:6px;padding:3px 6px;margin-bottom:8px}
  .q:focus{border-color:var(--accent)}
  .badge{font-size:10px;letter-spacing:.06em;border-radius:999px;padding:1px 8px;border:1px solid var(--border-strong);color:var(--muted);flex:none}
  .badge.on{border-color:var(--ok);color:var(--ok)}
  .badge.db{border-color:var(--accent);color:var(--accent);background:var(--accent-soft-2)}
  .badge.gone{border-color:var(--danger-bg);background:var(--danger-bg);color:var(--danger-fg)}
  /* #58: a halted loop is process memory, so the ON/OFF switches below are placebo until
     it is lifted. The banner is the only place that says so. */
  .halt{border:1px solid var(--danger-bg);background:var(--danger-bg);color:var(--danger-fg);border-radius:6px;padding:6px 10px;margin-bottom:8px;font-size:12px;line-height:1.5}
  .halt b{font-weight:600}
  .halt code{background:none;border:1px solid currentColor;border-radius:4px;padding:0 4px;font-size:11px}
  /* serve */
  .srv{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:8px 12px;margin-bottom:8px;display:flex;gap:6px 16px;align-items:baseline;flex-wrap:wrap}
  /* #50: URL と「● 配信中」が同じインライン行でぶつかり、折返すと重なっていた。u を flex 箱にする。 */
  .srv .u{font-size:13px;overflow-wrap:anywhere;display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
  .srv .u>a{overflow-wrap:anywhere;min-width:0}
  .srv .n{flex:1 1 100%;font-size:12px;font-weight:600;color:var(--text);overflow-wrap:anywhere}
  .srv .p{font-size:11px;color:var(--muted);overflow-wrap:anywhere;font-family:ui-monospace,monospace}
  .srv .t{font-size:11px;color:var(--muted);margin-left:auto;white-space:nowrap;font-variant-numeric:tabular-nums}
  .srv .x{font-size:11px;color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}
  .srv .x.ok{color:var(--ok)}
  .srv .x.dead{color:var(--danger-fg)}
  .srv .permx{font-size:11px;color:var(--muted);display:inline-flex;align-items:center;gap:3px;white-space:nowrap;cursor:pointer}
  .srv.gone{opacity:.55}
  /* empty states */
  .empty{border:1px dashed var(--border-strong);border-radius:8px;padding:18px 14px;text-align:center;color:var(--muted);font-size:12px}
  .empty .big{display:block;font-size:20px;margin-bottom:4px;color:var(--empty-big)}
  .empty b{color:var(--text);font-weight:600}
  section{margin-bottom:4px}
  /* #50: タブは上部の横並び。左の縦カラムは中身の幅を削っていた。 */
  .dash{display:flex;flex-direction:column;gap:12px}
  .tabs{display:flex;flex-direction:row;gap:4px;flex:0 0 auto;overflow-x:auto}
  .tab{font:inherit;font-size:12px;letter-spacing:.04em;text-align:center;color:var(--muted);background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:8px 14px;cursor:pointer;white-space:nowrap;flex:0 0 auto}
  .tab:hover{color:var(--text);border-color:var(--border-strong)}
  .tab.active{color:var(--accent);border-color:var(--accent);background:var(--accent-soft)}
  .panes{flex:1;min-width:0}
  .pane[hidden]{display:none}
  @media (max-width:899px){
    .stats{grid-template-columns:repeat(4,1fr)}
    .cols{grid-template-columns:1fr}
    .sess-meta{margin-left:0;white-space:normal}
  }
  @media (max-width:640px){
    .tabs{flex-direction:row;width:100%}
    .tab{flex:1 1 auto}
  }
  @media (max-width:479px){ .stats{grid-template-columns:repeat(2,1fr)} }
  @media (prefers-reduced-motion: reduce){ *{transition:none!important;animation:none!important} }
</style>
</head>
<body>
<div class="wrap">
  <h1>KANBAN - __KB_HOST__ <span id="conn" class="ok" role="status">接続中</span><button id="theme" type="button" aria-label="ライトテーマに切り替え" title="ライトテーマに切り替え"><svg class="ic-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg><svg class="ic-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8"/></svg></button></h1>
  <div id="banner" role="alert">サーバに接続できません。前回の表示を維持しています…</div>
  <div id="note" role="status" hidden></div>

  <div class="dash">
    <nav class="tabs" role="tablist" aria-label="ダッシュボード">
      <button class="tab active" id="tab-sessions" type="button" role="tab" aria-selected="true" aria-controls="pane-sessions">セッション</button>
      <button class="tab" id="tab-serve" type="button" role="tab" aria-selected="false" aria-controls="pane-serve">配信サーバー</button>
    </nav>
    <div class="panes">
      <div class="pane" id="pane-sessions" role="tabpanel" aria-labelledby="tab-sessions">
        <!-- #36: エージェントタブ廃止。中身（STATS）をセッション一覧の上に移す。全 0 では畳む -->
        <section id="statsec" aria-labelledby="h-stats">
          <h2 id="h-stats">STATS</h2>
          <div class="stats" id="stats" aria-label="統計サマリ"></div>
        </section>
        <section aria-labelledby="h-global">
          <div class="hd" id="h-global">GLOBAL（全セッション共有）</div>
          <div id="global"></div>
        </section>
        <section aria-labelledby="h-sessions">
          <div class="hd" id="h-sessions">SESSIONS</div>
          <input id="q" class="q" type="search" placeholder="検索（/ でフォーカス, Esc でクリア）" autocomplete="off">
          <div id="sessions"></div>
        </section>
      </div>
      <div class="pane" id="pane-serve" role="tabpanel" aria-labelledby="tab-serve" hidden>
        <section aria-labelledby="h-serve">
          <div class="hd" id="h-serve">SERVE（配信中のサーバー）</div>
          <div id="serve"></div>
        </section>
      </div>
    </div>
  </div>
</div>

<script>
(function(){
  var API = "/api/dashboard";           // relative on purpose: same origin, no host assumptions
  var MEDIA = "/api/media/";             // mirrors MEDIA_PREFIX (server side)
  var MAX_PER_COL = 10;
  var COLS = [["todo","TODO"],["doing","DOING"],["done","DONE"]];
  var STAT_KEYS = [["sessions","sessions"],["active","active"],["todo","todo"],["doing","doing"],["done","done"],["serve","serve"],["media","media"]];
  var lastData = null;   // keep previous payload when the server blinks
  var sig = "";
  // #48: 検索語とセッションの開閉はクライアント側の状態。ポーリングの再描画と
  // DOM 作り直しを跨いで保持する（localStorage は使わない: 既存の流儀どおり）。
  var query = "";        // 小文字化済みの検索語
  var sessOpen = {};     // sid -> expanded（既定は全開）
  // #38-7/#38-11: どちらもクライアントだけの状態（サーバには保存しない）。
  // #62: 列のキーは "session.<sid>:col" / "global:col"（GLOBAL に active sid を混ぜない）。
  var collapsed = {};    // ckey -> true while a column is folded
  // #72: 60 字超の本文のクリック展開（.open）だけは別の持ち物が要る。.open は表示状態なので
  // isEditing() では守れず、分境界の再描画で必ず畳まれる。sig には載せない（載せると
  // クリックのたびに描画が走ってフォーカスが飛ぶ）— 描画時にここから引くだけ。
  var cardOpen = {};     // ckey + "#" + id -> true while the card's body is expanded
  // #75: その場追加の入力欄（.addin）は再描画で列ごと作り直される。開閉と打ちかけの文字を
  // 列（ckey）単位で持つ。sig には載せない（載せると打鍵のたびに描画が走ってフォーカスが飛ぶ）。
  // 捨てるのは明示的な操作（Escape / Enter 確定 / 空のまま blur）だけ。blur で無条件に
  // 捨てると、再描画前の一瞬のフォーカス移動で打ちかけが消える（#75 の不具合そのもの）。
  var addDraft = {};     // ckey -> 打ちかけの文字列（キーがある = 開いている）
  var gOpen = true;      // #62: GLOBAL 看板の開閉（既定は開）
  // #62: 開閉だけ localStorage に残す。kb-theme と同じく失敗は握りつぶし、
  // 保存が無いキーは今の既定のまま。ns は dash のみ（#84 で右パネルは消えた）。
  var LS_KEY = "kb-collapse", LS_NS = "dash";
  // #76: リロード越しの記憶。kb-scroll/dash = 列のスクロール位置、kb-open/dash = 展開中の
  // カード（DONE は対象外・上限 40）。再描画越しの cardOpen の上に「保存層」を足す形。
${KANBAN_MEMORY_JS}
  var scrollTimer = null;
  // #76: DONE はリロードで閉じた状態に戻す。kb-collapse（#72 の残骸）にも載せない。
  function keptOpen(){
    return memCompactCards(cardOpen, MAX_CARD_OPEN);
  }
  function memoCards(){
    // 保存のたびに掃除する（毎描画ではない）。DONE と上限超過はここで落ちる。
    memSave(LS_OPEN, LS_NS, keptOpen());
  }
  function persistCore(){
    try {
      var all = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
      if (!all || typeof all !== "object") all = {};
      all[LS_NS] = { sess: sessOpen, g: gOpen, cols: collapsed, open: keptOpen() };
      localStorage.setItem(LS_KEY, JSON.stringify(all));
    } catch (e) {}
  }
  function saveScrollPos(deck){
    var k = deck && deck.getAttribute("data-ckey");
    if (!k || !(deck.clientHeight > 0)) return; // 畳んだ列は測れない（0 で潰さない）
    var m = memLoad(LS_SCROLL, LS_NS) || {};
    m[k] = deck.scrollTop;
    memSave(LS_SCROLL, LS_NS, m);
  }
  function onScroll(e){
    var t = e && e.target;
    if (!t || !t.getAttribute) return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(function(){ saveScrollPos(t); }, SCROLL_DEBOUNCE_MS);
  }
  function restoreScrollPos(root){
    if (!root || !root.querySelectorAll) return;
    var m = memLoad(LS_SCROLL, LS_NS);
    if (!m) return;
    var ds = root.querySelectorAll(".cards[data-ckey]");
    for (var i = 0; i < ds.length; i++){
      var k = ds[i].getAttribute("data-ckey");
      var v = Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null;
      if (v == null) continue;
      var y = memClamp(v, ds[i].scrollHeight, ds[i].clientHeight);
      if (y > 0) ds[i].scrollTop = y;
    }
  }
  // #65: 描画を止めるのは「ユーザが入力中」のときだけ。再描画で作り直される領域
  // （#stats/#sessions/#global/#serve）の中で、値を受け付ける要素にフォーカスがある間は描かない。
  // フォーカス中の要素が DOM から切り離されると blur が飛ばず、打鍵が無言で消えるため。
  // - #q（検索ボックス）は 4 領域の外にある静的ノードなので対象外。ここを含めると
  //   検索打鍵中に redraw() が early return し、絞り込みが一切描画されず画面が凍る。
  // - button / checkbox は含めない。Chrome はクリックした button にフォーカスを残すので、
  //   含めるとモード切替ボタンを押した後ずっと更新が止まる。
  // - クリックでフォーカスが残るが打鍵を受けない INPUT（checkbox/radio/button 系）は除外。
  //   含めると #serve の永久トグルを押した後、blur するまで更新が止まる。
  // 見送ったデータは sig を進めず（reload 参照）、blur 後の最初のポーリングで追いつく。
  var NO_TYPE_INPUT = /^(checkbox|radio|button|submit|reset|file|image|range|color)$/;
  function isEditing(){
    var a = document.activeElement;
    if (!a || a === document.body) return false;
    var tg = a.tagName;
    var typing = tg === "TEXTAREA" || a.isContentEditable === true ||
      (tg === "INPUT" && !NO_TYPE_INPUT.test(a.type || "text"));
    if (!typing) return false;
    return !!(a.closest && a.closest("#stats, #sessions, #global, #serve"));
  }
  // sig は「今 DOM に描かれている状態」を記述する（query を落とすと検索語の変化を取り逃す）。
  function uiSig(){ return JSON.stringify([sessOpen, gOpen, collapsed, query]); }
  function persist(){ persistCore(); }
  // #72: 展開状態の読み直し + 消えたカードの掃除。render() からも呼ぶので例外は握りつぶす。
  // 掃除は列単位（ckey 接頭辞）。掃除が起きたときだけ書き戻すので、保存も痩せる。
  function loadOpen(ckey, list){
    try {
      var all = JSON.parse(localStorage.getItem(LS_KEY) || "null");
      var v = all && all[LS_NS];
      if (v && v.open && typeof v.open === "object") Object.keys(v.open).forEach(function(k){ cardOpen[k] = v.open[k] === true; });
    } catch (e) {}
    var present = {}, pruned = false;
    list.forEach(function(c){ present[ckey + "#" + c.id] = true; });
    Object.keys(cardOpen).forEach(function(k){
      if (k.indexOf(ckey + "#") === 0 && !present[k]) { delete cardOpen[k]; pruned = true; }
    });
    if (pruned) { persist(); memoCards(); }
  }
  // #76: リロード越しの展開状態。DONE は保存しないので、ここで拾うのは TODO/DOING だけ。
  var memoOpen = memLoad(LS_OPEN, LS_NS);
  if (memoOpen) Object.keys(memoOpen).forEach(function(k){ if (memoOpen[k] === true) cardOpen[k] = true; });
  (function(){
    var all = null;
    try { all = JSON.parse(localStorage.getItem(LS_KEY) || "null"); } catch (e) {}
    var v = all && all[LS_NS];
    if (!v || typeof v !== "object") return;
    if (v.sess && typeof v.sess === "object") Object.keys(v.sess).forEach(function(k){ sessOpen[k] = v.sess[k] === true; });
    if (v.cols && typeof v.cols === "object") Object.keys(v.cols).forEach(function(k){ collapsed[k] = v.cols[k] === true; });
    if (v.open && typeof v.open === "object") Object.keys(v.open).forEach(function(k){ cardOpen[k] = v.open[k] === true; });
    if (typeof v.g === "boolean") gOpen = v.g;
  })();
  var STALE_GUI_MS = 2 * 60 * 60 * 1000; // DOING over this long gets a ⏳
  // #74: 相対時刻スパンの台帳。render() が書き、tick() が読む。
  // nowT: ago() で描いたテキスト / nowS: 「N分前から」と ⏳
  var nowBase = Date.now();
  var nowT = [];
  var nowS = [];
${KANBAN_MD_JS}

  // #48: "/" で検索欄へ、Esc でクリア。入力中は横取りしない。
  if (document.addEventListener) document.addEventListener("keydown", function(e){
    var qe = document.getElementById("q");
    if (!qe || !e) return;
    var tag = e.target && e.target.tagName ? String(e.target.tagName).toLowerCase() : "";
    if (e.key === "/" && tag !== "input" && tag !== "textarea") {
      e.preventDefault();
      qe.focus();
    } else if (e.key === "Escape" && document.activeElement === qe) {
      qe.value = "";
      query = "";
      redraw();
      qe.blur();
    }
  });

  // #29 tabs: the sidebar only toggles the hidden attribute — no navigation.
  // activeTab survives the 5s re-render because render() re-applies it.
  var TABS = ["sessions", "serve"]; // #36: エージェントタブ廃止（STATS はセッション表紙の上部へ）
  var activeTab = "sessions";
  function selectTab(name){
    if (TABS.indexOf(name) < 0) name = "sessions";
    activeTab = name;
    TABS.forEach(function(n){
      var on = n === name;
      var b = document.getElementById("tab-" + n);
      if (b) { b.className = "tab" + (on ? " active" : ""); b.setAttribute("aria-selected", on ? "true" : "false"); }
      var p = document.getElementById("pane-" + n);
      if (p) p.hidden = !on;
    });
  }
  TABS.forEach(function(n){
    var b = document.getElementById("tab-" + n);
    if (b && b.addEventListener) b.addEventListener("click", function(){ selectTab(n); });
  });
  selectTab(activeTab);

  function el(tag, cls, text){
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  // #55: どのセッションの看板も編集できる（セッション単位の書き込みロックは無い）。
  // ctx.active は常に true なので RO_MSG / RO_TITLE は発火しない。
  var RO_MSG = "この看板は読み取り専用 — 編集するにはそのセッションをアクティブにして";
  var RO_TITLE = "読み取り専用（編集するにはセッションをアクティブに）";
  var noteTimer = null;
  // #44/#39: 一時的なお知らせ行。#banner は接続断専用なので相乗りしない。
  function note(msg){
    var n = document.getElementById("note");
    if (!n) return;
    n.textContent = msg;
    n.hidden = !msg;
    clearTimeout(noteTimer);
    if (msg) noteTimer = setTimeout(function(){ n.hidden = true; }, 4000);
  }
  function empty(parent, icon, html){
    var d = el("div", "empty");
    d.appendChild(el("span", "big", icon));
    // html here is a fixed template with <b> only — never contains server data
    d.innerHTML = d.innerHTML + html;
    parent.appendChild(d);
  }
  function ago(iso, nowMs){
    var d = iso ? new Date(iso) : null;
    if (!d || isNaN(d.getTime())) return "—";
    var s = Math.max(0, Math.round(((nowMs != null ? nowMs : Date.now()) - d.getTime()) / 1000));
    if (s < 60) return "たった今";
    if (s < 3600) return Math.floor(s/60) + "分前";
    if (s < 86400) return Math.floor(s/3600) + "時間前";
    return Math.floor(s/86400) + "日前";
  }
  function full(iso){ var d = iso ? new Date(iso) : null; return (d && !isNaN(d.getTime())) ? d.toLocaleString() : ""; }
  // カードの発火行は固定幅の列に収めるので長い toLocaleString は使わない: MM/DD HH:MM（24h）
  function shortFire(v){
    var d = v ? new Date(v) : null;
    if (!d || isNaN(d.getTime())) return "—";
    var p = function(n){ return (n < 10 ? "0" : "") + n; };
    return p(d.getMonth() + 1) + "/" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  // #36: datetime-local の値はローカル壁時計（タイムゾーン無し）。
  function dtLocal(iso){
    var d = iso ? new Date(iso) : null;
    if (!d || isNaN(d.getTime())) return "";
    var p = function(n){ return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + "-" + p(d.getMonth()+1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function safeHref(u){
    try { var x = new URL(u); return (x.protocol === "http:" || x.protocol === "https:") ? x.href : null; }
    catch (e) { return null; }
  }

  // #30/#31: the one fetch site. The dashboard poll and every write go through it, so a
  // write always carries scope (+ sid: #33 makes scope=session without sid a 400).
  function api(path, params, init){
    var u = path;
    if (params) {
      var qs = [], keys = Object.keys(params), i;
      for (i = 0; i < keys.length; i++) {
        qs.push(encodeURIComponent(keys[i]) + "=" + encodeURIComponent(String(params[keys[i]])));
      }
      if (qs.length) u += (u.indexOf("?") < 0 ? "?" : "&") + qs.join("&");
    }
    // #52: 生ボディの POST（/api/upload）もこの 1 つの fetch 点を通す。
    return fetch(u, init).then(function(r){
      if (!r.ok) throw new Error("http " + r.status);
      return r.json();
    });
  }
  // One board write. ctx = {scope, sid, active}; sid rides along whenever we have one.
  function act(path, p, ctx){
    var params = { scope: ctx.scope }, k;
    for (k in p) if (Object.prototype.hasOwnProperty.call(p, k)) params[k] = p[k];
    if (ctx.sid) params.sid = ctx.sid;
    // a failed write is not a connection failure: the next poll shows the truth
    return api(path, params).then(function(){ reload(); }, function(){});
  }
  // The button stays disabled for as long as its handler's promise is in flight, so a
  // triple click cannot become three writes. Released on success and on failure.
  // #71/#011: the guard itself is flightGate (pure, no DOM) so it can be tested without
  // a browser; btn() is only the wiring. A handler with no promise is a plain action
  // (a redraw request) and must not leave the button dead.
  function flightGate(fn){
    var busy = false;
    // null = did not start (busy, or the handler is synchronous); else the wrapped promise.
    function run(){
      if (busy) return null;
      var r = fn();
      if (!r || typeof r.then !== "function") return null;
      busy = true;
      return r.then(function(v){ busy = false; return v; }, function(e){ busy = false; throw e; });
    }
    run.isBusy = function(){ return busy; };
    return run;
  }
  function btn(label, title, fn, disabled){
    var b = el("button", "mini", label);
    b.type = "button";
    if (title) b.title = title;
    b.disabled = !!disabled;
    if (disabled) return b;
    var run = flightGate(fn);
    b.addEventListener("click", function(){
      if (b.disabled) return;
      var p = run();
      if (!p) return;
      b.disabled = true;
      function release(){ b.disabled = false; }
      p.then(release, release);
    });
    return b;
  }
  function boardCtx(scope, sid, active){ return { scope: scope, sid: sid || "", active: active !== false }; }
  // #52: ファイルを列（id 無し = 新規カード）かカード（id あり = そのカードに添付）へ送る。
  // サーバは ext クエリ必須で OK_EXTS 以外は 415 なので、送る前に同じ集合で弾いて知らせる。
  var OK_EXTS = ["png", "jpg", "gif", "webp", "avif", "mp4", "webm"]; // mirrors server OK_EXTS
  var EXT_BY_MIME = {"image/png":"png","image/jpeg":"jpg","image/gif":"gif","image/webp":"webp","image/avif":"avif","video/mp4":"mp4","video/webm":"webm"};
  // #59: #84 で旧テンプレートを落とした際にこの分岐も一緒に消えていた。drag 元（curl・一部 OS）は
  // file.type が空で来るので、MIME -> ファイル名の順で引く。.jpeg は .jpg と同じ形式。
  function extOfFile(file){
    var byMime = file && EXT_BY_MIME[file.type];
    if (byMime) return byMime;
    var name = String((file && file.name) || "");
    var dot = name.lastIndexOf(".");
    var ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
    if (ext === "jpeg") ext = "jpg";
    return OK_EXTS.indexOf(ext) >= 0 ? ext : "";
  }
  function uploadHere(ctx, col, file, id){
    var name = String((file && file.name) || "");
    var ext = extOfFile(file);
    if (!ext) {
      note("非対応のファイル: " + (name || "(無名)") + " — " + OK_EXTS.join("/") + " のみ");
      return;
    }
    var params = { scope: ctx.scope, ext: ext, col: col };
    if (ctx.sid) params.sid = ctx.sid;
    if (id !== undefined) params.id = id;
    // 生ボディ (application/octet-stream)。api() に init を渡して同じ fetch 点を通す。
    file.arrayBuffer().then(function(buf){
      return api("/api/upload", params, { method: "POST", body: buf, headers: { "Content-Type": "application/octet-stream" } });
    }).then(function(){
      reload(); // サーバが返した新しい img / 新規カードを反映
    }).catch(function(err){
      note("アップロード失敗: " + (err && err.message ? err.message : "network error"));
    });
  }
  // #36: カード本文のダブルクリック編集。Enter=確定 / Shift+Enter=改行 / Escape=取消。
  // 取消後の blur で二重発火しないよう done で一回限りに制限する。
  function startEdit(tspan, raw, apply){
    var ta = document.createElement("textarea");
    ta.className = "ted";
    ta.value = raw;
    var done = false;
    function finish(cancel){
      if (done) return;
      done = true;
      if (ta.parentNode) ta.parentNode.replaceChild(tspan, ta);
      var v = ta.value;
      if (!cancel && v.trim().length > 0 && v !== raw) apply(v);
    }
    ta.addEventListener("keydown", function(e){
      if (e.key === "Escape") { e.preventDefault(); finish(true); }
      else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finish(false); }
    });
    ta.addEventListener("blur", function(){ finish(false); });
    tspan.parentNode.replaceChild(ta, tspan);
    ta.focus();
  }
  function prioOf(c){ var v = c && c.priority; return (typeof v === "number" && isFinite(v)) ? v : 0; }
  function intervalOf(m){ var v = m && m.intervalMin; return (typeof v === "number" && isFinite(v) && v > 0) ? v : 5; }
  // #67: the doing-loop budget. Absent/invalid = 10 (the old hard-coded cap); 0 = unlimited.
  // Mirrors maxLoopsOf on the server, so the GUI never shows a cap the loop does not use.
  function maxLoopsOf(m){
    var v = m && m.maxLoops;
    if (typeof v !== "number" || v !== Math.floor(v)) return 10;
    if (v <= 0) return 0;
    return v <= 1000 ? v : 10;
  }
  // #67: how many doing-loops this session has used. Published by /api/dashboard
  // (sessions[].loops) from the extension process; the cap is read from modes here.
  function loopCountOf(sid){
    if (!lastData || !sid) return 0;
    var i, list = lastData.sessions || [];
    for (i = 0; i < list.length; i++) if (list[i] && list[i].id === sid) return typeof list[i].loops === "number" ? list[i].loops : 0;
    return 0;
  }
  // Dashboard wording: 残り N / M, and 残り N / 無制限 when the cap is 0 (uncapped) —
  // the same N as the footer's (loopRestText: remaining under a cap, used without one).
  // #71/#011: the cap and the count come from files/published state, so nonzero garbage
  // ("7", null, NaN, ±Infinity) must land on a real branch instead of throwing or
  // printing "NaN": a cap that is not a finite number is uncapped, a count is ≥ 0 and
  // finite. cap/used are the raw numbers; the display rule is fixed by the tests.
  function loopRestLine(cap, used){
    var c = (typeof cap === "number" && isFinite(cap)) ? cap : 0;
    var u = (typeof used === "number" && isFinite(used) && used > 0) ? Math.floor(used) : 0;
    if (c > 0) return "残り " + Math.max(0, c - u) + " / " + c;
    return "残り " + u + " / 無制限";
  }

  // #58: why the doing-loop is stopped, and what actually clears it. The loop budget
  // lives in pi's extension process (survives the file), so the tool/command paths lift
  // it; #67 added the 再開 button below, which is the third (and only GUI) path.
  function haltText(h, cap){
    if (!h) return "";
    var c = (cap === undefined || cap === null) ? 10 : cap;
    if (h.halted === "limit") return "ループ上限（" + (c > 0 ? c + "回" : "無制限") + "）に達して停止 — 下の「再開」、kanban ツールの resume、または /kanban loop on（スイッチを ON にしても再開しない）";
    if (h.halted === "stuck") return "同じカード（#" + h.stuckId + "）で " + h.stuckCount + " 回スタックして停止 — カードを直してから下の「再開」、kanban ツールの resume、または /kanban loop on（スイッチを ON にしても再開しない）";
    return "";
  }

  // #67: 再開ボタン。halt は拡張プロセスのメモリなので、この書き込みは「要求」でしかない
  // （/api/resume は 202 を返し、そのセッションの poll が実際に解除する）。
  function resumeBtn(ctx){
    var b = el("button", "mini", "再開");
    b.type = "button";
    b.title = "停止を解除して回数を 0 に戻す（doingLoop も ON に戻る）";
    b.disabled = !ctx.active;
    if (ctx.active) b.addEventListener("click", function(){ act("/api/resume", {}, ctx); });
    return b;
  }
  var PRIO_MAX = 99, PRIO_MIN = -99; // same range the server enforces
  var dragging = null;               // {scope, sid, id} of the card being dragged

  // #30: schedule + priority live on the card itself.
  function cardOps(c, ctx){
    var ops = el("div", "ops");
    // 表示は MM/DD HH:MM に削るので、年を含む完全な日時はホバーで補う
    var sched = el("span", "sched", "発火 " + shortFire(c.nextFireAt));
    sched.title = full(c.nextFireAt) || "発火予定なし";
    ops.appendChild(sched);
    function fire(at, label, title, off){
      ops.appendChild(btn(label, title, function(){ return act("/api/schedule", { id: c.id, at: at }, ctx); }, !ctx.active || off));
    }
    fire("+5m", "+5m", "5分後に発火");
    fire("+1h", "+1h", "1時間後に発火");
    ops.appendChild(btn("明日9時", "明日9時に発火", function(){
      var d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      return act("/api/schedule", { id: c.id, at: d.toISOString() }, ctx);
    }, !ctx.active));
    fire("", "解除", "発火予定を消す", !c.nextFireAt);
    // #36: 任意の時刻は datetime-local 直入力（空で解除）。プリセットは残す。
    var dt = el("input");
    dt.type = "datetime-local";
    dt.value = dtLocal(c.nextFireAt);
    dt.title = "任意の時刻に発火（空で解除）";
    dt.setAttribute("aria-label", "発火時刻を指定");
    dt.disabled = !ctx.active;
    dt.style.flex = "1 1 150px";
    dt.addEventListener("change", function(){
      if (dt.value === "") { act("/api/schedule", { id: c.id, at: "" }, ctx); return; }
      var t = new Date(dt.value).getTime();
      if (isNaN(t)) { dt.value = dtLocal(c.nextFireAt); return; }
      act("/api/schedule", { id: c.id, at: new Date(t).toISOString() }, ctx);
    });
    ops.appendChild(dt);
    // 数値が大きいほど先（server: priority desc, id asc）。0 は未設定なので表示しない。
    var pair = el("span", "pair");
    pair.appendChild(btn("▲", "優先度を上げる", function(){
      if (prioOf(c) < PRIO_MAX) return act("/api/priority", { id: c.id, n: prioOf(c) + 1 }, ctx);
    }, !ctx.active || prioOf(c) >= PRIO_MAX));
    pair.appendChild(btn("▼", "優先度を下げる", function(){
      if (prioOf(c) > PRIO_MIN) return act("/api/priority", { id: c.id, n: prioOf(c) - 1 }, ctx);
    }, !ctx.active || prioOf(c) <= PRIO_MIN));
    ops.appendChild(pair);
    // #45: 削除。読み取り専用は aria-disabled（ネイティブ disabled だとクリックが
    // 発火せず、押せない理由を返せない）。
    var del = el("button", "mini del", "\\u00d7");
    del.type = "button";
    del.setAttribute("aria-disabled", ctx.active ? "false" : "true");
    del.title = ctx.active ? "このカードを削除" : RO_TITLE;
    del.setAttribute("aria-label", "このカードを削除");
    del.addEventListener("click", function(){
      if (!ctx.active) { note(RO_MSG); return; }
      if (!window.confirm("「" + String(c.text || "").slice(0, 40) + "」を削除しますか？")) return;
      act("/api/remove", { id: c.id }, ctx);
    });
    ops.appendChild(del);
    return ops;
  }

  // #31: the switches a board owns. A board we may not write to renders them disabled
  // (the server 403s a write coming from a session that is not the active one).
  function boardCtl(ctx, m, cards){
    var box = el("div", "ctl");
    if (!ctx.active) box.title = "このセッションはアクティブではないので読み取り専用";
    function sw(key, label){
      var on = !m || m[key] !== false; // absent means ON, same as modesFor
      var b = el("button", "sw" + (on ? " on" : ""), label + " " + (on ? "ON" : "OFF"));
      b.type = "button";
      b.disabled = !ctx.active;
      b.title = key + " を " + (on ? "off" : "on") + " にする";
      if (ctx.active) b.addEventListener("click", function(){ act("/api/modes", { key: key, value: on ? "off" : "on" }, ctx); });
      return b;
    }
    box.appendChild(sw("doingLoop", "ループ"));
    box.appendChild(sw("autoPick", "ピック"));
    // 間隔・上限は「ラベル＋入力欄＋ボタン」を 1 つの nowrap 群にまとめる。
    // 幅が足りないときは行ごと折り返すので、ラベルだけが泣き別れしない（#66）。
    var ivg = el("span", "grp");
    ivg.appendChild(el("span", null, "間隔"));
    var iv = el("input");
    iv.type = "number";
    iv.min = "1";
    iv.value = String(intervalOf(m));
    iv.disabled = !ctx.active;
    iv.title = "発火間隔（分）";
    iv.setAttribute("aria-label", "発火間隔（分）");
    ivg.appendChild(iv);
    ivg.appendChild(btn("分", "この間隔（分）で保存", function(){
      var v = Number(iv.value);
      if (isFinite(v) && v > 0) return act("/api/interval", { min: Math.round(v) }, ctx);
      note("間隔は 1 以上の整数（分）: " + (iv.value === "" ? "(空)" : iv.value));
      iv.value = String(intervalOf(m));
    }, !ctx.active));
    box.appendChild(ivg);
    // #67: ループ上限（0 = 無制限）。間隔と同じ行・同じ act() 経路で保存する。
    // 保存済みの上限を出すときは intervalOf と同じ「無ければ既定」の読み方をする。
    var cap = maxLoopsOf(m);
    var mlg = el("span", "grp");
    // 上限ラベルの表記。0 = 無制限。
    mlg.appendChild(el("span", null, cap > 0 ? "上限" : "上限（無制限）"));
    var ml = el("input");
    ml.type = "number";
    ml.min = "0";
    ml.max = "1000";
    ml.value = String(cap);
    ml.disabled = !ctx.active;
    ml.title = "ループ上限（回、0 = 無制限）";
    ml.setAttribute("aria-label", "ループ上限（回、0 で無制限）");
    mlg.appendChild(ml);
    mlg.appendChild(btn("回", "この上限（回、0 = 無制限）で保存", function(){
      var v = Number(ml.value);
      // 範囲外は黙って捨てずに、サーバが返すのと同じ範囲を文言で知らせて値を戻す。
      // 空欄は Number("") = 0 = 無制限になってしまうので、それも弾く。
      if (!(ml.value !== "" && isFinite(v) && v >= 0 && v <= 1000 && v % 1 === 0)) {
        note("上限は 0〜1000 の整数（0 = 無制限）: " + (ml.value === "" ? "(空)" : ml.value));
        ml.value = String(cap);
        return;
      }
      return act("/api/maxloops", { n: v }, ctx);
    }, !ctx.active));
    box.appendChild(mlg);
    // #67: このボードで使った回数と残り。正本は拡張プロセス（loop.count）で、
    // ダッシュボードは /api/dashboard の loops をそのまま出す（新しい API は要らない）。
    box.appendChild(el("span", "rest", loopRestLine(cap, loopCountOf(ctx.sid))));
    // DOING 全停止 reuses the existing blocked field, one card at a time (no new state).
    var doing = cards.filter(function(c){
      return c.col === "doing" && !(typeof c.blocked === "string" && c.blocked.trim().length > 0);
    });
    box.appendChild(btn("DOING 全停止", "この看板の DOING " + doing.length + " 枚を blocked にする", function(){
      var chain = Promise.resolve();
      doing.forEach(function(c){
        chain = chain.then(function(){ return act("/api/schedule", { id: c.id, blocked: "一時停止" }, ctx); });
      });
      return chain;
    }, !ctx.active || !doing.length));
    return box;
  }

  // One kanban (3 columns). Cards go in via textContent — no innerHTML for data.
  function board(cards, nowMs, ctx){
    if (typeof nowMs !== "number" || !isFinite(nowMs)) nowMs = Date.now(); // #38-10: 経過の基準
    var wrap = el("div", "cols");
    COLS.forEach(function(pair, ci){
      var key = pair[0];
      var list = cards.filter(function(c){ return c.col === key; });
      // #38-7: 折りたたみのキーは看板ごと（GLOBAL と各セッションで別々に畳める）
      // #62: GLOBAL に active sid を混ぜない（切り替わるたびに別キーになって勝手に開いていた）。
      var ckey = ctx.scope === "global" ? "global:" + key : ctx.scope + "." + ctx.sid + ":" + key;
      var box = el("div", "col" + (key === "doing" && list.length ? " doingcol" : "") + (collapsed[ckey] ? " collapsed" : ""));
      loadOpen(ckey, list); // #72: 描画のたびに読み直し、消えたカードの分を掃除する
      box.setAttribute("data-col", key);
      var h = el("h3", null, pair[1]);
      h.appendChild(el("span", "c", String(list.length)));
      // #38-7: 見出しクリックで列ごと畳む（状態はこのページ内だけ）
      h.addEventListener("click", function(){ collapsed[ckey] = !collapsed[ckey]; box.classList.toggle("collapsed"); persist(); });
      box.appendChild(h);
      if (ctx && ctx.active) {
        // #30 D&D: same handler on the GLOBAL board and on every session board.
        // #52: ファイルも受ける。掴んでいるカードがあれば従来の移動経路を優先する。
        box.addEventListener("dragover", function(ev){
          if (dragging && dragging.scope === ctx.scope && dragging.sid === ctx.sid) {
            if (ev && ev.preventDefault) ev.preventDefault();
            box.classList.add("over");
            return;
          }
          if (!ev || !ev.dataTransfer || !ev.dataTransfer.types || ev.dataTransfer.types.indexOf("Files") < 0) return;
          if (ev.preventDefault) ev.preventDefault(); // 既定の「ファイルを開く」に落とさない
          ev.dataTransfer.dropEffect = "copy";
          box.classList.add("over");
        });
        box.addEventListener("dragleave", function(){ box.classList.remove("over"); });
        box.addEventListener("drop", function(ev){
          if (ev && ev.preventDefault) ev.preventDefault();
          box.classList.remove("over");
          var d = dragging;
          dragging = null;
          if (d) {
            if (d.scope !== ctx.scope || d.sid !== ctx.sid) return;
            act("/api/move", { id: d.id, col: key }, ctx);
            return;
          }
          var f = ev && ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
          if (!f) return;
          if (ev.stopPropagation) ev.stopPropagation();
          uploadHere(ctx, key, f, undefined); // 列の先頭に新規カード
        });
      }
      // #76: 列スクロールはリロード越しにも覚える（描画越しは saveScroll が担当）
      var deck = el("div", "cards");
      deck.setAttribute("data-ckey", ckey);
      deck.addEventListener("scroll", onScroll);
      if (!list.length) {
        deck.appendChild(el("div", "more", "なし"));
      } else {
        list.slice(0, MAX_PER_COL).forEach(function(c){
          var card = el("div", "card");
          if (ctx && ctx.active) {
            card.setAttribute("draggable", "true");
            card.addEventListener("dragstart", function(ev){
              dragging = { scope: ctx.scope, sid: ctx.sid, id: c.id };
              card.classList.add("dragging");
              if (ev.dataTransfer) { ev.dataTransfer.effectAllowed = "move"; ev.dataTransfer.setData("text/plain", String(c.id)); }
            });
            card.addEventListener("dragend", function(){ card.classList.remove("dragging"); });
            // #52: カードにファイルを落とすとそのカードに添付。
            // カード移動の drag（text/plain）は素通しして列の drop に任せる。
            card.addEventListener("dragover", function(ev){
              if (!ev || !ev.dataTransfer || !ev.dataTransfer.types || ev.dataTransfer.types.indexOf("Files") < 0) return;
              if (ev.preventDefault) ev.preventDefault();
              ev.dataTransfer.dropEffect = "copy";
              card.classList.add("fileover");
            });
            card.addEventListener("dragleave", function(){ card.classList.remove("fileover"); });
            card.addEventListener("drop", function(ev){
              var f = ev && ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
              if (!f) return; // カード移動なら列の drop に任せる
              if (ev.preventDefault) ev.preventDefault();
              if (ev.stopPropagation) ev.stopPropagation();
              card.classList.remove("fileover");
              uploadHere(ctx, c.col, f, c.id);
            });
          } else if (ctx) {
            // #44: 読み取り専用の看板。ダブルクリックしても書けない理由をホバーで先に示す
            // （ドラッグ不可のまま。移動できないのは正しい挙動）。
            card.title = RO_TITLE;
            // #52: ファイルを落としてもブラウザに開かせない。理由を出す。
            card.addEventListener("dragover", function(ev){
              if (!ev || !ev.dataTransfer || !ev.dataTransfer.types || ev.dataTransfer.types.indexOf("Files") < 0) return;
              if (ev.preventDefault) ev.preventDefault();
            });
            card.addEventListener("drop", function(ev){
              if (!ev || !ev.dataTransfer || !ev.dataTransfer.files || !ev.dataTransfer.files[0]) return;
              if (ev.preventDefault) ev.preventDefault();
              if (ev.stopPropagation) ev.stopPropagation();
              note(RO_MSG);
            });
          }
          if (ctx && ctx.active) {
            // #38-6: Tab でカードに入る。←→ で列移動、Enter で DOING、m でメモ。
            card.tabIndex = 0;
            card.addEventListener("keydown", function(e){
              if (e.target !== card) return; // a button or the memo textarea keeps its own keys
              if (e.key === "ArrowLeft" && ci > 0) { e.preventDefault(); act("/api/move", { id: c.id, col: COLS[ci-1][0] }, ctx); }
              else if (e.key === "ArrowRight" && ci < COLS.length - 1) { e.preventDefault(); act("/api/move", { id: c.id, col: COLS[ci+1][0] }, ctx); }
              else if (e.key === "Enter") { e.preventDefault(); act("/api/move", { id: c.id, col: "doing" }, ctx); }
              else if (e.key === "m") {
                e.preventDefault();
                var sp = card.querySelector(".t");
                if (sp) startEdit(sp, c.text, function(v){ act("/api/rename", { id: c.id, text: v }, ctx); });
              }
            });
          }
          card.appendChild(el("span", "id", "#" + c.id));
          var t = el("span", "t");
          // #38-10/#38-11: DOING の経過を本文の前に出す（2 時間超は ⏳ も）。movedAt の
          // 無いカードは何も出さない（推測で「0分」を書かない）。
          // #74: 経過分と ⏳ は lead で作っておき、台帳に載せて tick() が文字だけ書き換える。
          var lead = "";
          var movedAt = c.movedAt;
          if (c.col === "doing" && typeof movedAt === "number") lead = sinceLead(movedAt);
          t.innerHTML = lead + md(c.text); // md escapes first, then expands the whitelisted subset
          if (lead !== "" && typeof movedAt === "number") sinceLive(movedAt, t);
          // #38-5: 60 字超は 3 行で切ってクリック展開（列内の高さを揃える）。
          if (String(c.text || "").length > 60) {
            t.classList.add("clampable");
            var okey = ckey + "#" + c.id;
            if (cardOpen[okey]) t.classList.add("open");
            t.addEventListener("click", function(){
              if (t.classList.toggle("open")) cardOpen[okey] = true; else delete cardOpen[okey];
              persist();
              memoCards(); // #76: DONE は memCompactCards が落とす（画面の開閉はそのまま）
            });
          }
          card.appendChild(t);
          // #36: 本文のダブルクリックで編集。書き込みは既存の text 系 API（rename）。
          // #44: 当たり判定はカード本体（短いカードだと .t が細く、#id/余白を叩いて無反応に見える）。
          // .t 側にも登録すると二重発火するので、ここ 1 本に統一する。
          card.addEventListener("dblclick", function(e){
            var tgt = e.target;
            // ボタン・リンク・編集中 textarea の誤爆は無視
            if (tgt && tgt.closest && (tgt.closest(".ops") || tgt.closest("a") || tgt.closest("textarea"))) return;
            if (!ctx || !ctx.active) { note(RO_MSG); return; }
            var span = card.querySelector(".t");
            if (span) startEdit(span, c.text, function(v){ act("/api/rename", { id: c.id, text: v }, ctx); });
          });
          if (c.img) {
            // Only images decode in an img element; video bytes need a real video element.
            var mediaExt = c.img.slice(c.img.lastIndexOf(".") + 1).toLowerCase();
            var isVid = mediaExt === "mp4" || mediaExt === "webm";
            var im;
            if (isVid) {
              // No autoplay: the card is a preview, so only metadata loads until play.
              im = document.createElement("video");
              im.controls = true;
              im.preload = "metadata";
            } else {
              im = document.createElement("img");
              im.alt = "";
            }
            im.src = MEDIA + encodeURIComponent(c.img);
            im.onerror = function(){
              var s = el("span", "badimg", "\\uD83D\\uDDBC?");
              if (im.parentNode) im.parentNode.replaceChild(s, im);
            };
            card.appendChild(im);
          }
          if (prioOf(c)) card.appendChild(el("span", "prio", "P" + prioOf(c)));
          if (c.blocked) card.appendChild(el("span", "blocked", "停止中"));
          if (ctx) card.appendChild(cardOps(c, ctx));
          deck.appendChild(card);
        });
        if (list.length > MAX_PER_COL) deck.appendChild(el("div", "more", "他 " + (list.length - MAX_PER_COL) + " 枚"));
      }
      box.appendChild(deck);
      restoreScrollPos(box);
      // #45: 列の最後尾でその場に追加。Enter=確定 / Escape=取消 / blur=閉じる。
      // 読み取り専用は aria-disabled（理由を返すためクリックは受ける）。
      var addBtn = el("button", "mini addbtn", "+");
      addBtn.type = "button";
      addBtn.setAttribute("aria-disabled", ctx.active ? "false" : "true");
      addBtn.title = ctx.active ? "この列にカードを追加" : RO_TITLE;
      addBtn.setAttribute("aria-label", "この列にカードを追加");
      var addIn = el("input", "addin");
      addIn.placeholder = "追加して Enter";
      addIn.setAttribute("aria-label", "この列にカードを追加");
      var sending = false;
      // 表示の切替だけを行う。打ちかけの破棄は clearAdd() に分離する（#75）。
      function showAdd(on){
        addBtn.style.display = on ? "none" : "";
        addIn.style.display = on ? "" : "none";
        if (on) addIn.focus();
      }
      function clearAdd(){
        delete addDraft[ckey];
        addIn.value = "";
      }
      // #75: 再描画を跨いで開いたまま・打ちかけの文字も残す（描画のたびにここで戻す）。
      if (addDraft[ckey] != null) addIn.value = addDraft[ckey];
      showAdd(addDraft[ckey] != null);
      addIn.addEventListener("input", function(){ addDraft[ckey] = addIn.value; });
      addBtn.addEventListener("click", function(){
        if (!ctx.active) { note(RO_MSG); return; }
        showAdd(true);
      });
      addIn.addEventListener("keydown", function(e){
        if (e.key === "Escape") { e.preventDefault(); clearAdd(); showAdd(false); return; }
        if (e.key !== "Enter") return;
        var v = addIn.value.trim();
        clearAdd();
        if (!v) { showAdd(false); return; }
        sending = true;
        act("/api/add", { col: key, text: v }, ctx).then(function(){ sending = false; });
        showAdd(false);
      });
      // 送信中（act の往復中）の blur では閉じない: reload 由来の blur で二重に閉じるのを防ぐ。
      // 値が入っているなら閉じない。打鍵中の再描画や
      // 別要素のクリックで打ちかけを失わせないため（#75）。
      addIn.addEventListener("blur", function(){
        if (sending || addIn.value.trim()) return;
        clearAdd();
        showAdd(false);
      });
      box.appendChild(addBtn);
      box.appendChild(addIn);
      wrap.appendChild(box);
    });
    return wrap;
  }

  function renderStats(st){
    var box = document.getElementById("stats");
    box.innerHTML = "";
    var allZero = true; // #36: sessions/active は自分自身なので数えない（常時 ≥1 のため）
    STAT_KEYS.forEach(function(p){
      var v = st ? (st[p[0]] || 0) : 0;
      if (v > 0 && p[0] !== "sessions" && p[0] !== "active") allZero = false;
      var s = el("div", "stat" + (v > 0 && (p[0] === "doing" || p[0] === "active") ? " hot" : ""));
      s.setAttribute("aria-label", p[1] + " " + v);
      s.appendChild(el("span", "n", String(v)));
      s.appendChild(el("span", "l", p[1]));
      box.appendChild(s);
    });
    if (st && !st.sessions && !st.todo && !st.doing && !st.done && !st.serve && !st.media) {
      box.title = "すべて 0 — サーバは起動しているけど、まだ何もない";
    }
    // #36: 普段は空なので、全部 0 のときはブロックごと畳んで場所を取らない
    var sec = document.getElementById("statsec");
    if (sec) sec.hidden = !st || allZero;
  }

  // #48: 検索中は「TODO ヒット/総数」で出す。畳んだり絞ったりして見えていない
  // カードで件数が水増しされないよう、表示中のカードだけで数える。
  function countsText(counts, cards, search){
    var all = counts || {};
    function n(k){
      var total = all[k] || 0;
      if (!search) return String(total);
      return cards.filter(function(c){ return c.col === k; }).length + "/" + total;
    }
    return "TODO " + n("todo") + " / DOING " + n("doing") + " / DONE " + n("done");
  }

  function renderSessions(sessions, nowMs){
    // #74: 相対時刻は nowBase（render が入れたもの）を使う。nowMs 引数は互換のため残す。
    void nowMs;
    var box = document.getElementById("sessions");
    box.innerHTML = "";
    if (!sessions.length) {
      empty(box, "\\u25A1", "<b>セッションなし</b> — pi が起動すると、各セッションの看板がここに並ぶよ");
      return;
    }
    var search = query !== "";
    sessions.forEach(function(s){
      var doing = (s.counts && s.counts.doing) || 0;
      var art = el("article", "sess" + (doing ? " doing" : ""));
      if (doing) art.setAttribute("aria-label", "DOING あり: " + s.name);
      // #48: 既定は全開。検索中は畳んでいても中身を見せる（ヒットを隠さない）。
      var expanded = (sessOpen[s.id] === undefined ? true : sessOpen[s.id]) || search;
      var cards = (s.cards || []).filter(function(c){
        return !search || String(c.text || "").toLowerCase().indexOf(query) >= 0;
      });
      var hd = el("header", "sess-hd");
      hd.title = "クリックで折りたたみ";
      // #49: 見た目だけでなくキーボードでも畳める（aria-expanded は実際の開閉状態）。
      hd.setAttribute("role", "button");
      hd.setAttribute("tabindex", "0");
      hd.setAttribute("aria-expanded", expanded ? "true" : "false");
      hd.appendChild(el("span", "caret", expanded ? "\\u25BE" : "\\u25B8"));
      var t = el("span", "sess-t");
      t.appendChild(el("span", null, s.name));
      if (s.isActive) t.appendChild(el("span", "badge on", "\\u25CF ACTIVE"));
      if (doing) t.appendChild(el("span", "badge db", "\\u25CF DOING " + doing));
      hd.appendChild(t);
      hd.appendChild(el("span", "sess-cwd", s.cwd || ""));
      var meta = el("span", "sess-meta");
      meta.textContent = countsText(s.counts, cards, search) + " ・ 更新 ";
      // #74: 相対時刻は専用の span。毎分の書き換えは tick() が textContent だけで行う。
      var mm = el("span", null);
      agoLive(s.updatedAt, mm);
      meta.appendChild(mm);
      meta.title = full(s.updatedAt);
      hd.appendChild(meta);
      // ヘッダ内の操作（ops / ボタン / リンク / 入力）は畳まない。click と keydown で共有。
      function toggle(e){
        var tgt = e && e.target;
        if (tgt && tgt.closest && (tgt.closest(".ops") || tgt.closest("button") || tgt.closest("a") || tgt.closest("input"))) return;
        sessOpen[s.id] = !(sessOpen[s.id] === undefined ? true : sessOpen[s.id]);
        persist();
        redraw();
      }
      hd.addEventListener("click", toggle);
      hd.addEventListener("keydown", function(e){
        var k = e && e.key;
        if (k !== "Enter" && k !== " " && k !== "Spacebar") return;
        if (e.preventDefault) e.preventDefault();
        toggle(e);
      });
      art.appendChild(hd);
      // #58: reason + way back. Without it the ctl switches below look like they work.
      // #67: the cap in force for THIS row, and a 再開 button for a limit halt — the
      // switch alone still cannot lift a halt (it lives in the extension process).
      var halt = haltText(s.halted, maxLoopsOf(s.modes && s.modes.session));
      if (halt) {
        var hb = el("div", "halt", halt);
        if (s.halted && s.halted.halted === "limit") {
          hb.appendChild(document.createTextNode(" "));
          hb.appendChild(resumeBtn(boardCtx("session", s.id)));
        }
        art.appendChild(hb);
      }
      if (!expanded) { box.appendChild(art); return; }
      var ctx = boardCtx("session", s.id);
      // #48: 検索してヒット 0 件のセッションは「該当なし」だけ出す（ヘッダは残す）。
      // それ以外は今までどおり。操作系は絞り込み前の全カードを見る。
      if (search && !cards.length) {
        art.appendChild(el("div", "sess-empty", "該当なし"));
      } else {
        art.appendChild(boardCtl(ctx, s.modes ? s.modes.session : null, s.cards || []));
        art.appendChild(board(cards, nowMs, ctx));
      }
      box.appendChild(art);
    });
  }

  function renderGlobal(g, nowMs, sid){
    var box = document.getElementById("global");
    box.innerHTML = "";
    var all = (g && g.cards) || [];
    var c = (g && g.counts) || {todo:0, doing:0, done:0};
    // #49: GLOBAL も検索で絞る。絞らないと SESSIONS だけ減って GLOBAL が残り、
    // ヒットしていないカードが検索結果に混ざる（実ブラウザ検証で発見）。
    var search = query !== "";
    var cards = all.filter(function(x){
      return !search || String(x.text || "").toLowerCase().indexOf(query) >= 0;
    });
    // #62: GLOBAL もセッション見出しと同じ操作感で畳める（既定は開。検索中は強制展開）。
    var gexpanded = gOpen || search;
    var head = el("div", "sess-hd");
    head.title = "クリックで折りたたみ";
    head.setAttribute("role", "button");
    head.setAttribute("tabindex", "0");
    head.setAttribute("aria-expanded", gexpanded ? "true" : "false");
    head.appendChild(el("span", "caret", gexpanded ? "\u25BE" : "\u25B8"));
    head.appendChild(el("span", "sess-cwd", countsText(c, cards, search) + " ・ 計 " + cards.length + " 枚"));
    box.appendChild(head);
    // ヘッダ内の操作は畳まない（セッション見出しと同じ除外）。
    function toggleGlobal(e){
      var tgt = e && e.target;
      if (tgt && tgt.closest && (tgt.closest(".ops") || tgt.closest("button") || tgt.closest("a") || tgt.closest("input"))) return;
      gOpen = !gOpen;
      persist();
      redraw();
    }
    head.addEventListener("click", toggleGlobal);
    head.addEventListener("keydown", function(e){
      var k = e && e.key;
      if (k !== "Enter" && k !== " " && k !== "Spacebar") return;
      if (e.preventDefault) e.preventDefault();
      toggleGlobal(e);
    });
    if (!gexpanded) return;
    // GLOBAL writes carry scope=global; the modes key still needs the active sid.
    // 操作系は従来どおり絞り込み前の全カード（サーバの件数）を見る。
    var ctx = boardCtx("global", sid, true);
    box.appendChild(boardCtl(ctx, g ? g.modes : null, all));
    if (!cards.length) {
      if (search) box.appendChild(el("div", "sess-empty", "該当なし"));
      else empty(box, "\\u25A1", "<b>GLOBAL 看板は空</b> — 全セッション共有のカードを置くとここに現れるよ");
      return;
    }
    box.appendChild(board(cards, nowMs, ctx));
  }

  function serveLeft(v, nowMs){
    if (v.permanent) return { text: "永久", cls: "ok" };
    // サーバが計算した expiresAt を最優先。古い payload 用に createdAt+7日へ fallback。
    var at = v.expiresAt ? new Date(v.expiresAt).getTime() : NaN;
    if (isNaN(at) && v.createdAt) at = new Date(v.createdAt).getTime() + 7 * 24 * 60 * 60 * 1000;
    if (isNaN(at)) return { text: "—", cls: "" };
    var s = Math.round((at - (nowMs != null ? nowMs : Date.now())) / 1000);
    if (s <= 0) return { text: "期限切れ", cls: "dead" };
    var d = Math.floor(s / 86400);
    if (d >= 1) return { text: "あと" + d + "日", cls: "" };
    var h = Math.floor(s / 3600);
    if (h >= 1) return { text: "あと" + h + "時間", cls: "" };
    return { text: "あと" + Math.max(1, Math.floor(s / 60)) + "分", cls: "" };
  }

  function renderServe(list, nowMs, sid){
    var box = document.getElementById("serve");
    box.innerHTML = "";
    if (!list.length) {
      empty(box, "\\u2192", "<b>serve なし</b> — エージェントが /serve でサーバーを立てると、URL がここに並ぶよ");
      return;
    }
    list.forEach(function(v){
      var gone = !v.exists;
      var row = el("div", "srv" + (gone ? " gone" : ""));
      if (v.title) row.appendChild(el("span", "n", v.title));
      var u = el("span", "u");
      var href = safeHref(v.url);
      if (href && !gone) {
        var a = el("a", null, v.url);
        a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer";
        u.appendChild(a);
      } else {
        u.appendChild(el("span", null, v.url));
      }
      u.appendChild(el("span", gone ? "badge gone" : "badge on", gone ? "\\u2715 消失" : "\\u25CF 配信中"));
      row.appendChild(u);
      row.appendChild(el("span", "p", v.path || ""));
      var left = serveLeft(v, nowMs);
      var x = el("span", "x" + (left.cls ? " " + left.cls : ""), left.text);
      x.title = v.permanent ? "永久（自動削除なし）" : (v.expiresAt ? "期限: " + full(v.expiresAt) : "createdAt が無いので期限なし");
      row.appendChild(x);
      var t = el("span", "t");
      agoLive(v.createdAt, t);
      t.title = full(v.createdAt);
      row.appendChild(t);
      // Serve has no per-entry process to stop: 停止 deregisters the URL, 削除 also
      // drops the served file (server unlinks regular files only, never a directory).
      var ops = el("span", "ops");
      var sctx = boardCtx("global", sid, true);
      // 永久トグル。変更は既存の /api/serve 経由（scope+sid が載る）。
      var perm = el("label", "permx");
      perm.title = "永久にする（自動削除なし）";
      var cb = el("input");
      cb.type = "checkbox";
      cb.checked = v.permanent === true;
      cb.addEventListener("change", function(){
        act("/api/serve", { action: "permanent", id: v.id, value: cb.checked ? "1" : "0" }, sctx);
      });
      perm.appendChild(cb);
      perm.appendChild(el("span", null, "永久"));
      row.appendChild(perm);
      ops.appendChild(btn(gone ? "登録解除" : "停止", gotTitle(gone), function(){
        act("/api/serve", { action: "remove", id: v.id }, sctx);
      }));
      // #66-security: no dashboard button deletes a file. A GET that unlinks is
      // exploitable from any page via <img src>, and this dashboard has no auth.
      // Deleting a served file is a local filesystem action, not a remote one.
      row.appendChild(ops);
      box.appendChild(row);
    });
  }

  function gotTitle(gone){
    return gone ? "消失した登録を一覧から消す" : "配信を止める（/serve/<id>/ が 404 になる）";
  }

  function render(d, nowMs){
    if (isEditing()) return; // #65: 編集中は描画しない（sig を進める判断は呼び出し元）
    nowBase = nowMs;
    // #74: 前回描いたスパンは DOM ごと捨てるので、台帳もここで捨てる（伸びない）。
    nowT = [];
    nowS = [];
    var activeSid = "";
    (d.sessions || []).forEach(function(s){ if (s.isActive && !activeSid) activeSid = s.id; });
    renderStats(d.stats);
    renderSessions(d.sessions || [], nowMs);
    renderGlobal(d.global, nowMs, activeSid);
    renderServe(d.serve || [], nowMs, activeSid);
    selectTab(activeTab); // a poll re-render must keep the tab the user picked
  }

  function setConn(ok, firstFail){
    var c = document.getElementById("conn");
    var b = document.getElementById("banner");
    c.className = ok ? "ok" : "bad";
    c.textContent = ok ? "接続中" : "再接続中";
    b.classList.toggle("on", !ok);
    if (!ok && firstFail) b.textContent = "サーバに接続できません" +
      (lastData ? "。前回の表示を維持しています…" : "。サーバが起動するのを待っています…");
}
  // A failed first fetch must not sit dark until the 5s tick. Retry fast, then back off.
  // 1s/2s/4s... capped at 30s; success resets to the normal 5s poll.
  var POLL_MS = 5000;
  var RETRY_MAX_MS = 30000;
  var fails = 0, timer = null;
  function nextDelay(){
    if (fails === 0) return POLL_MS;
    return Math.min(1000 * Math.pow(2, fails - 1), RETRY_MAX_MS);
  }
  function schedule(){
    clearTimeout(timer);
    timer = setTimeout(reload, nextDelay());
  }
  // #74: 分境界項は無い。データが変わらなければ sig も変わらない（相対時刻は
  // ticker が textContent を書き換える。毎分のフル再描画はそれで用済み）。
  // サーバの now は毎分変わる（#65 で分単位に丸め済み）ので、sig からは外す。
  // これを戻すと 1 分ごとにフル再描画が復活する。
  function sigOf(d){
    var c = Object.assign({}, d);
    delete c.now;
    return JSON.stringify(c);
  }
  // #74: 相対時刻は render を回さずにここで書き換える。nowBase は「このスパンを
  // 描いた瞬間の時刻」。tick() は nowBase と Date.now() の差が 1 分以上動いた時だけ
  // textContent を差し替える：DOM は部分的に動くが、#sessions の中身は差し替わらない。
  function agoLive(iso, node){
    var r = { el: node, at: iso ? new Date(iso).getTime() : NaN, base: nowBase, text: ago(iso, nowBase) };
    node.textContent = r.text;
    nowT.push(r);
  }
  // tick はテキストノードの値だけ差し替える（textContent 代入はノードを作り直すので、
  // 構造の変異として数えられてしまう。ここは文字の変異が正しい）。
  function setLive(r, text){
    if (text === r.text) return;
    var n = r.el.firstChild;
    if (n) n.nodeValue = text;
    else r.el.textContent = text;
    r.text = text;
  }
  // #74: 文字列で組み立てるのは、テストが .t の innerHTML で経過を検証しているため。
  // tick() はここで作った .since の文字だけを書き換え、⏳ の出し入れはしない
  // （データが次に変わった時に判定される。分粒度なので許容 — #74 の副作用）。
  function sinceLead(movedAt){
    var mins = Math.max(0, Math.floor((nowBase - movedAt) / 60000));
    var lead = nowBase - movedAt > STALE_GUI_MS
      ? '<span class="stale" title="' + mins + '\u5206\u524d\u304b\u3089 DOING">\u23f3</span>'
      : "";
    return lead + '<span class="since">' + mins + '\u5206\u524d\u304b\u3089</span>';
  }
  function sinceLive(movedAt, box){
    var si = box.querySelector ? box.querySelector(".since") : null;
    nowS.push({ el: si || box, at: movedAt, base: nowBase, text: si ? si.textContent : "",
      mins: Math.max(0, Math.floor((nowBase - movedAt) / 60000)) });
  }
  function tick(at){
    var now = at != null ? at : Date.now();
    // 位相を揃える: 次に textContent を差し替えるのは描画から 60 秒後（分境界ではない）。
    nowBase = now;
    for (var i = 0; i < nowT.length; i++) {
      var t = nowT[i];
      if (now - t.base < 60000) continue;
      setLive(t, isNaN(t.at) ? "\u2014" : ago(new Date(t.at).toISOString(), now));
    }
    for (var j = 0; j < nowS.length; j++) {
      var r = nowS[j];
      if (now - r.base < 60000) continue;
      var mins = Math.max(r.mins, Math.floor((now - r.at) / 60000));
      setLive(r, mins + "\u5206\u524d\u304b\u3089");
    }
  }
  // #48: 開閉・検索語を変えたら即描画。sig も更新するので、次のポーリングが
  // 「同じ sig」で描画をスキップしても画面と sig が食い違わない。
  function redraw(){
    if (!lastData) return;
    if (isEditing()) return; // #65: render() は何もしないので、sig だけ進めてはいけない
    paint();
  }
  // #74: 描画の基準時刻はサーバの now（分丸め済み）。テストは固定の now を送って
  // 相対時刻を検証するので、ここは d.now を優先する。sigOf は now を外しているので、
  // この値を描画に使っても毎分のフル再描画は起きない。
  function baseOf(d){
    var t = d && d.now ? new Date(d.now).getTime() : NaN;
    return isNaN(t) ? Date.now() : t;
  }
  // #74: sig を進めるのはここだけ。redraw()/reload() の両方が呼ぶ。
  function paint(){
    var d = lastData;
    var nowMs = baseOf(d);
    sig = sigOf(d) + uiSig();
    render(d, nowMs);
    tick(nowMs); // 描いた瞬間に揃える。次の ticker はちょうど +60 秒
  }
  function reload(){
    api(API).then(function(d){
      if (!d || typeof d !== "object") throw new Error("bad payload");
      lastData = d;
      setConn(true);
      fails = 0;
      // #74: データが変わっていなくても、時刻 ticker の位相はここで揃え直す
      // （render はしない。DOM は触らない。分丸め済みの now ではなく実時刻で進める）。
      var s = sigOf(d) + uiSig();
      if (s === sig) { tick(baseOf(d)); return; }
      // #65: 編集中で描画を見送ったら sig は進めない。次に編集が終わったポーリングで
      // 「変わっていない」と誤判定され、永久に再描画されなくなるため。
      if (isEditing()) return;
      paint();
    }).catch(function(){
      fails += 1;
      // keep lastData on screen; just flag the reconnect state
      setConn(false, !document.getElementById("banner").classList.contains("on"));
      if (!lastData) {
        // never got any data: draw the empty states instead of blank sections
        renderStats(null); renderSessions([], null); renderGlobal(null, null); renderServe([], null);
      }
    }).then(schedule);
  }
  // #48: 入力のたびに再描画（fetch はしない。lastData を使い回す）
  var qEl = document.getElementById("q");
  if (qEl) qEl.addEventListener("input", function(){
    query = qEl.value.trim().toLowerCase();
    redraw();
  });
  reload();
  // #74: 相対時刻の ticker は新しい setInterval ではなく既存のポーリングに乗る。
  // reload() の「sig が変わらない」分岐が tick() を呼ぶので、通信も再描画も増やさず
  // （通信は既存の 1 本のまま）、span の文字だけが分粒度で動く。
})();
</script>
<script>
(function(){
  // theme toggle: click -> opposite theme + explicit pick in localStorage (kb-theme);
  // while no explicit pick exists, live-updates with the OS color-scheme.
  var btn = document.getElementById("theme");
  var pick = false;
  try { pick = localStorage.getItem("kb-theme") != null; } catch (e) {}
  function label(){ return document.documentElement.dataset.theme === "light" ? "ダークテーマに切り替え" : "ライトテーマに切り替え"; }
  function refreshLabel(){ var l = label(); btn.setAttribute("aria-label", l); btn.title = l; }
  function setTheme(t, save){
    document.documentElement.setAttribute("data-theme", t);
    if (save) { pick = true; try { localStorage.setItem("kb-theme", t); } catch (e) {} }
    refreshLabel();
  }
  btn.addEventListener("click", function(){
    setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light", true);
  });
  if (window.matchMedia) {
    var mq = matchMedia("(prefers-color-scheme: light)");
    var onChange = function(){ if (!pick) setTheme(mq.matches ? "light" : "dark", false); };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }
  refreshLabel();
})();
</script>
</body>
</html>
`.replace(/__KB_HOST__/g, hostname);

// ---------------------------------------------------------------------------
// Extension body
// ---------------------------------------------------------------------------

export default function kanbanExtension(pi: ExtensionAPI) {
	// First session in the process starts the server; the rest reuse it.
	ensureServer();

	// Auto-loop state for THIS session. One closure per session, so this never
	// bleeds across sessions; the entry below is what survives a reload.
	let loop: LoopState = { count: 0, halted: null, scope: null, stuckId: null, stuckCount: 0, lastActivityAt: 0 };
	// Auto-tick state for THIS session: module scope made siblings share one 5-minute
	// window. lastTickAt = 0 means "never fired", so a fresh loop ON fires next poll.
	let lastTickAt = 0;
	let tickInFlight = false;
	// True only while a /kanban dialog is on screen: a menu must never be talked over.
	const uiGuard = { menuOpen: false };

	const persistLoop = (): void => {
		pi.appendEntry(LOOP_CUSTOM_TYPE, loop);
	};

	/**
	 * Every sign of life on this session. `agent_before_settle` deliberately does NOT
	 * call this: stamping "now" just before the quiet check would make it never quiet.
	 *
	 * Only `turn_start` stamps it. Measured on pi 1.2.0: the agent loop emits `turn_start`
	 * once per LLM request (1 + tool rounds per user turn), and `context_with_system`
	 * fires at exactly the same points, so a second stamp there was pure redundancy.
	 */
	const noteActivity = (): void => {
		loop.lastActivityAt = Date.now();
	};
	pi.on("turn_start", () => {
		noteActivity();
	});

	/** The last kanban-loop entry on this branch wins: it is the count the footer shows. */
	const restoreLoop = (ctx: ExtensionContext): void => {
		loop = { count: 0, halted: null, scope: null, stuckId: null, stuckCount: 0, lastActivityAt: 0 };
		try {
			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type !== "custom" || entry.customType !== LOOP_CUSTOM_TYPE) continue;
				const d = (entry.data ?? {}) as Partial<LoopState>;
				loop = {
					count: typeof d.count === "number" ? d.count : 0,
					halted: d.halted === "limit" || d.halted === "stuck" ? d.halted : null,
					scope: d.scope === "global" || d.scope === "session" ? d.scope : null,
					stuckId: typeof d.stuckId === "number" ? d.stuckId : null,
					stuckCount: typeof d.stuckCount === "number" ? d.stuckCount : 0,
					lastActivityAt: typeof d.lastActivityAt === "number" ? d.lastActivityAt : 0,
				};
			}
		} catch {
			// unreadable entries -> fresh state; a loop must never crash the session
		}
	};

	const statusText = (m: ModePair, l: LoopState, scope: Scope): string => {
		// #67: the cap is per (scope, sid) now; the footer shows the one that is in force.
		const cap = maxLoopsOf(m);
		// #38-12: the footer says WHY it stopped, not only that it did.
		const halt = ` /${haltTag(l)}`;
		return `[${scope}] doingLoop ${m.doingLoop ? "ON" : "OFF"} / autoPick ${m.autoPick ? "ON" : "OFF"} / ${loopBudgetText(cap, l.count)}${halt}`;
	};

	/** Set this session's footer tag, then redraw (the tag lives on the driving board's line). */
	const paintLoop = (ctx: ExtensionContext, sid: string): void => {
		const scope = loop.scope ?? "session";
		const tag = haltTag(loop);
		// One settle drives one board: leaving a tag on the other line would be a lie.
		for (const s of ["session", "global"] as const) {
			setLoopTag(sid, s, s === scope ? tag : "");
			loopCount.delete(tagKey(sid, s));
		}
		// Only the count is published; modeTags turns it into "3/10" against the cap it
		// reads at draw time, so the footer can never show a cap the file no longer has.
		if (loop.count > 0) loopCount.set(tagKey(sid, scope), loop.count);
		// Same value the footer shows, published for the HTTP dashboard (see haltedBySid).
		if (loop.halted === null) haltedBySid.delete(sid);
		else {
			const cap = maxLoopsOf(modesFor(readModesFile({ repair: false }), sid, scope));
			haltedBySid.set(sid, { halted: loop.halted, stuckId: loop.stuckId, stuckCount: loop.stuckCount, cap });
		}
		refresh(ctx, sid);
	};

	/**
	 * Clear the halt and give the loop its budget back. Both doingLoop switches go ON
	 * because turning them off is what caused a `limit` halt; a `stuck` halt is lifted
	 * too, since a resume is the user saying "try again". Shared by `/kanban loop on`
	 * and the `kanban` tool's resume so the two can never drift.
	 */
	const resetLoopForResume = (): { was: string; oldCount: number } => {
		const was = loop.halted === null ? "なし" : `halted:${loop.halted}`;
		const oldCount = loop.count;
		loop = { count: 0, halted: null, scope: null, stuckId: null, stuckCount: 0, lastActivityAt: 0 };
		lastTickAt = 0; // resume must fire on the next poll, not after the interval
		pollSnapshot = null; // force the next poll to redraw
		warnedDeadCtx = false;
		deadCtxStrikes = 0;
		persistLoop();
		return { was, oldCount };
	};

	/**
	 * #67: the one resume. resetLoopForResume alone is not a resume — the cap achieved its
	 * stop by switching BOTH scopes' doingLoop off, so lifting the halt while they stay off
	 * would resume a loop that still cannot run. Shared by `/kanban loop on`, the `kanban`
	 * tool's resume and the dashboard's 再開 (via /api/resume -> resumeRequests).
	 */
	const resumeWithModes = (ctx: ExtensionContext, sid: string): { was: string; oldCount: number } => {
		const before = resetLoopForResume();
		const f = readModesFile();
		setMode(f, sid, "session", "doingLoop", true);
		setMode(f, sid, "global", "doingLoop", true);
		writeModesFile(f);
		paintLoop(ctx, sid); // clears the footer tag and the dashboard's halted row
		return before;
	};

	/**
	 * `/kanban loop on|off|status` and `/kanban pick on|off`. `loop on` is also the
	 * reset: a halted loop restarts only when the user asks for it.
	 */
	const runModeCommand = (ctx: ExtensionContext, sid: string, scope: Scope, key: SwitchKey, sub: string | undefined): void => {
		if (sub !== undefined && sub !== "on" && sub !== "off" && sub !== "status") {
			ctx.ui.notify("使い方: /kanban loop on|off|status [session|global] / /kanban pick on|off");
			return;
		}
		const f = readModesFile();
		if (sub === "on" || sub === "off") {
			// modes entry <=> board file: never leave a modes entry without its board.
			ensureSessionBoard(sid);
			setMode(f, sid, scope, key, sub === "on");
			writeModesFile(f);
			// Only `loop` owns the budget and the halt: `pick` must not clear a LOOP HALTED banner.
			if (key === "doingLoop") resetLoopForResume();
		}
		ctx.ui.notify(statusText(modesFor(readModesFile(), sid, scope), loop, scope));
		paintLoop(ctx, sid);
	};

	/** `/kanban interval [global] [分]`: no value = show, invalid = reject without writing. */
	const runIntervalCommand = (ctx: ExtensionContext, sid: string, scope: Scope, minutes: number | undefined): void => {
		const f = readModesFile(); // writes back a corrupt file once; the poll uses the read-only form
		if (minutes === undefined) {
			ctx.ui.notify(`[${scope}] 自動再開の間隔: ${intervalMinOf(modesFor(f, sid, scope))}分`);
			return;
		}
		if (!Number.isFinite(minutes) || minutes <= 0) {
			ctx.ui.notify(`不正な値: ${minutes}。現状維持（0より大きい分数を指定）`);
			return;
		}
		ensureSessionBoard(sid);
		setIntervalMin(f, sid, scope, minutes);
		writeModesFile(f);
		lastTickAt = 0; // a shorter interval applies now, not after the old one elapses
		ctx.ui.notify(`[${scope}] 自動再開の間隔を ${minutes}分 に設定`);
		refresh(ctx, sid);
	};

	/** `/kanban stuck [global] [回]`: no value = show, invalid = reject without writing. */
	const runStuckCommand = (ctx: ExtensionContext, sid: string, scope: Scope, count: number | undefined): void => {
		const f = readModesFile();
		if (count === undefined) {
			ctx.ui.notify(`[${scope}] スタック判定: ${stuckLimitOf(modesFor(f, sid, scope))}回`);
			return;
		}
		if (!isValidStuckLimit(count)) {
			ctx.ui.notify(`不正な値: ${count}。現状維持（1〜${MAX_STUCK_LIMIT}の整数を指定）`);
			return;
		}
		ensureSessionBoard(sid);
		setStuckLimit(f, sid, scope, count);
		writeModesFile(f);
		ctx.ui.notify(`[${scope}] スタック判定を ${count}回 に設定`);
		refresh(ctx, sid);
	};

	/** #67: `/kanban maxloops [global] [回]`。0 = 無制限。無指定で現在値。stuck と同じ形。 */
	const runMaxLoopsCommand = (ctx: ExtensionContext, sid: string, scope: Scope, n: number | undefined): void => {
		const f = readModesFile();
		if (n === undefined) {
			const cur = maxLoopsOf(modesFor(f, sid, scope));
			ctx.ui.notify(`[${scope}] ループ上限: ${cur > 0 ? `${cur}回` : "無制限"}`);
			return;
		}
		if (!isValidMaxLoops(n)) {
			ctx.ui.notify(`不正な値: ${n}。現状維持（0〜${MAX_LOOPS_CAP}の整数、0 = 無制限）`);
			return;
		}
		ensureSessionBoard(sid);
		setMaxLoops(f, sid, scope, n);
		writeModesFile(f);
		ctx.ui.notify(`[${scope}] ループ上限を ${n > 0 ? `${n}回` : "無制限"} に設定`);
		refresh(ctx, sid);
	};

	/**
	 * `/kanban img <id> <path>`: copy a local image into media/ and point the card at
	 * it, the same shape /api/upload writes (basename in `img`, bytes under MEDIA_DIR).
	 * Every validation runs before the first write: missing / unreadable / not an image /
	 * over 8MB only notifies, so the board can never gain a broken image path.
	 */
	const runImgCommand = (ctx: ExtensionContext, sid: string, id: number, input: string): void => {
		const path = boardPath("session", sid);
		const b = readBoard(path);
		const card = b.cards.find((c) => c.id === id);
		if (card === undefined) {
			ctx.ui.notify(`その id は無い: #${id}（session）`);
			return;
		}
		const sized = input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
		const abs = resolve(sized === "~" ? homedir() : sized);
		const dot = abs.lastIndexOf(".");
		const ext = dot < 0 ? "" : abs.slice(dot + 1).toLowerCase();
		if (!(MIME_BY_EXT[ext] ?? "").startsWith("image/")) {
			ctx.ui.notify(`画像ではない（${ext === "" ? "拡張子無し" : `.${ext}`}）: ${abs}`);
			return;
		}
		let st: Stats;
		try {
			st = statSync(abs);
		} catch {
			ctx.ui.notify(`ファイルが無い / 読めない: ${abs}`);
			return;
		}
		if (!st.isFile()) {
			ctx.ui.notify(`ファイルが無い / 読めない（通常ファイルではない）: ${abs}`);
			return;
		}
		if (st.size > MAX_UPLOAD) {
			ctx.ui.notify(`大きすぎる（上限 ${fmtMB(MAX_UPLOAD)}）: ${abs}`);
			return;
		}
		let bytes: Buffer;
		try {
			bytes = readFileSync(abs);
		} catch {
			ctx.ui.notify(`ファイルが無い / 読めない: ${abs}`);
			return;
		}
		removeMedia(card); // replacing media drops the old file
		const name = writeMedia(card.id, ext, bytes);
		if (name === null) {
			ctx.ui.notify("media への書き込みに失敗");
			return;
		}
		card.img = name;
		writeBoard(path, b);
		ctx.ui.notify(`#${card.id} に画像を添付: ${basename(abs)}（session）`);
		refresh(ctx, sid);
	};

	/**
	 * `/kanban priority [id] [n]` on one board: no id = the TODO order autoPick would use,
	 * id only = that card's value, both = write. Unknown id and bad value write nothing.
	 */
	const runPriorityCommand = (
		ctx: ExtensionContext,
		sid: string,
		scope: Scope,
		id: number | undefined,
		value: number | undefined,
	): void => {
		const path = boardPath(scope, sid);
		const b = readBoard(path);
		if (id === undefined) {
			const list = orderTodos(cardsIn(b, "todo"));
			ctx.ui.notify(
				list.length === 0
					? `[${scope}] TODO は空`
					: `[${scope}] TODO（優先度順）\n${list.map(formatPriorityCard).join("\n")}`,
			);
			return;
		}
		const card = b.cards.find((c) => c.id === id);
		if (card === undefined) {
			ctx.ui.notify(`その id は無い: #${id}（${scope}）`);
			return;
		}
		if (value === undefined) {
			ctx.ui.notify(`#${card.id} 優先度: ${priorityOf(card)}（${scope}）`);
			return;
		}
		if (!isValidPriority(value)) {
			ctx.ui.notify(`不正な値: ${value}。現状維持（${MIN_PRIORITY}〜${MAX_PRIORITY}の整数を指定）`);
			return;
		}
		// 0 is the default: drop the key instead of storing an explicit 0.
		if (value === 0) delete card.priority;
		else card.priority = value;
		writeBoard(path, b);
		ctx.ui.notify(`#${card.id} 優先度を ${value} に設定（${scope}）`);
		refresh(ctx, sid);
	};

	// The boards are the sync point: the GUI and sibling sessions write them
	// without reaching this extension, so poll both layers and redraw only on
	// change. Declared here (once per session) so timers/snapshots cannot leak
	// across sessions.
	let pollTimer: NodeJS.Timeout | null = null;
	// The session this closure drives: the FIRST one to `session_start` here, not the
	// newest. Several sessions share one process (subagents included); adopting the
	// newest made poll() read a sibling's board and go silent.
	let ownCtx: ExtensionContext | null = null;
	let pollSnapshot: string | null = null;
	// Dead-ctx guard: warn once, and stop the timer after two consecutive throws.
	let warnedDeadCtx = false;
	let deadCtxStrikes = 0;

	/**
	 * The session id is the session file's identity, stable across tree
	 * navigation. getLeafId() is not used: it changes on every branch move, which
	 * would split the board into a new file mid-conversation.
	 */
	const sidOf = (ctx: ExtensionContext): string =>
		ctx.sessionManager.getSessionId();
	// #40: sidOf must stay pure. It used to assign activeSessionId on every call,
	// so any other session's session_start (subagents too) dragged the panel's
	// default sid over to that session. The default is now set once, where ownCtx
	// is adopted.

	/** Raw bytes of every board layer plus modes.json; any disk change (ours or a sibling's) flips it. */
	const diskSnapshot = (sessionId: string): string =>
		`${readRaw(boardPath("session", sessionId))}\u0000${readRaw(GLOBAL_JSON)}\u0000${readRaw(MODES_JSON)}`;

	/** Stop the timer and release the owned ctx (session end, or a ctx that cannot answer). */
	const stopPoll = (): void => {
		if (pollTimer !== null) clearInterval(pollTimer);
		pollTimer = null;
		ownCtx = null;
	};

	/**
	 * A disposed runner makes every ctx accessor throw (assertActive), `isIdle()` included.
	 * Warn once, and after two consecutive throws release ownCtx and stop the timer: the ctx
	 * cannot be revived here, so the next session_start adopts instead of throwing forever.
	 */
	const deadCtx = (err: unknown): void => {
		deadCtxStrikes += 1;
		if (!warnedDeadCtx) {
			warnedDeadCtx = true;
			process.stderr.write(`kanban: poll ctx unavailable (${deadCtxStrikes}): ${(err as Error).message}\n`);
		}
		if (deadCtxStrikes >= 2) stopPoll();
	};

	const poll = (): void => {
		sweepServeThrottled(); // 1 時間に 1 回だけ実際に走る
		// #46: a restart that never delivers session_start leaves ownCtx null and this
		// tick returns silently. That is the one case the trace below cannot show.
		if (ownCtx === null) {
			if (pollDebugEnabled()) process.stderr.write("kanban: poll => skip:no-ctx\n");
			return;
		}
		let sid: string;
		try {
			sid = sidOf(ownCtx);
		} catch (err) {
			deadCtx(err); // disposed ctx: skip this tick
			return;
		}
		// #67: the dashboard's 再開 lands here. The request is a token, so one poll tick
		// consumes it: a stale request can never resume twice, and a resume for a session
		// whose process is gone simply stays parked.
		if (resumeRequests.delete(sid)) {
			try {
				resumeWithModes(ownCtx, sid);
				logServer(`resume from dashboard sid=${sid}`);
			} catch (err) {
				deadCtx(err);
			}
		}
		// Before the snapshot shortcut: time passes even when no board file changes,
		// so a still board would never wake the agent.
		if (!tickInFlight) {
			const f = readModesFile({ repair: false }); // 1.5s cadence: never rewrite here
			for (const scope of ["session", "global"] as const) {
				// Read the switch first: with doingLoop off this costs one
				// modes.json read per poll and no board reads at all.
				const m = modesFor(f, sid, scope);
				const cards = m.doingLoop ? readBoard(boardPath(scope, sid)).cards : [];
				// Phase 10: DOING empty + autoPick ON wakes on the first TODO instead of
				// staying silent forever. The wake only asks for the move; the board is never
				// written here (pickFirstTodo runs in the settle that follows this turn).
				const card = m.doingLoop
					? (tickCardFor(cards, scope, sid) ?? (m.autoPick ? nextTodo(cards, scope, sid) : undefined))
					: undefined;
				let isIdle: boolean | null = null; // null = not asked (no card to wake for)
				if (card !== undefined) {
					try {
						isIdle = ownCtx.isIdle(); // outside shouldAutoTick so a throw skips one tick
						deadCtxStrikes = 0; // a ctx that just answered is not dead
					} catch (err) {
						deadCtx(err);
						return;
					}
				}
				const now = Date.now();
				const v = autoTickVerdict({
					isIdle: isIdle === true,
					doingLoop: m.doingLoop,
					card,
					halted: loop.halted,
					lastTickAt,
					// undefined (never active) stays undefined: 0 would read as "long ago".
					lastActivityAt: loop.lastActivityAt || undefined,
					now,
					intervalMs: intervalMsOf(m),
					menuOpen: uiGuard.menuOpen,
				});
				if (pollDebugEnabled()) {
					const why = v.fire ? "fire" : `skip:${v.reason}`;
					process.stderr.write(
						`kanban: poll sid=${sid} idle=${isIdle ?? "n/a"} doingLoop=${m.doingLoop} card=${card?.id ?? "null"} halted=${loop.halted ?? "null"} sinceLastTick=${now - lastTickAt} quiet=${v.quiet} => ${why}\n`,
					);
				}
				if (!v.fire) continue;
				if (card === undefined) continue; // v.fire implies a card; this only narrows for TS
				// Set and cleared inside one synchronous block, so this is effectively dead today:
				// sendUserMessage does not re-enter poll(). It guards the day it starts to, and the
				// `/kanban take` handler reads it to refuse a switch mid-wake.
				tickInFlight = true;
				lastTickAt = now;
				try {
					// The declared return is void, but every runtime hands back a promise: without
					// a catch, a rejected wake ("Agent is already processing...") vanished.
					void Promise.resolve(pi.sendUserMessage(continuationPrompt(card, scope)) as unknown).catch(
						(err: unknown) => logServer(`wake rejected: ${err instanceof Error ? err.message : String(err)}`),
					);
					// firedFor goes in AFTER the dispatch returned: a throw leaves the schedule
					// unfired so the next settle retries, instead of going silent forever.
					// A failed writeBoard here only buys one extra wake - loud beats a hole.
					markFired(card, sid, scope);
				} catch (err) {
					// A throw out of a setInterval callback reaches uncaughtException: log it and
					// let the next interval try again instead of taking the process down.
					const e = err as Error;
					process.stderr.write(`kanban: auto-tick failed: ${e.message}\n`);
				} finally {
					tickInFlight = false;
				}
				break; // one wake per poll: the next scope waits for the next interval
			}
		}
		const snap = diskSnapshot(sid);
		if (snap === pollSnapshot) return; // unchanged -> no setWidget, keeps the SSE quiet
		pollSnapshot = snap;
		try {
			refresh(ownCtx, sid);
		} catch (err) {
			deadCtx(err); // setWidget on a disposed ctx must not kill the interval
		}
	};

	// Mode A: select/input drilldown. `scope` picks the layer this run edits.
	pi.registerCommand("kanban", {
		description: "Open a kanban board (select/input drilldown)",
		handler: async (args, ctx) => {
			const sid = sidOf(ctx);
			const parsed = parseKanbanArgs((args ?? "").trim().split(/\s+/).filter((w) => w.length > 0));
			if (parsed.kind === "help") {
				ctx.ui.notify(KANBAN_HELP);
				return;
			}
			if (parsed.kind === "reject") {
				ctx.ui.notify(parsed.reason);
				return;
			}
			if (parsed.kind === "take") {
				// #40: ownCtx is the FIRST session_start in this process; a session opened later
				// would never drive the loop. This is the explicit handover. The handler's ctx is
				// by definition the live one for this session, so no liveness probe is needed.
				if (tickInFlight) {
					ctx.ui.notify("kanban: ループ実行中。1回待ってから再実行して");
					return;
				}
				const prev = ownCtx === null ? null : sidOf(ownCtx);
				ownCtx = ctx;
				activeSessionId = sid;
				lastTickAt = 0; // judge immediately in the new session, not after the interval
				pollSnapshot = null; // force the next poll to redraw
				warnedDeadCtx = false;
				deadCtxStrikes = 0;
				// loop is process state, not per-session: only clear the stop condition and the
				// activity clock, so the previous owner's quiet window cannot block the new one.
				loop.halted = null;
				loop.lastActivityAt = 0;
				ctx.ui.notify(`kanban: 駆動元を ${prev ?? "なし"} → ${sid} に切り替えた`);
				return;
			}
			if (parsed.kind === "mode" || parsed.kind === "modeStatus") {
				runModeCommand(ctx, sid, parsed.scope ?? "session", parsed.key, parsed.kind === "mode" ? (parsed.value ? "on" : "off") : "status");
				return;
			}
			if (parsed.kind === "interval" || parsed.kind === "intervalStatus") {
				runIntervalCommand(ctx, sid, parsed.scope, parsed.kind === "interval" ? parsed.minutes : undefined);
				return;
			}
			if (parsed.kind === "maxLoops" || parsed.kind === "maxLoopsStatus") {
				runMaxLoopsCommand(ctx, sid, parsed.scope, parsed.kind === "maxLoops" ? parsed.n : undefined);
				return;
			}
			if (parsed.kind === "stuck" || parsed.kind === "stuckStatus") {
				runStuckCommand(ctx, sid, parsed.scope, parsed.kind === "stuck" ? parsed.count : undefined);
				return;
			}
			if (parsed.kind === "priority") {
				// Priority is a card's business: the id belongs to this conversation's board.
				runPriorityCommand(ctx, sid, "session", parsed.id, parsed.value);
				return;
			}
			if (parsed.kind === "img") {
				// Same rule as priority: card ids only exist on this conversation's board.
				runImgCommand(ctx, sid, parsed.id, parsed.path);
				return;
			}
			if (parsed.kind === "add") {
				// scope is always the session board (m00987: the card belongs to this conversation).
				const path = boardPath("session", sid);
				const b = readBoard(path);
				const card: Card = { id: b.nextId++, text: parsed.text, col: "todo" };
				stampMove(card, sid);
				b.cards.push(card);
				writeBoard(path, b);
				ctx.ui.notify(`SESSION TODO に追加: ${formatCard(card)}`);
				refresh(ctx, sid);
				return;
			}
			let scope: Scope = "session";
			refresh(ctx, sid);
			const guiOption = "🖥 ダッシュボードの URL";
			// Every dialog of this drilldown runs under the guard, so auto-tick stays off
			// while the user is reading a menu (A3). withMenuGuard clears it in `finally`.
			return withMenuGuard(uiGuard, async () => {
			for (;;) {
				const current = readBoard(boardPath(scope, sid));
				const colOptions = COLS.map((c) => `${LABELS[c].trim()} (${cardsIn(current, c).length})`);
				const switchOption = scope === "session" ? "🌐 グローバル看板へ" : "📋 セッション看板へ";
				// One row in the BOARD menu; the two toggles live one level down so the
				// column list below keeps its shape. sid is always this session, scope is
				// the board the user is looking at.
				const cur = modesFor(readModesFile(), sid, scope);
				const modeOption = `⚙ loop: ${cur.doingLoop ? "ON" : "OFF"} / pick: ${cur.autoPick ? "ON" : "OFF"}`;
				const intervalOption = `⏱ 間隔: ${intervalMinOf(cur)}分`;
				const stuckOption = `🚧 スタック判定: ${stuckLimitOf(cur)}回`;
				const priorityOption = "🎯 優先度";
				const picked = await ctx.ui.select(`ボード (${scope}): どの列を開く？`, [
					guiOption,
					switchOption,
					modeOption,
					intervalOption,
					stuckOption,
					priorityOption,
					...colOptions,
					"終了",
				]);
				if (picked === undefined || picked === "終了") return;
				if (picked === guiOption) {
					ctx.ui.notify(`ダッシュボード: http://${hostname()}:${PORT}/`);
					continue;
				}
				if (picked === switchOption) {
					scope = scope === "session" ? "global" : "session";
					continue;
				}
				if (picked === modeOption) {
					for (;;) {
						const m = modesFor(readModesFile(), sid, scope);
						const choice = await ctx.ui.select(`モード (${scope}): どれを切り替える？`, [
							`loop: ${m.doingLoop ? "ON" : "OFF"}`,
							`pick: ${m.autoPick ? "ON" : "OFF"}`,
							"← 戻る",
						]);
						if (choice === undefined) return;
						if (choice === "← 戻る") break;
						const isLoop = choice.startsWith("loop:");
						const on = isLoop ? m.doingLoop : m.autoPick;
						// runModeCommand repaints the footer; the next loop re-reads the label.
						runModeCommand(ctx, sid, scope, isLoop ? "doingLoop" : "autoPick", on ? "off" : "on");
					}
					continue;
				}
				if (picked === intervalOption) {
					const raw = await ctx.ui.input(`自動再開の間隔（${scope}、分）`, String(intervalMinOf(cur)));
					// undefined = cancel; an empty/odd value falls through to the validator,
					// which rejects it and leaves the current interval alone.
					if (raw !== undefined) runIntervalCommand(ctx, sid, scope, raw.trim() === "" ? 0 : Number(raw));
					continue;
				}
				if (picked === stuckOption) {
					const raw = await ctx.ui.input(`スタック判定（${scope}、回）`, String(stuckLimitOf(cur)));
					// undefined = cancel; a bogus value is rejected by runStuckCommand.
					if (raw !== undefined) runStuckCommand(ctx, sid, scope, raw.trim() === "" ? 0 : Number(raw));
					continue;
				}
				if (picked === priorityOption) {
					// One row per TODO card, same one-line style as formatPriorityCard.
					const todos = orderTodos(cardsIn(readBoard(boardPath(scope, sid)), "todo"));
					if (todos.length === 0) {
						ctx.ui.notify(`[${scope}] TODO は空`);
						continue;
					}
					const target = await ctx.ui.select(
						`優先度を変えるカード (${scope})`,
						todos.map(formatPriorityCard),
					);
					if (target === undefined) continue;
					const chosen = todos.find((c) => formatPriorityCard(c) === target);
					if (chosen === undefined) continue;
					const raw = await ctx.ui.input(
						`#${chosen.id} の優先度（${MIN_PRIORITY}〜${MAX_PRIORITY}、大きいほど先）`,
						String(priorityOf(chosen)),
					);
					// undefined = cancel; a bogus value is rejected by runPriorityCommand.
					if (raw !== undefined) runPriorityCommand(ctx, sid, scope, chosen.id, raw.trim() === "" ? 0 : Number(raw));
					continue;
				}
				const col = COLS[colOptions.indexOf(picked)];
				if (col === undefined) return;

				for (;;) {
					// Re-read every iteration so GUI edits show up mid-drilldown.
					const b = readBoard(boardPath(scope, sid));
					const inCol = cardsIn(b, col);
					const choice = await ctx.ui.select(`${LABELS[col].trim()} (${inCol.length})`, [
						...inCol.map(formatCard),
						"＋ 新規カード",
						"← 列選択に戻る",
					]);
					if (choice === undefined) return;
					if (choice === "← 列選択に戻る") break;

					if (choice === "＋ 新規カード") {
						const text = await ctx.ui.input("カードの内容は？");
						if (text === undefined) return;
						const trimmed = text.trim();
						if (trimmed.length > 0) {
							const card: Card = { id: b.nextId++, text: trimmed, col };
							stampMove(card, sid);
							b.cards.push(card);
							writeBoard(boardPath(scope, sid), b);
						}
						refresh(ctx, sid);
						continue;
					}

					const card = inCol.find((c) => formatCard(c) === choice);
					if (card === undefined) continue;

					const op = await ctx.ui.select(`#${card.id} ${card.text}`, [
						"TODO へ移動",
						"DOING へ移動",
						"DONE へ移動",
						"削除",
						"← 列選択に戻る",
					]);
					if (op === undefined) return;
					if (op === "← 列選択に戻る") continue;
					if (op === "削除") {
						removeMedia(card); // the `kanban` tool already drops the image; keep the paths symmetric
						b.cards = b.cards.filter((c) => c.id !== card.id);
					} else {
						card.col = COLS[["TODO へ移動", "DOING へ移動", "DONE へ移動"].indexOf(op)];
						stampMove(card, sid);
					}
					writeBoard(boardPath(scope, sid), b);
					refresh(ctx, sid);
				}
			}
			});
		},
	});

	// Mode B: model-facing CRUD + permanent widget.
	pi.registerTool({
		name: "kanban",
		label: "Kanban board",
		description:
			"Manage a 3-column kanban board (todo/doing/done). action=list shows the board, add creates a card, move changes its column, remove deletes it, check runs the board/serve/media/modes self-test and returns its JSON, resume clears a doing-loop halt (same reset as /kanban loop on: budget back to 10, doingLoop ON in both scopes) — the GUI's loop switch cannot clear it, because the halt lives in the extension process, not in modes.json. scope selects the board: 'session' (default, this conversation's board) or 'global' (shared by every session). Card IDs are unique only within one board — global #7 and session #7 are different cards. The board is shared with the user's GUI and persisted under ~/.pi/kanban/.",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("list"),
				Type.Literal("add"),
				Type.Literal("move"),
				Type.Literal("remove"),
				Type.Literal("check"),
				Type.Literal("resume"),
			]),
			scope: Type.Optional(Type.Union([Type.Literal("session"), Type.Literal("global")])),
			text: Type.Optional(Type.String()),
			id: Type.Optional(Type.Number()),
			col: Type.Optional(
				Type.Union([Type.Literal("todo"), Type.Literal("doing"), Type.Literal("done")]),
			),
			// Same fields as the card editor: the agent must be able to arm a card too.
			// nextFireAt takes ISO 8601 or +90m/+3h/+1d; it is resolved to absolute
			// before saving. "" clears either field.
			nextFireAt: Type.Optional(Type.String()),
			blocked: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const scope: Scope = params.scope ?? "session";
			const sid = sidOf(ctx);
			const path = boardPath(scope, sid);
			const b = readBoard(path);
			let persistError: string | null = null;
			const done = (text: string) => ({
				content: [{ type: "text" as const, text }],
				details: {
					scope,
					cards: [...b.cards],
					nextId: b.nextId,
					...(persistError === null ? {} : { persistError }),
				},
			});
			const fail = (text: string) => ({ ...done(text), isError: true });

			/** blocked/nextFireAt on a card; returns an error message or null. */
			const applyGate = (card: Card): string | null => {
				if (params.blocked !== undefined) {
					const t = params.blocked.trim();
					if (t.length === 0) delete card.blocked;
					else card.blocked = t;
				}
				if (params.nextFireAt !== undefined) {
					const iso = normalizeFireAt(params.nextFireAt);
					if (iso === null && params.nextFireAt.trim().length > 0) {
						return "nextFireAt must be ISO 8601 or +Nm/+Nh/+Nd";
					}
					if (iso === null) {
						delete card.nextFireAt;
						delete card.firedFor; // no schedule left = nothing to have fired for
					} else card.nextFireAt = iso;
				}
				return null;
			};

			let message: string;
			switch (params.action) {
				case "add": {
					const text = (params.text ?? "").trim();
					if (text.length === 0) return fail("add requires a non-empty text");
					const col = params.col ?? "todo";
					const card: Card = { id: b.nextId++, text, col };
					stampMove(card, sid);
					const gateError = applyGate(card);
					if (gateError !== null) return fail(gateError);
					b.cards.push(card);
					persistError = writeBoard(path, b);
					message = `added ${formatCard(card)} to ${card.col} (${scope})${gateNote(card)}`;
					break;
				}
				case "move": {
					const card = params.id === undefined ? undefined : b.cards.find((c) => c.id === params.id);
					if (card === undefined) return fail(`no card with id ${params.id} in the ${scope} board`);
					if (params.col === undefined) return fail("move requires col");
					card.col = params.col;
					stampMove(card, sid);
					const gateError = applyGate(card);
					if (gateError !== null) return fail(gateError);
					persistError = writeBoard(path, b);
					message = `moved #${card.id} to ${card.col} (${scope})${gateNote(card)}`;
					break;
				}
				case "remove": {
					if (params.id === undefined) return fail("remove requires id");
					const card = b.cards.find((c) => c.id === params.id);
					if (card === undefined) return fail(`no card with id ${params.id} in the ${scope} board`);
					removeMedia(card);
					b.cards = b.cards.filter((c) => c.id !== params.id);
					persistError = writeBoard(path, b);
					message = `removed #${params.id} (${scope})`;
					break;
				}
				case "check": {
					// #38-2: the same JSON /api/selftest serves, so the agent can name the broken layer.
					const report = runSelfTest();
					if (!report.ok) return fail(JSON.stringify(report));
					message = JSON.stringify(report);
					break;
				}
				case "resume": {
					// #58: a halt is process memory + one JSONL entry; no HTTP call can lift it,
					// so the agent (and a human through it) gets the same reset `/kanban loop on` does.
					// #67: the reset itself lives in resumeWithModes, shared with /api/resume.
					const was = loop.halted === null ? "なし" : `halted:${loop.halted}`;
					const oldCount = loop.count;
					resumeWithModes(ctx, sid);
					const capNow = maxLoopsOf(modesFor(readModesFile(), sid, "session"));
					message = `resumed: ${was} / count ${oldCount} → 0 / doingLoop ON (session+global) / ${loopBudgetText(capNow, 0)}`;
					break;
				}
				default:
					message = `[${scope}]\n${renderLines(b).join("\n")}`;
			}

			refresh(ctx, sid);
			return done(message);
		},
	});

	// Separate tool on purpose: serving local paths is a read surface plus one narrow
	// write drop box (_inbox) and unrelated to board mutations, so the agent gets one
	// obvious verb instead of a kanban action.
	pi.registerTool({
		name: "serve",
		label: "Serve local path",
		description:
			"Expose a local file or directory over the existing kanban HTTP server (port 8789) as /serve/<id>/, and return the URL to hand to the user. add takes one absolute path; the path is referenced, not copied, so files created after registration are visible immediately. remove accepts the id or the path, list shows what is currently served. add takes permanent=true to opt a path out of the default 7-day expiry (registration without it now expires 7 days after createdAt), plus an optional title that the dashboard shows above the URL. A served page can POST raw bytes to /serve/<id>/_inbox/<name> (one path segment) and ack marks those files read for the per-turn INBOX line: id+name acks one file, id alone acks that path's inbox, no arguments acks everything. ack never deletes. Only paths under the allowlist (default ~/workspace and ~/.pi/kanban) can be added.",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("add"),
				Type.Literal("remove"),
				Type.Literal("list"),
				Type.Literal("ack"),
			]),
			path: Type.Optional(Type.String()),
			id: Type.Optional(Type.String()),
			name: Type.Optional(Type.String()),
			title: Type.Optional(Type.String()),
			permanent: Type.Optional(Type.Boolean()),
		}),
		async execute(_toolCallId, params) {
			type ServeDetails = {
				ok: boolean;
				id?: string;
				path?: string;
				url?: string;
				status?: number;
				error?: string;
				acked?: number;
				entries?: { id: string; path: string; url: string }[];
			};
			// #23: the hint is a second block so the URL itself stays a clean first line.
			const done = (text: string, details: ServeDetails, hint: string | null = null) => ({
				content:
					hint === null
						? [{ type: "text" as const, text }]
						: [{ type: "text" as const, text }, { type: "text" as const, text: hint }],
				details,
			});
			const fail = (text: string, details: ServeDetails) => ({ ...done(text, details), isError: true });

			if (params.action === "add") {
				const input = (params.path ?? "").trim();
				if (input.length === 0) return fail("serve add failed: path is required", { ok: false, error: "path is required" });
				const result = serveAdd(input, params.permanent === true, params.title);
				if (!result.ok) {
					return fail(`serve add failed (${result.status}): ${result.error}`, {
						ok: false,
						status: result.status,
						error: result.error,
					});
				}
				const url = serveUrlFor(result.entry);
				return done(url, { ok: true, id: result.entry.id, path: result.entry.path, url }, serveHostFallbackHint());
			}
			if (params.action === "remove") {
				const input = (params.id ?? params.path ?? "").trim();
				if (input.length === 0) {
					return fail("serve remove failed: id or path is required", { ok: false, error: "id or path is required" });
				}
				const removed = serveRemove(input);
				if (removed === null) {
					return fail(`serve remove failed: not registered: ${input}`, {
						ok: false,
						error: `not registered: ${input}`,
					});
				}
				return done(`removed ${removed.path}`, { ok: true, id: removed.id, path: removed.path });
			}
			if (params.action === "ack") {
				const result = serveAck(params.id?.trim() || undefined, params.name?.trim() || undefined);
				if (!result.ok) {
					return fail(`serve ack failed (${result.status}): ${result.error}`, {
						ok: false,
						status: result.status,
						error: result.error,
					});
				}
				return done(`acked ${result.acked} file(s)`, { ok: true, acked: result.acked });
			}
			// Same watermark as /serve, so the agent reads the badge the browser shows.
			const seen = readSeen();
			const rows = serveLiveEntries().map((e) => ({ ...e, url: serveUrlFor(e), unread: inboxUnread(e, seen).length }));
			const text =
				rows.length === 0
					? "no served paths"
					: rows.map((r) => `${r.url}\t${r.path}${r.unread > 0 ? ` (${r.unread} unread)` : ""}`).join("\n");
			return done(text, { ok: true, entries: rows }, serveHostFallbackHint());
		},
	});

	// Auto-loop. Off by default (modes.json), and it never blocks input: this
	// handler only decides whether the settled run gets one more request.
	pi.on("agent_before_settle", (event, ctx) => {
		const sid = sidOf(ctx);
		const f = readModesFile();
		const ms = modesFor(f, sid, "session");
		const mg = modesFor(f, sid, "global");
		// (1) every switch off -> nothing to drive.
		if (!ms.doingLoop && !ms.autoPick && !mg.doingLoop && !mg.autoPick) return;

		// A stuck halt belongs to the board that was driving it: checking the other
		// board too would clear the halt on its emptiness and restart the loop.
		if (loop.halted === "stuck") {
			const driving = loop.scope ?? "session";
			if (!cardsIn(readBoard(boardPath(driving, sid)), "doing").some((c) => c.id === loop.stuckId)) {
				loop = { count: 0, halted: null, scope: null, stuckId: null, stuckCount: 0, lastActivityAt: 0 };
				persistLoop();
				paintLoop(ctx, sid);
			}
		}
		if (loop.halted !== null) return; // halted until /kanban loop on / off+on

		// A settle whose head message is the user's is the user's run, not the board's: that is
		// exactly the steer noise. contextMessages keeps our own custom_message continuations
		// at role "custom", and a completed turn leaves role "assistant" last, so only a real
		// prompt at the head flips this.
		if (isUserInputHead(event.context.contextMessages)) return;

		// autoPick: SESSION first, then GLOBAL. The first scope with a TODO to move ends
		// the scan, so one settle still picks at most one card. WIP=1: a scope that already
		// holds one of THIS session's DOING cards does not pick another. A scope whose DOING
		// is empty and whose only work is TODO is still woken (Phase 10: an idle agent must
		// not stall), and doingHeadOf is ownership-filtered for GLOBAL, so a sibling
		// session's DOING card never counts as ours.
		for (const scope of ["session", "global"] as const) {
			if (!modesFor(f, sid, scope).autoPick) continue;
			if (doingHeadOf(sid, scope) !== undefined) continue; // WIP=1: already working
			if (pickFirstTodo(sid, scope) !== null) {
				refresh(ctx, sid); // the board moved: redraw now
				break;
			}
		}

		// The driving card: SESSION wins, because the injected board is the session one.
		// Driving GLOBAL while SESSION has work would contradict the injected context.
		let scope: Scope = "session";
		let card = candidates(sid, "session", f);
		if (card === undefined) {
			scope = "global";
			card = candidates(sid, "global", f);
		}
		if (card === undefined) return; // (2) nothing to drive on either board

		// stuckId is a per-board id: it only means anything together with the scope.
		// The threshold belongs to the board that is driving (`loop.scope`), not to a
		// hard-coded constant: /kanban stuck must actually move where the loop halts.
		const next = nextStuckState(loop, card.id, scope, stuckLimitOf(modesFor(f, sid, scope)));
		loop.scope = scope;
		loop.stuckId = next.stuckId;
		loop.stuckCount = next.stuckCount;
		if (next.stuck) {
			loop.halted = "stuck";
			persistLoop();
			paintLoop(ctx, sid);
			return;
		}

		// (3) the cap: turn doingLoop off so the NEXT settle is a real stop. Both scopes,
		// or the other one keeps running on the next settle and the cap is no cap.
		// #67: the cap is stored per (scope, sid); 0 means unlimited, so no halt at all.
		const cap = maxLoopsOf(modesFor(f, sid, loop.scope ?? scope));
		if (cap > 0 && loop.count >= cap) {
			loop.halted = "limit";
			setMode(f, sid, "session", "doingLoop", false);
			setMode(f, sid, "global", "doingLoop", false);
			writeModesFile(f);
			persistLoop();
			paintLoop(ctx, sid);
			return;
		}

		loop.count++;
		persistLoop();
		paintLoop(ctx, sid);
		// firedFor goes in only AFTER the continuation content is built: a malformed card
		// throws here, before the wake is recorded, so the next settle retries instead of
		// going silent forever. A failed writeBoard only means one extra wake next settle.
		const prompt = continuationPrompt(card, scope);
		markFired(card, sid, scope);
		return {
			continue: true,
			// A continuation needs a trailing non-assistant message; this entry is also
			// the persisted record of why the extra turn ran.
			entries: [
				{
					type: "custom_message" as const,
					customType: LOOP_PROMPT_TYPE,
					content: prompt,
					display: true,
				},
			],
		};
	});

	// Rebuild from disk (both layers) on session start / tree navigation.
	// `isTree` says which event fired: only a branch move may refresh an existing ownCtx.
	const sync = (ctx: ExtensionContext, isTree: boolean) => {
		const sid = sidOf(ctx);
		restoreLoop(ctx);
		readModesFile(); // a missing modes.json is created here, with both modes off
		paintLoop(ctx, sid); // draws the restored LOOP HALTED / STUCK tag
		pollSnapshot = diskSnapshot(sid);
		// ownCtx is the FIRST session that started in this closure, not the newest: one
		// process hosts several sessions (subagents included), and adopting the newest
		// made poll() read that session's board forever - the real session went silent
		// until a message forced agent_before_settle to run on its own ctx.
		// session_tree is a branch move inside the SAME session, so it may refresh it.
		if (ownCtx === null) {
			ownCtx = ctx;
			// #40: the first session to start in this process pins the panel's default
			// sid. Later starts (siblings, subagents) must not move it.
			activeSessionId = sid;
			warnedDeadCtx = false;
			deadCtxStrikes = 0;
		} else if (isTree) {
			try {
				if (sidOf(ownCtx) === sid) ownCtx = ctx;
			} catch {
				// disposed ownCtx: its poll strikes out and releases it for the next start
			}
		}
		if (pollTimer === null) {
			// Same period as the dashboard's poll so the footer and the page converge.
			// Started unconditionally: the HTTP server is shared with a sibling pi, but the
			// loop is this session's, so no listen result may gate it.
			pollTimer = setInterval(poll, 1500);
			pollTimer.unref(); // a stray timer must never hold the process open
		}
	};
	pi.on("session_start", (_event, ctx) => sync(ctx, false));
	pi.on("session_tree", (_event, ctx) => sync(ctx, true));

	pi.on("session_shutdown", () => {
		// #55: the driver pin must not outlive the session that pinned it. Read the sid
		// before stopPoll() releases ownCtx; release only our own pin, never a handover.
		let pinned: string | null = null;
		try {
			pinned = ownCtx === null ? null : sidOf(ownCtx);
		} catch {
			// disposed ownCtx cannot answer; that session is gone either way
		}
		stopPoll();
		if (pinned !== null && activeSessionId === pinned) activeSessionId = null;
	});

	// Per-turn injection: attach the session board as a request-only trailing message.
	// Deliberately NOT a system-prompt section — mutating the system prompt on every board
	// edit invalidates the provider prefix cache for the entire conversation. The global
	// board is never injected. Empty session board -> nothing appended.
	pi.on("before_agent_start", (_event, ctx) => {
		const txt = renderInjectionText(readBoard(boardPath("session", sidOf(ctx))));
		if (txt === null) return;
		return { message: { customType: KANBAN_CUSTOM_TYPE, content: txt, display: false } };
	});

	// The HTTP server stays up across session_shutdown: it is shared by all
	// sessions in the process, so only the per-session poll timer is torn down.
	// #64: do NOT add server.unref() here. pi ends with process.exit(0)
	// (interactive-mode.js), which ends the process regardless of open handles;
	// unref() would buy nothing and would hide a real leak from the tests.

	// Test hook for the closure state above (pi ignores the factory's return value).
	return {
		__test: {
			ownCtx: () => ownCtx,
			hasTimer: () => pollTimer !== null,
			poll,
			sweepServe,
			// #67: the dashboard's 再開 is exercised through the real poll hand-off
			// (/api/resume parks a token, poll consumes it); these let a test assert
			// the parked state instead of sleeping on a timer.
			resumeRequests,
			// #83: the listen/probe path is only reachable through a real port conflict,
			// so the tests drive the two halves directly.
			probe: probeServer,
			decideReuse,
			apiState: () => apiState,
			resumeNow: (sid: string) => {
				if (ownCtx === null) throw new Error("no session ctx");
				return resumeWithModes(ownCtx, sid);
			},
		},
	};
}
