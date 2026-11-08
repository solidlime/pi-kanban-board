/**
 * kanban.ts - experimental pi extension: two-layer kanban boards.
 *
 * Two layers, one UI (#17: no per-session layer - a pi session id is not a board):
 *   project ~/.pi/kanban/projects/<slug>.json - shared by every session in one repo.
 *   global  ~/.pi/kanban/global.json          - read-only aggregate over the projects.
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
 * Per-turn injection: a `before_agent_start` handler attaches this cwd's PROJECT
 * board as a request-only trailing message. It must NOT go into the system prompt: a
 * system prompt that changes on every board edit invalidates the provider prefix
 * cache for the whole conversation. The global board is never injected — the
 * model cannot act on it and its counts would only invite drift. Project board
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

import { execFileSync } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	copyFileSync,
	createReadStream,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import type { Dirent, Stats } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { homedir, hostname, networkInterfaces } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DASHBOARD_TEMPLATE } from "./dashboard.generated.ts";
import { openKanbanDb } from "./db.ts";
import type { BoardKey, Decision, KanbanDb } from "./db.ts";

// ---------------------------------------------------------------------------
// Types & state
// ---------------------------------------------------------------------------

// "project" is the working directory (git root) - the board two sessions in the same repo
// share. "global" is a read-only aggregate. #17: no "session" scope - a pi session id is
// the actor (movedBy) only, never a board.
type Scope = "global" | "project";
// #67: "deliverable" = 成果物. The 4th column, OUTSIDE todo/doing/done: the loop never drives
// it (nextTodo reads todo, tickCardFor/doingHeadOf read doing) and the counts keep 3 keys.
type Col = "todo" | "doing" | "done" | "deliverable";
// movedAt/movedBy are optional on purpose: boards written before they existed still
// load. movedBy = the session id that last changed this card's COLUMN. A rename or
// an image swap does not transfer ownership, so those paths leave it untouched.
// priority is optional on purpose: boards written before it existed still load.
// Absent/invalid means 0; the autoPick order sorts by it descending (see orderTodos).
// nextFireAt/blocked/firedFor are optional too: absent = no restriction = the old
// behavior. nextFireAt is an ISO 8601 string with an offset (human-readable board
// JSON). blocked is free text; "" means cleared. firedFor records the nextFireAt
// value a wake already happened for, so re-arming = changing nextFireAt.
// project is optional too: a slug ([A-Za-z0-9._-], case kept, max 24 chars) naming the
// project a card belongs to. Absent = unassigned. Deliberately unrelated to the
// loop: autoPick/injection never read it (see normalizeProject).
// due/estimate/blocks (#phase1) are the board-metadata trio. due is a DATE
// (YYYY-MM-DD, no time) so "today" means the same thing to every reader; estimate is
// a non-negative point count; blocks lists the cards this one blocks. Absent means
// "no deadline / no estimate / blocks nothing", so pre-phase1 cards read unchanged.
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
	project?: string;
	/** #20: the conversation this card came from. Shown as an ID, never as a link. */
	sessionId?: string;
	/** #20: 7-40 lowercase hex naming the commit this card is about. */
	commit?: string;
	due?: string;
	estimate?: number;
	blocks?: number[];
	/** #22: whole-set replacement, always a non-empty subset of LABELS. Absent = no labels. */
	labels?: string[];
	/**
	 * #52: view-only, never written. Set by projectReport when THIS card's movedBy is the
	 * asking session, so the dashboard can say "あなた" without knowing its own sid.
	 */
	mine?: boolean;
};
/** #82: 成果物は card ではない（col を持たない納品物）。id 空間は card と別。 */
export type Deliv = { id: number; text: string; img?: string; at: number };
type Board = { cards: Card[]; nextId: number; deliverables: Deliv[]; delivNextId: number };
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
	GLOBAL?: Record<string, ModePair>;
	// Keyed by project board slug (a cwd slug), not by session id.
	PROJECT?: Record<string, ModePair>;
};
type LoopState = {
	count: number; // continuations granted in this session (persisted)
	halted: "limit" | "stuck" | null;
	scope: "project" | null; // the board driving the loop (null = nothing drove yet, legacy JSONL)
	// #26: only this cwd's project board can drive. global is a read-only aggregate view.
	stuckId: number | null;
	stuckCount: number; // consecutive settles that left this card in DOING
	// Last sign of life on THIS session (turn_start only). The timer only speaks into
	// real silence, so it gates on this as well as lastTickAt.
	lastActivityAt?: number;
};

const COLS: Col[] = ["todo", "doing", "done"];
// #18: the TUI move menu labels, index-aligned with COLS so the mapping cannot drift.
const MOVE_LABELS = COLS.map((c) => `${c.toUpperCase()} へ移動`);
// 7-char labels so the card bodies line up. deliverable is padded to 7 by the GUI, not here.
const COL_LABELS: Record<Col, string> = { todo: "TODO   ", doing: "DOING  ", done: "DONE   ", deliverable: "DELIV  " };
const WIDGET_KEY = "kanban";
const MAX_SHOWN = 4; // a column over this many cards shows 3 + "…ほかN件"
const INJECT_DONE = 3; // injected DONE keeps only the newest N (long sessions would grow otherwise)
const KANBAN_CUSTOM_TYPE = "kanban-board"; // customType of the per-turn trailing message
const STALE_MS = 3 * 60 * 60 * 1000; // DOING for this long without a move -> ⚠Nh in the footer
const STALE_DAY_MS = 86_400_000; // #18: a day without a move reads as ⚠Nd
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
// #93: the HTTP routes are module level and get no ctx, so the two places that know a session's
// live cwd (`sync()` and `/kanban take`) publish it here. `cwdBySid` = every sid this process has
// seen (all session_starts, not just the pin); `driverCwd` = the panel's default board.
let driverCwd = "";
const cwdBySid = new Map<string, string>();
// A loop halt lives in one extension closure (memory + session JSONL). The HTTP server
// runs in the same process but outside that closure, so this is the only door for the
// GUI to learn WHY the loop stopped. Published by paintLoop, cleared by resume.
const haltedBySid = new Map<
	string,
	{ halted: "limit" | "stuck"; stuckId: number | null; stuckCount: number; cap: number; scope: Scope }
>();
// #67: /api/resume cannot reach a session's closure state from the server module, so it
// parks a request here and the owning session's poll runs the resume (see resumeLoop).
// #17: the key is a pi session id ONLY - never a board key (a project slug). The poll
// consumes it with sidOf(ownCtx), so a slug here would park a request nobody ever reads.
const resumeRequests = new Map<string, number>();
// #48: the same door, the other direction. A halt is idempotent, so a Set is enough:
// outstanding duplicates collapse into the one state the poll already holds.
const haltRequests = new Set<string>();
/** #94: ダッシュボードの「+」で TODO が増えた時刻。次の poll は無音ゲートを待たずに
 *  しゃべってよい。ボード単位: あるボードの追加が別ボードの駆動を引っぱらない。 */
const userPickAt = new Map<string, number>();
let server: Server | null = null;
// Every non-starting state is surfaced in the footer: a dead API must never be silent.
//   up    - this process owns the port, or a process of OUR version does.
//   down  - nothing answers the port.
//   stale - a kanban server of ANOTHER version owns the port; reuse is refused.
//   fatal - the bind can never succeed as configured (EACCES/EPERM/bad port). No retry.
let apiState: "starting" | "up" | "down" | "stale" | "fatal" = "starting";
let apiStarting = false;
/**
 * Phase 0: the one-shot scope fold, while it runs. It ENDS by deleting the session/global
 * rows it folded, so a write accepted in that window is thrown away. The bind does not wait
 * for it (a cold start must answer its first request); the write routes do.
 */
let migrationPending: Promise<void> | null = null;
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
// Phase 0 (D1): the project board is a pseudo-path, not a directory anyone reads.
// The row is (scope='project', sid=slug); this path exists only so boardPath/boardKeyOf
// keep one shared (path -> key) mapping.
const PROJECTS_DIR = join(KANBAN_DIR, "projects");
const DB_FILE = join(KANBAN_DIR, "boards.sqlite"); // #11: 設定タブが大きさを出す（db.ts は触らない）
const LEGACY_JSON = join(KANBAN_DIR, "board.json");
const DASHBOARD_HTML_PATH = join(KANBAN_DIR, "dashboard.html");
const SERVER_LOG = join(KANBAN_DIR, "server.log");
const TOKEN_FILE = join(KANBAN_DIR, "token"); // #83b: the one secret every HTTP route needs
const TOKEN_COOKIE = "kb_auth"; // #85: the name the spec fixes; the value is still the token
const TOKEN_TTL_SEC = 30 * 24 * 60 * 60; // #85: 30 days
let tokenCache: string | null = null;

/**
 * #83b: read the token, or make one. 64 hex chars, 0600. A file that is missing, empty,
 * unreadable or the wrong shape is replaced rather than fatal - a board that refuses to
 * start is worse than a rotated token, and the user can always ask for the URL again.
 * The token is NEVER logged (server.log is a plain file anyone can read).
 */
function ensureToken(): string {
	if (tokenCache !== null) return tokenCache;
	// #85: the directory holds the secret, so it is 0700 on both branches (a 0755 one an
	// older version left behind is corrected here, same as the token file below).
	try {
		mkdirSync(KANBAN_DIR, { recursive: true, mode: 0o700 });
		if ((statSync(KANBAN_DIR).mode & 0o077) !== 0) chmodSync(KANBAN_DIR, 0o700);
	} catch {
		// a chmod we cannot do does not make the token unusable
	}
	const usable = (v: string): boolean => /^[0-9a-f]{64}$/.test(v);
	try {
		const raw = readFileSync(TOKEN_FILE, "utf8").trim();
		if (usable(raw)) {
			// An existing file may have been created by hand with 0644: correct it.
			try {
				if ((statSync(TOKEN_FILE).mode & 0o777) !== 0o600) chmodSync(TOKEN_FILE, 0o600);
			} catch {
				// a chmod we cannot do does not make the token unusable
			}
			tokenCache = raw;
			return raw;
		}
	} catch {
		// missing or unreadable -> fall through and generate
	}
	const fresh = randomBytes(32).toString("hex");
	try {
		writeFileSync(TOKEN_FILE, `${fresh}\n`, { mode: 0o600 });
		chmodSync(TOKEN_FILE, 0o600); // mode: is subject to umask; this is not
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		process.stderr.write(`kanban: token write failed (${TOKEN_FILE}): ${e.code ?? "error"}: ${e.message}\n`);
	}
	tokenCache = fresh;
	return fresh;
}
const MEDIA_DIR = join(KANBAN_DIR, "media");
const SERVE_JSON = join(KANBAN_DIR, "serve.json"); // the registry (A5/A6)
const SERVE_ALLOW_JSON = join(KANBAN_DIR, "serve-allow.json"); // optional allowlist override (A10)
const SERVE_HOST_JSON = join(KANBAN_DIR, "serve-host.json"); // #20: host reported by the board page
const INBOX_SEEN_JSON = join(KANBAN_DIR, "inbox-seen.json"); // ack watermarks, per entry id
const INBOX = "_inbox"; // the one writable subdirectory of a served path
// #53: KANBAN_MEDIA_MAX_BYTES overrides the per-file cap (8MB default) for uploads.
const MAX_UPLOAD = (() => {
	const n = Number(process.env.KANBAN_MEDIA_MAX_BYTES);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : 8 * 1024 * 1024;
})(); // images, html and inbox files
const MAX_UPLOAD_VIDEO = 64 * 1024 * 1024; // a video needs room the image budget cannot give
const INBOX_NUDGE_NAMES = 3; // filenames per INBOX row before collapsing to `+N more`
// #80-⑪: the _inbox extension policy is an ALLOWLIST, not a denylist. A denylist has to
// be re-synced every time a new active type shows up (svg, mhtml, hta, wasm, ...) and a
// missed entry is served back by /serve/*; failing closed costs a refused file instead.
// The list is what the dashboard actually moves: images, video, audio, plain text/data.
const INBOX_EXTS = new Set([
	"png", "jpg", "jpeg", "gif", "webp", "avif", "heic",
	"mp4", "webm", "mov", "mkv",
	"mp3", "wav", "ogg", "m4a", "flac",
	"txt", "md", "json", "jsonl", "csv", "tsv", "log", "yaml", "yml",
]);
const INBOX_NAME_MAX = 128; // chars, one path segment; longer names only help a hostile page
// #80-⑪: the disk budget for media/ and the _inbox bytes that share the same volume
// (5.3T disk, 2.9T free here). MAX_UPLOAD_VIDEO is 64MB, so 1GiB is ~16 videos or ~128
// 8MB images — enough for one board, small enough that an unattended upload loop with a
// dropped card reference (media files are only removed when a card is) cannot fill it.
const MEDIA_DIR_MAX_BYTES = 1024 * 1024 * 1024;
// #53: html is an attachment too - the dashboard reads it in a sandboxed iframe.
const OK_EXTS = ["png", "jpg", "gif", "webp", "avif", "mp4", "webm", "mov", "html"];
const MIME_BY_EXT: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	mp4: "video/mp4",
	webm: "video/webm",
	// #91: .mov from a phone/camera. uploadLimitOf() reads the video/ prefix, so the
	// 64MB video budget comes with it and /api/media serves it without another table.
	mov: "video/quicktime",
	html: "text/html",
};

/**
 * #91: what /api/ref may serve as a document. Deliberately NOT in MIME_BY_EXT: that table
 * is the upload allowlist, and these are read where they live, not copied into media/.
 * text/markdown would be downloaded (Chrome has no viewer for it), and application/json
 * would be an API response - the point here is to read the bytes as text.
 */
const REF_MIME: Record<string, string> = {
	pdf: "application/pdf",
	md: "text/plain; charset=utf-8",
	markdown: "text/plain; charset=utf-8",
	txt: "text/plain; charset=utf-8",
	log: "text/plain; charset=utf-8",
	csv: "text/plain; charset=utf-8",
	json: "text/plain; charset=utf-8",
};

/** The one place the image/video upload split lives: 8MB for images, 64MB for video. */
function uploadLimitOf(ext: string): number {
	return (MIME_BY_EXT[ext] ?? "").startsWith("video/") ? MAX_UPLOAD_VIDEO : MAX_UPLOAD;
}

const fmtMB = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))}MB`;

/**
 * The one place that maps (scope, sid) to a file. boardKeyOf() is its inverse and this pair
 * is the ONLY path<->key conversion in the file: a scope added to one has to be added to the
 * other, or a write lands in a row the reader never looks at.
 * For "project", sid is the slug (see projectSlugOf); global has no file of its own.
 */
function boardPath(scope: Scope, sid: string): string {
	if (scope === "global") return GLOBAL_JSON;
	// The slug becomes a filename; dots are kept (a slug may contain them).
	return join(PROJECTS_DIR, `${sid.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

/** global passes through; anything else (including a stale `scope=session`) means project. */
const parseScope = (value: string | null): Scope => (value === "global" ? "global" : "project");

// cwd -> slug, and slug -> the root it first came from (for the collision warning).
const slugByCwd = new Map<string, string>();
const rootBySlug = new Map<string, string>();

/**
 * The board key for a working directory: the git root's basename, normalized like a
 * card's project. Two sessions opened in the same repo therefore share one board.
 * shortcut: two different roots with the same basename collapse into one board (a warning
 * on stderr is all we do); upgrade to a path-derived suffix when the db `project` table
 * can hold the mapping (phase 2).
 */
export function projectSlugOf(cwd: string): string {
	const cached = slugByCwd.get(cwd);
	if (cached !== undefined) return cached;
	let root = cwd;
	try {
		// A missing repo answers immediately; the timeout keeps a wedged git from stalling a write.
		const top = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2000,
		}).trim();
		if (top !== "") root = top;
	} catch {
		// not a repo (or no git at all): the cwd itself is the scope
	}
	const slug = normalizeProject(basename(root)) || "inbox";
	const owner = rootBySlug.get(slug);
	if (owner === undefined) rootBySlug.set(slug, root);
	else if (owner !== root) {
		process.stderr.write(`kanban: project slug "${slug}" is shared by ${owner} and ${root}\n`);
	}
	slugByCwd.set(cwd, slug);
	return slug;
}

/**
 * The cwd behind a sid, for the HTTP routes (which are sync): what `pinDriver()` published for
 * that sid, then the driver's cwd, then ours. Nothing here may scan the session store - that
 * is 757-990 files / 1.9GB of jsonl and cost 6-10s per cold /api/dashboard.
 * A sid we never saw has no cwd and falls back to the driver's board; the gates that must not
 * guess (`projectKeyOfWrite`, the read at /api/kanban) refuse it before getting here.
 */
function cwdOfSidSync(sid: string | null): string {
	const id = sid === null || sid === "" ? activeSessionId : sid;
	const known = id === null || id === "" ? undefined : cwdBySid.get(id);
	if (typeof known === "string" && known !== "") return known;
	return driverCwd !== "" ? driverCwd : process.cwd();
}

/**
 * #93: pin a session as the driver and publish both cwds the sync HTTP routes read. Called by
 * `sync()` (the automatic pin) and `/kanban take` (the explicit handover) - the only two places
 * that assign a session to `activeSessionId`. Publishing only in `sync()` left a taken-over session
 * unlisted, so every ctx-less request fell back to the previous repo's board.
 */
function pinDriver(ctx: ExtensionContext, sid: string): void {
	activeSessionId = sid;
	const cwd = cwdOfCtx(ctx);
	driverCwd = cwd;
	if (sid !== "") cwdBySid.set(sid, cwd);
}

/** The tool's cwd. A context without getCwd (an older host, a test double) reads as ours. */
function cwdOfCtx(ctx: ExtensionContext): string {
	const sm = (ctx as { sessionManager?: { getCwd?: () => string } }).sessionManager;
	try {
		const cwd = sm?.getCwd?.();
		if (typeof cwd === "string" && cwd !== "") return cwd;
	} catch {
		// fall through to the process cwd
	}
	return process.cwd();
}

function readRaw(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

/**
 * Change signature of one file, read as a stat: 0.039ms against 0.53ms for reading the
 * bytes back, and poll asks for three of them every 1.5s.
 * mtimeNs alone is not enough: this fs has a coarse mtime tick (two writes inside one tick
 * reported the SAME mtimeNs), so size and the inode carry the rest. The inode is what
 * catches a same-size rewrite, because every writer here goes through tmp+rename.
 * shortcut: an in-place write of an unchanged size inside one mtime tick is invisible;
 * upgrade to a content hash if a writer ever stops using tmp+rename.
 */
export function fileSig(path: string): string {
	try {
		const st = statSync(path, { bigint: true });
		return `${st.mtimeNs}:${st.size}:${st.ino}`;
	} catch {
		return ""; // absent is a stable signature too: "" every tick until it appears
	}
}

// ---------------------------------------------------------------------------
// Board storage (sqlite)
// ---------------------------------------------------------------------------

let db: KanbanDb | null = null;

/** The one place a path becomes a board key. boardPath() is the inverse (see its note). */
function boardKeyOf(path: string): BoardKey {
	// Callers pass paths they built themselves (a temp dir, a raw string), so compare by
	// resolved location rather than by string identity with GLOBAL_JSON.
	const abs = resolve(path);
	if (abs === resolve(GLOBAL_JSON)) return { scope: "global", sid: "" };
	// #17: tests still hand in a bare path (a temp file that was never built by boardPath).
	// That fallback is for those raw paths only - the scope is project, keyed by the name.
	return { scope: "project", sid: basename(abs, ".json") };
}

/** Read one board, or null when it was never written. */
export function readBoardOrNull(path: string): Board | null {
	return kanbanDb().readBoard(boardKeyOf(path));
}
/**
 * Read one board. A board that was never written reads as empty - the JSON path did the
 * same, and 43 call sites depend on it. What must NOT happen is a broken database
 * reading as empty: that would persist a wipe on the next write.
 */
export function readBoard(path: string): Board {
	return readBoardOrNull(path) ?? { cards: [], nextId: 1, deliverables: [], delivNextId: 1 };
}
/**
 * #36: the spelling a project board is STORED under, or the given slug when it has no board
 * yet. Every sid match is COLLATE NOCASE, so a caller's spelling (?p=, a sid's cwd) is a
 * different string from the board's - answer with the board's so paths and projectId agree.
 */
function storedProjectKey(slug: string): string {
	return kanbanDb().boardSid({ scope: "project", sid: slug }) ?? slug;
}
/** Drop a board entirely. Only tests use this; the server never deletes one. */
export function deleteBoardPath(path: string): void {
	kanbanDb().deleteBoard(boardKeyOf(path));
}

/** Open once per process. */
function kanbanDb(): KanbanDb {
	if (db !== null) return db;
	mkdirSync(KANBAN_DIR, { recursive: true });
	db = openKanbanDb(DB_FILE);
	return db;
}

/**
 * #17: board scopes are project + global now, and pi session IDs are no longer board keys.
 * This runs once per database: it drops every session/global row (the old model) and keeps
 * project rows, so a database written by the session model does not leave invisible rows.
 * A marker key changes so a DB that already ran the old fold (meta.scope_migrated=1) still
 * gets reset - that fold moved cards into project boards, which we keep.
 */
export function resetScopesOnce(): void {
	const kdb = kanbanDb();
	if (kdb.getMeta("scopes_reset") === "2") return;
	// Copy first: a DELETE that throws half way must not leave the old rows unrecoverable.
	const backup = `${DB_FILE}.pre-scope-reset`;
	try {
		kdb.checkpoint();
		if (!existsSync(backup)) copyFileSync(DB_FILE, backup);
	} catch (err) {
		process.stderr.write("kanban: scope reset aborted: " + err + "\n");
		return;
	}
	const dropped = kdb.dropNonProject();
	kdb.setMeta("scopes_reset", "2");
	process.stderr.write(`kanban: scope reset: dropped ${dropped} non-project board(s)\n`);
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
		// tmp+rename, same as writeBoard: diskSnapshot watches the inode, and an in-place
		// write keeps it, which would hide two toggles inside one mtime tick.
		const tmp = `${MODES_JSON}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(f, null, 2));
		renameSync(tmp, MODES_JSON);
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		process.stderr.write(`kanban: modes write failed (${MODES_JSON}): ${e.code ?? "error"}: ${e.message}\n`);
	}
}

/** One (scope, sid) pair, falling back to the legacy flat keys when it has no entry. */
function modesFor(f: ModesFile, sid: string, scope: Scope): ModePair {
	const scoped = modesBucket(f, scope);
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

/** The bucket a scope lives in; an absent bucket reads as empty. */
function modesBucket(f: ModesFile, scope: Scope): Record<string, ModePair> {
	if (scope === "global") return f.GLOBAL ?? {};
	return f.PROJECT ?? {};
}

/**
 * Same bucket for a writer. #26: the project board is the ONLY one with switches, so the
 * global arm is gone for good - a writer can no longer hand a global key to a file nothing reads.
 */
function modesBucketForWrite(f: ModesFile): Record<string, ModePair> {
	return (f.PROJECT ??= {});
}

/**
 * read-modify-write one (scope, sid) pair. The flat legacy keys are never touched.
 * #17: reader and writer share modesBucket, so modesFor(f, slug, "project") and setMode()
 * are the same f.PROJECT[slug] entry. There is no unit test for that key match yet (B5).
 */
function setMode(f: ModesFile, sid: string, scope: "project", key: SwitchKey, val: boolean): void {
	modesBucketForWrite(f)[sid] = { ...modesFor(f, sid, scope), [key]: val };
}

/** Persist one board's auto-tick interval (minutes); same read-modify-write as setMode. */
function setIntervalMin(f: ModesFile, sid: string, scope: "project", minutes: number): void {
	modesBucketForWrite(f)[sid] = { ...modesFor(f, sid, scope), intervalMin: minutes };
}

/** Persist one board's stuck threshold (settle count); same read-modify-write as setMode. */
function setStuckLimit(f: ModesFile, sid: string, scope: "project", count: number): void {
	modesBucketForWrite(f)[sid] = { ...modesFor(f, sid, scope), stuckLimit: count };
}

/** Persist one board's doing-loop budget; same read-modify-write as setMode. */
function setMaxLoops(f: ModesFile, sid: string, scope: "project", n: number): void {
	modesBucketForWrite(f)[sid] = { ...modesFor(f, sid, scope), maxLoops: n };
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

/** #26: the one wording every switch route answers scope=global with. */
const GLOBAL_NO_SWITCH = "global は集約ビューでスイッチを持たない（scope=project を使う）";

/** #17/#29: the one wording every route answers a stale scope=session with. */
const SESSION_SCOPE_GONE = "scope=session is gone; boards are project-scoped";

type MaxLoopsInput = { scope?: string | null; sid?: string | null; n?: string | null };

/**
 * #71/#011: what /api/maxloops should do with a query — no writes, no reads, so this is
 * the whole rule set in one testable place. A missing/unknown scope means project, the
 * same reading parseScope has (the dashboard always sends one).
 *
 * #26: scope=global has no switch to write any more (global is a read-only aggregate), so
 * it is a 400 here like it is on every other switch route.
 * scope=project is keyed by the cwd slug: a session id is not a slug, so the sid goes
 * through projectKeyOfWrite (an unknown sid has no cwd and would write PROJECT[<sid>]).
 */
export function maxLoopsRequest(q: MaxLoopsInput): { kind: "error"; error: string } | { kind: "ok"; scope: "project"; sid: string; n: number } {
	const raw = q.scope ?? "";
	if (raw !== "" && raw !== "global" && raw !== "project") {
		return { kind: "error", error: "scope must be global or project" };
	}
	if (raw === "global") return { kind: "error", error: GLOBAL_NO_SWITCH };
	const given = q.sid ?? "";
	const key = projectKeyOfWrite(given);
	if (key === null) return { kind: "error", error: "unknown sid" };
	return { kind: "ok", scope: "project", sid: key, n: Number(q.n) };
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

export const PROJECT_MAX = 24;
/**
 * Write-boundary normalization: "" means "no project" (the field is deleted, like blocked).
 * #34: the case is kept - the slug is inherited from a directory name, and lowercasing it
 * renamed `Pi-Kanban-Board` to `pi-kanban-board`, a board that did not exist. Matching is
 * what ignores case (SQL `COLLATE NOCASE`), not the stored spelling.
 */
export function normalizeProject(raw: unknown): string {
	if (typeof raw !== "string") return "";
	return raw
		.trim()
		.replace(/[^A-Za-z0-9._-]/g, "")
		.slice(0, PROJECT_MAX);
}

export const SESSION_MAX = 128;
/**
 * #20: a session id rides in URLs, so every character that could act as a delimiter is
 * dropped. "" means "no session" (the field is deleted).
 */
export function normalizeSessionId(raw: unknown): string {
	if (typeof raw !== "string") return "";
	return raw
		.trim()
		.replace(/[^A-Za-z0-9._:@-]/g, "")
		.slice(0, SESSION_MAX);
}

/**
 * #20: "" means "no commit". Anything else that is not 7-40 hex is a typo, and the caller
 * turns that into a 400 instead of dropping it (same strictness as parseDue).
 */
export function normalizeCommit(raw: unknown): string {
	if (typeof raw !== "string") return "";
	const s = raw.trim().toLowerCase();
	return /^[0-9a-f]{7,40}$/.test(s) ? s : "";
}

const DUE_RE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * due is a date, not an instant: a time part would let two readers disagree on "today".
 * null = the caller got a value it cannot store (400), undefined = nothing given.
 */
export function parseDue(raw: string | null): string | undefined | null {
	if (raw === null || raw.trim() === "") return undefined;
	const s = raw.trim();
	if (!DUE_RE.test(s)) return null;
	// DUE_RE only checks the shape: 2026-13-01 passes it. Comparing the round-trip
	// catches month/day overflow without hand-rolling a calendar.
	const d = new Date(`${s}T00:00:00Z`);
	return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
}

/** estimate is a point count: an integer >= 0. null = reject, undefined = nothing given. */
export function parseEstimate(raw: string | null): number | undefined | null {
	if (raw === null || raw.trim() === "") return undefined;
	const n = Number(raw);
	return Number.isInteger(n) && n >= 0 ? n : null;
}

/** blocks arrives as "1,2,3" (the API is GET + query). null = reject, [] = nothing given. */
export function parseBlocks(raw: string | null): number[] | null {
	if (raw === null || raw.trim() === "") return [];
	const ids = raw.split(",").map((s) => Number(s.trim()));
	if (ids.some((id) => !Number.isInteger(id) || id < 1)) return null;
	return [...new Set(ids)];
}

/** #22: the whole vocabulary. Internal value = the word the human reads, so no map. */
export const LABELS = ["bug", "feature", "chore", "調査"] as const;
export type Label = (typeof LABELS)[number];
const LABEL_SET = new Set<string>(LABELS);

/**
 * #22: "bug,調査" -> ["bug","調査"]. null = reject (an unknown label, or blank without being empty),
 * [] = nothing given (null / ""). Elements are trimmed, so `?labels=%20bug%20` is `bug` - but `?labels=%20`
 * names nothing and is a typo, not a clear (#20 shipped `?commit=%20%20` being silently ignored).
 */
export function parseLabels(raw: string | null): string[] | null {
	if (raw === null || raw === "") return [];
	if (raw.trim() === "") return null;
	const out: string[] = [];
	for (const part of raw.split(",")) {
		const s = part.trim();
		if (!LABEL_SET.has(s)) return null;
		if (!out.includes(s)) out.push(s);
	}
	return out;
}

/** #50: quickadd の text は GET query に乗る（/api/add と同じ制約）。上限はデコード後 8KB。 */
export const QUICKADD_MAX_BYTES = 8192;

/** #50: 1 行ぶんのトークン。`#slug`=project / `!N`=estimate(1..5 に clamp) / `due:YYYY-MM-DD`=due。 */
const QA_TOKEN_RE = /^(#[A-Za-z0-9._-]+|![0-9]{1,3}|due:\S+)$/;
const QA_INDENT_RE = /^(\t| {2})/;

export type QuickAddResult = { ok: true; cards: Card[] } | { ok: false; error: string };

/**
 * #50: Quick Add 行パーサ。「1 行 = 1 カード、インデントした行は直前の非子行の子」。
 * id は書き込み側と同じく baseId から詰めて振るので、子の blocks は生成時に確定する
 * （新しい id は既存カードから指されていない＝循環しない）。
 * トークンは行頭から続く間だけ消費し、残りが本文。トークンだけの行は捨てる。
 */
export function parseQuickAdd(text: string, baseId = 1): QuickAddResult {
	if (Buffer.byteLength(text, "utf8") > QUICKADD_MAX_BYTES) {
		return { ok: false, error: `text must be at most ${QUICKADD_MAX_BYTES / 1024}KB` };
	}
	const cards: Card[] = [];
	let nextId = baseId;
	let parentId: number | undefined;
	for (const raw of text.split(/\r?\n/)) {
		if (raw.trim() === "" || raw.trim().startsWith("//")) continue;
		const words = raw.trim().split(/\s+/);
		let project = "";
		let estimate: number | undefined;
		let due: string | undefined;
		let i = 0;
		for (; i < words.length; i++) {
			const w = words[i];
			if (!QA_TOKEN_RE.test(w)) break;
			if (w.startsWith("#")) {
				if (project === "") project = normalizeProject(w.slice(1));
			} else if (w.startsWith("!")) {
				if (estimate === undefined) estimate = Math.min(5, Math.max(1, Number(w.slice(1))));
			} else if (due === undefined) {
				due = parseDue(w.slice(4)) ?? undefined;
				if (due === undefined) return { ok: false, error: "due must be YYYY-MM-DD" };
			}
		}
		const body = words.slice(i).join(" ");
		if (body === "") continue; // トークンだけの行は無視する
		const card: Card = { id: nextId++, text: body, col: "todo" };
		if (project !== "") card.project = project;
		if (due !== undefined) card.due = due;
		if (estimate !== undefined) card.estimate = estimate;
		if (QA_INDENT_RE.test(raw) && parentId !== undefined) card.blocks = [parentId];
		else parentId = card.id; // 子は親を更新しない。子だけの行は独立カード
		cards.push(card);
	}
	return { ok: true, cards };
}

/**
 * card -> blocks の連鎖を自分に戻るまで辿る。自己参照（自分を blocks する）もここで落ちる。
 * 新しいカードはまだ誰からも指されていないが、既存カードは未採番の id を blocks に
 * 書ける（あとから作るカードを先に宣言できる）ので、書き込み前に必ず見る。
 */
export function wouldCycle(cards: Card[], cardId: number, blocks: number[]): boolean {
	const edges = new Map<number, number[]>();
	for (const c of cards) if (c.blocks !== undefined) edges.set(c.id, c.blocks);
	const seen = new Set<number>();
	const stack = [...blocks];
	while (stack.length > 0) {
		const id = stack.pop() as number;
		if (id === cardId) return true;
		if (seen.has(id)) continue;
		seen.add(id);
		const next = edges.get(id);
		if (next !== undefined) stack.push(...next);
	}
	return false;
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
	const same = prev.scope === scope && prev.stuckId === cardId;
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
export function writeBoard(path: string, b: Board): string | null {
	let persistError: string | null = null;
	try {
		// One transaction: a concurrent writer waits instead of overwriting, and a reader
		// never sees half a board. This is the whole point of the move off JSON.
		kanbanDb().writeBoard(boardKeyOf(path), b);
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

/**
 * Move a card to a column. A move to the column it already sits in is a no-op:
 * stamping it would reset the staleness clock (#18), and the warning would never
 * fire again on a card nobody actually advanced. Every column change goes through
 * here so the rule cannot be forgotten at one call site.
 * Returns whether the column actually changed.
 */
function moveCardTo(card: Card, col: Col, sid: string): boolean {
	if (card.col === col) return false;
	card.col = col;
	stampMove(card, sid);
	return true;
}

/** Once per process: the pre-2-layer board becomes the global layer. */
function migrateLegacyBoard(): void {
	try {
		if (existsSync(LEGACY_JSON) && !existsSync(GLOBAL_JSON)) renameSync(LEGACY_JSON, GLOBAL_JSON);
	} catch {
		// a failed move only leaves the legacy file unread; never block startup
	}
}

// ---------------------------------------------------------------------------
// Rendering (widget lines + per-turn injection text)
// ---------------------------------------------------------------------------

// #82: cards only. Narrowed so callers holding just { cards, nextId } (no deliv half) still pass.
function cardsIn(b: Pick<Board, "cards">, col: Col): Card[] {
	return b.cards.filter((c) => c.col === col);
}

function formatCard(c: Card & { sid?: string }): string {
	// #57: `c.img` is already the media/ filename, so show it as-is (no path, no basename).
	// #16: aggregate rows carry the board they came from, and ids collide across boards.
	return `#${c.id} ${c.sid ? `[${c.sid}] ` : ""}${c.project ? `📁${c.project} ` : ""}${c.commit ? `${c.commit.slice(0, 7)} ` : ""}${c.labels && c.labels.length > 0 ? `${c.labels.join(",")} ` : ""}${c.text ?? ""}${c.img ? `🖼${c.img}` : ""}`;
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
	return `■ ${COL_LABELS[col]}${body}`;
}

function renderLines(b: Board): string[] {
	return COLS.map((col) => renderColumn(b, col));
}

/** The footer's per-board summary: todo/doing only — DONE never needs attention. */
function countsOf(b: Board): string {
	return `${cardsIn(b, "todo").length} todo / ${cardsIn(b, "doing").length} doing`;
}

/**
 * #85b: `sessions[].updatedAt` は分単位に丸める。mtime は走っているセッションで毎秒進むが、
 * ダッシュボードがその値から描くのは分粒度の相対時刻だけ（#74 で ticker が部分更新する）。
 * 秒以下を本文に載せると ETag が毎ポーリング変わり、304 が死ぬ。
 * 壊れた mtime は例外にせず null に落とす（クライアントの ago()/full() は null を「—」にする）。
 * #17: the session rows are gone from /api/dashboard, so nothing in this module calls it;
 * it stays exported because the mtime rounding is its own tested unit.
 */
export function updatedAtMin(ms: unknown): string | null {
	if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
	// Date の上限 (±8.64e15) を超えると toISOString が投げる。mtime では起きないが、
	// この関数は例外を投げない約束なので範囲も見る。
	const floored = Math.floor(ms / 60000) * 60000;
	if (floored > 8.64e15) return null;
	return new Date(floored).toISOString();
}

/** The per-column card counts every board view shows. */
function countCols(b: Pick<Board, "cards">): { todo: number; doing: number; done: number } {
	return { todo: cardsIn(b, "todo").length, doing: cardsIn(b, "doing").length, done: cardsIn(b, "done").length };
}

/**
 * "⚠Nd" / "⚠Nh" for a stale age, else null. One ladder for the footer and the
 * injection text: days from STALE_DAY_MS, hours from STALE_MS.
 */
export function staleSince(ageMs: number): string | null {
	if (ageMs >= STALE_DAY_MS) return `⚠${Math.floor(ageMs / STALE_DAY_MS)}d`;
	if (ageMs >= STALE_MS) return `⚠${Math.floor(ageMs / 3_600_000)}h`;
	return null;
}

/**
 * Age of the oldest stamped DOING card, -Infinity when nothing is stamped.
 * Cards with no movedAt are skipped: an unstamped card's age is unknown, and
 * guessing one would be a lie. -Infinity fails every comparison in staleSince,
 * so the divisions there are never fed it.
 */
export function oldestDoingAge(b: Board, now: number): number {
	let oldest = Number.POSITIVE_INFINITY;
	for (const c of cardsIn(b, "doing")) {
		if (typeof c.movedAt === "number" && c.movedAt < oldest) oldest = c.movedAt;
	}
	return now - oldest;
}

/** " ⚠Nd"/" ⚠Nh" for the oldest DOING card past STALE_MS, else "". */
export function staleTag(b: Board, now = Date.now()): string {
	const since = staleSince(oldestDoingAge(b, now));
	return since === null ? "" : ` ${since}`;
}

// --- #23: 週次サマリ ---------------------------------------------------------
// 完走・停滞・ブロックの一覧をプロジェクト別に出す。LLM は呼ばない。
// 集計はここ（純関数）だけが持ち、tick と HTTP と GUI はそれを呼ぶだけにする。

export type WeeklyBuckets = {
	done: { id: number; text: string; at: number }[];
	stale: { id: number; text: string; days: number }[];
	blocked: { id: number; text: string; blocked: string }[];
};
export type WeeklySummary = {
	week: string; // "2026-W35"
	from: number; // ISO 週の月曜 00:00 UTC (epoch ms)
	to: number; // 翌週月曜 00:00 UTC
	generatedAt: number;
	projects: ({ slug: string } & WeeklyBuckets)[];
	totals: { done: number; stale: number; blocked: number };
};

/**
 * ISO 8601 の週 ("2026-W35"). UTC だけで計算する: ブラウザもサーバも無い純関数なので、
 * ローカル時刻を混ぜると同じ日付が実行環境で別の週になる。
 * 週は「その週の木曜が属する年」で決まる（1/1 が木曜までの年は前年の第 53 週に入る）。
 */
export function isoWeek(d: Date): string {
	const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
	const day = t.getUTCDay() || 7; // Sunday は 7（ISO では週の最後）
	t.setUTCDate(t.getUTCDate() + 4 - day); // その週の木曜
	const year = t.getUTCFullYear();
	const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
	return `${year}-W${String(week).padStart(2, "0")}`;
}

/**
 * "2026-W35" -> 月曜 00:00 UTC からの 7 日間。存在しない週は null。
 * 往復（isoWeek(from) === 引数）を通せない週は存在しないので、そこだけが検証になる:
 * "2026-W54" のような形だけ正しい週を弾くために週数の表を持たない。
 */
export function weekRange(week: string): { from: number; to: number } | null {
	const m = /^(\d{4})-W(\d{2})$/.exec(week);
	if (m === null) return null;
	const year = Number(m[1]);
	const num = Number(m[2]);
	if (num < 1 || num > 53) return null;
	// 1/4 は必ず第 1 週に入る。その週の月曜が第 1 週の月曜。
	const jan4 = Date.UTC(year, 0, 4);
	const day = new Date(jan4).getUTCDay() || 7;
	const from = jan4 - (day - 1) * 86_400_000 + (num - 1) * 7 * 86_400_000;
	if (isoWeek(new Date(from)) !== week) return null;
	return { from, to: from + 7 * 86_400_000 };
}

/**
 * 一週間のサマリ。`boards` は projectBoardsOf() の形（slug は正規化済みの真実）で、
 * `card.project` は見ない — ボードの slug と食い違う行が混ざる余地を残さないため。
 *
 * 近似（仕様として受け入れる）: movedAt は上書きされるので、done -> doing -> done と
 * 往復したカードの完了時刻は最後の移動になる。card に作成時刻が無いので「今週追加された
 * カード」は数えない。
 */
export function weeklySummary(boards: { slug: string; cards: Card[] }[], week: string, now: number): WeeklySummary {
	const r = weekRange(week);
	const from = r === null ? 0 : r.from;
	const to = r === null ? 0 : r.to;
	const projects = boards.map(({ slug, cards }) => {
		const done: WeeklyBuckets["done"] = [];
		const stale: WeeklyBuckets["stale"] = [];
		const blocked: WeeklyBuckets["blocked"] = [];
		for (const c of cards) {
			// movedAt が無いカードの時刻は不明。at: 0 を捏造すると 1970 年の完了になる。
			if (typeof c.movedAt === "number") {
				if (c.col === "done" && c.movedAt >= from && c.movedAt < to) {
					done.push({ id: c.id, text: c.text, at: c.movedAt });
				}
				// 停滞の閾値は GUI の ⚠Nd と同じ STALE_DAY_MS を使う（数字が食い違うと嘘になる）。
				if (c.col === "doing" && now - c.movedAt >= STALE_DAY_MS) {
					stale.push({ id: c.id, text: c.text, days: Math.floor((now - c.movedAt) / STALE_DAY_MS) });
				}
			}
			if (typeof c.blocked === "string" && c.blocked !== "") {
				blocked.push({ id: c.id, text: c.text, blocked: c.blocked });
			}
		}
		return { slug, done, stale, blocked };
	});
	const sum = (k: keyof WeeklyBuckets) => projects.reduce((n, p) => n + p[k].length, 0);
	return {
		week,
		from,
		to,
		generatedAt: now,
		projects,
		totals: { done: sum("done"), stale: sum("stale"), blocked: sum("blocked") },
	};
}

/**
 * The board key for a scope: project is keyed by the cwd's slug, everything else by the
 * session. paintLoop, refresh and settle all read it from here — the three copies it
 * replaces drifted, and a project halt landed on a key nobody ever drew.
 */
function boardKeyFor(ctx: ExtensionContext, sid: string, scope: Scope): string {
	// #34: modes.json keyed by a JS object is case-sensitive while the DB is NOCASE, so every
	// reader has to agree on the stored spelling - the GUI writes it, so the loop must read it.
	return scope === "project" ? storedProjectKey(projectSlugOf(cwdOfCtx(ctx))) : sid;
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
	// #47: GLOBAL 行は廃止。集計カウントは dashboard 側の統計帯が受け持つ。
	const f = readModesFile();
	// #17: the only line is this cwd's PROJECT board. Its halt tag and count ride that
	// line, or a project halt stops the board with nothing on screen.
	const projectKey = boardKeyFor(ctx, sessionId, "project");
	const project = readBoard(boardPath("project", projectKey));
	const ownTag = loopTagFor(sessionId, "project");
	const ownModes = modeTags(f, projectKey, "project", sessionId);
	// Appended to the (now single) PROJECT line: the API state stays visible.
	// #64: `stale` and `fatal` are states the human must see, not just "DOWN".
	const apiTag =
		apiState === "down"
			? " API DOWN"
			: apiState === "stale"
				? " STALE"
				: apiState === "fatal"
					? " PORT BLOCKED"
					: "";
	// Same line again: a loop halt is a status tag, not a second row.
	ctx.ui.setWidget(
		WIDGET_KEY,
		[
			// #47: one line only. The API tag rides it: a dead API must never be silent.
			`PROJECT: ${projectKey}: ${countsOf(project)}${staleTag(project)}${ownTag}${ownModes}${apiTag}`,
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

/**
 * " loop pick 3/10" — only what is ON is shown, so an idle footer never grows.
 * `key` is the board key (a slug for project); the COUNT is always published per
 * (session, scope), so `countSid` stays the session even when the board is a slug.
 */
function modeTags(f: ModesFile, key: string, scope: Scope, countSid = key): string {
	const m = modesFor(f, key, scope);
	const tags = `${m.doingLoop ? " loop" : ""}${m.autoPick ? " pick" : ""}`;
	if (tags === "") return "";
	const count = loopCount.get(tagKey(countSid, scope));
	return tags + (count === undefined ? "" : ` ${loopRestText(maxLoopsOf(m), count)}`);
}

/**
 * The count this session has used on ONE board, for the dashboard's 「残り N / 上限」 row.
 * project counts too: it is the default board, and leaving it out showed 「残り 10/10」
 * for a loop that was one wake from its cap.
 */
function loopCountOf(sessionId: string, scope: Scope): number {
	return loopCount.get(tagKey(sessionId, scope)) ?? 0;
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
 * One-line, tag-free label for anywhere a name leaves the widget: the footer is a
 * single line of text, so a `/skill <name>` title (which carries `<` and `"`) used
 * to cut the footer in half at the tag.
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
	// #18: from STALE_DAY_MS the span reads in days, and past STALE_MS it carries
	// the same "⚠Nh"/"⚠Nd" tag the footer shows.
	const doingAge = (c: Card): string => {
		if (typeof c.movedAt !== "number") return "";
		// Clamped: a movedAt in the future (clock skew) must not read as negative minutes.
		const age = Math.max(0, Date.now() - c.movedAt);
		const since = staleSince(age);
		// Past STALE_MS the tag carries the span itself (⚠5h / ⚠2d), so no second copy of it.
		return since === null ? `(${Math.floor(age / 60_000)}分前から)` : `(${since})`;
	};
	const line = (col: Col): string => {
		const list = cardsIn(b, col).map((c) => `${formatCard(c)}${col === "doing" ? doingAge(c) : ""}`);
		if (col === "done") {
			const total = list.length;
			if (total === 0) return `${COL_LABELS[col]}(none)`;
			return `${COL_LABELS[col]}(計${total}件) ${list.slice(-INJECT_DONE).join(" / ")}`;
		}
		return `${COL_LABELS[col]}${list.length === 0 ? "(none)" : list.join(" / ")}`;
	};
	const inbox = inboxNudgeLine(); // null when nothing is unread: no empty line
	return [
		"=== KANBAN (this project) ===",
		line("todo"),
		line("doing"),
		line("done"),
		...(inbox === null ? [] : [inbox]),
		`GUI: open ${boardUrlBare()} in a browser.`,
		// #83b: the bare URL is not enough any more; one line says where the token comes from.
		// The token value itself never enters the prompt (it would be replayed to the model
		// on every poll and end up in transcripts).
		"TOKEN: /kanban url (or the `kanban` url action) prints the link that sets the cookie.",
		// #93: the threshold is measured, not guessed. Across 1941 past turns, `deliv>=3`
		// is 13% of requests but 43% of assistant work, and 37% of those runs exceed 30
		// minutes — the region where state has to survive across turns. `deliv=2` is
		// usually one file plus a check (median 16 messages / 7 min), so splitting there
		// just turns the board into a log of what was done instead of what is owed.
		"Use the `kanban` tool to hold what you owe, not what you did.",
		"",
		"Open a card when a request needs three or more separate pieces of work —",
		"three files, three delegations, or a mix. Below that, just do it.",
		"",
		"A card is a promise to finish something. Keep going without waiting:",
		"if the user goes quiet, the board is what tells the next turn what is",
		"owed. Move it to DONE only when the thing actually works.",
		// #82/#92: output has its own table (and now its own tool), so a model that reaches for
		// col=deliverable is told why not. One pointer line: the tool description carries the rest.
		"Output to show the user → the deliverable tool. A card is work you owe.",
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
// #51-③: every injection we generate starts with this, so a wake we sent is never mistaken
// for a user steer (both arrive as role "user").
export const LOOP_PROMPT_PREFIX = "[kanban-loop] ";
// #51-⑤(a): when the 80-char bound cut the text, say where the whole thing is.
const TRUNCATED_NOTE = "（本文は省略。全文は kanban ツールで確認）";
// #51-⑤(b): from the second strike on, the prompt says which settle this is.
const STUCK_NOTE_FROM = 2;

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

/** #51-⑤: the two situations worth one extra clause, both optional (absent = old text). */
export type ContinuationExtra = {
	/** the settle count for this card (1 = first). Shown from the second strike on. */
	stuck?: { count: number; limit: number };
	/** why the halt was just lifted: said once, on the first injection after a resume. */
	resumeNote?: "stuck" | "limit";
};

export function continuationPrompt(card: Card, scope: Scope, extra: ContinuationExtra = {}): string {
	// A global card and a session card can share an id, so the prompt must name the board.
	const body = `#${card.id} "${cardTextForPrompt(card.text)}" を完了させろ。終わったら kanban ツール`;
	// Phase 10: a TODO wake must ask for the move first. The DOING wording is unchanged.
	let out: string;
	// ⑤(a): a cut card body is only readable on the board, so point at it.
	const clipped = Array.from(typeof card.text === "string" ? card.text : "").length > CARD_TEXT_MAX;
	if (card.col === "todo") {
		const head = scope === "global" ? `GLOBAL TODO #${card.id}` : `TODO #${card.id}`;
		const tail = scope === "global" ? " (scope=global) で DOING" : " で DOING";
		out = `${head} "${cardTextForPrompt(card.text)}" を着手しろ。kanban ツール${tail} に移してから作業しろ。`;
	} else {
		out =
			scope === "global"
				? `GLOBAL DOING ${body} (scope=global) で DONE に移せ。`
				: `DOING ${body} で DONE に移せ。`;
	}
	if (clipped) out += TRUNCATED_NOTE;
	const notes: string[] = [];
	if (extra.resumeNote !== undefined) notes.push(`停止理由 halted:${extra.resumeNote} は解除済み`);
	if (extra.stuck !== undefined && extra.stuck.count >= STUCK_NOTE_FROM) {
		notes.push(`stuck ${extra.stuck.count}/${extra.stuck.limit}（上限で halt）`);
	}
	if (notes.length > 0) out += `（${notes.join(" / ")}）`;
	return LOOP_PROMPT_PREFIX + out;
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

/**
 * The DOING card a scope holds, ignoring that scope's switch. `key` names the board
 * (a project slug, or "" for global); `actor` is the session whose moves count, because
 * every board is shared now and only our own DOING may drive us.
 */
function doingHeadOf(key: string, scope: Scope, actor: string, now: number = Date.now()): Card | undefined {
	return headOwnedDoing(readBoard(boardPath(scope, key)), actor, now);
}

/** The card a scope may drive: nothing at all when its doingLoop switch is off. */
function candidates(key: string, scope: Scope, f: ModesFile, actor: string): Card | undefined {
	return modesFor(f, key, scope).doingLoop ? doingHeadOf(key, scope, actor) : undefined;
}

/**
 * Head of DOING for a scope, from cards already in hand. Every board is shared, so only
 * cards THIS session moved may drive it: an ownerless card belongs to whoever claims it.
 */
export function tickCardFor(cards: Card[], sid: string, now: number = Date.now()): Card | undefined {
	return cards
		.filter((c) => c.col === "doing" && c.movedBy === sid && !isSilent(c, now))
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
	// #51-②: the settle chain's own last injection. The chain never touches lastTickAt (the
	// poll owns that clock), so without this a loop that keeps settling looks 5 minutes old
	// forever and the starvation guard below could never open. 0/absent = never.
	lastChainAt?: number;
	lastActivityAt?: number; // undefined = no activity recorded: treat as "just active"
	now: number;
	intervalMs?: number; // omit -> AUTO_TICK_MS (legacy entries)
	menuOpen?: boolean; // a /kanban dialog is on screen: never speak behind it
	// #94: a TODO just arrived from the dashboard's "+". Opens the two TIME gates once;
	// every gate above it still decides on its own.
	forced?: boolean;
}): { fire: boolean; reason: string; quiet: boolean } {
	const interval = i.intervalMs ?? AUTO_TICK_MS;
	// Starvation guard: lastActivityAt is a heuristic. If something keeps stamping it,
	// the quiet gate below would never open and the loop would stall forever. Silence
	// on BOTH injection clocks for STARVATION_FACTOR intervals overrides the activity clock.
	// #51-②: whichever clock spoke last decides, so a live settle chain (which only stamps
	// lastChainAt) keeps the guard closed instead of starving on a stale lastTickAt.
	const starved = i.now - Math.max(i.lastTickAt, i.lastChainAt ?? Number.NEGATIVE_INFINITY) >= interval * STARVATION_FACTOR;
	// Unknown activity means the user may be right here: skipping one wake is far
	// cheaper than talking over them, so an absent clock never fires (unless starved).
	const quiet = starved || (i.lastActivityAt !== undefined && i.now - i.lastActivityAt >= interval);
	// Both clocks must be silent for a full interval. lastTickAt alone only proves the
	// last injection is old; a user message a second ago would still pass it.
	// #51-②: whichever injection clock (poll / settle chain) spoke last is what "old" means.
	const lastInjected = Math.max(i.lastTickAt, i.lastChainAt ?? Number.NEGATIVE_INFINITY);
	// The gates that no clock can open: menu, switch off, nothing to do, busy, halted.
	const gate =
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
							: "";
	// #94: a TODO just added in the dashboard skips the interval and quiet gates once. It
	// stays below every gate above: a "+" must not restart a halted or switched-off loop.
	if (gate === "" && i.forced === true) return { fire: true, quiet, reason: "forced" };
	const reason = gate !== "" ? gate : i.now - lastInjected < interval ? "interval" : !quiet ? "not-quiet" : "";
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
/** Text of an AgentMessage whose content is a string or a content array. */
function messageText(m: unknown): string {
	if (typeof m !== "object" || m === null) return "";
	const content = (m as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
		.join("");
}

/**
 * #51-③: is this queued message the USER steering, rather than a wake we sent ourselves?
 * Our own wake also lands as role "user" (sendUserMessage), so the `[kanban-loop]` prefix is
 * the only thing that tells them apart; without it every poll wake would look like a steer.
 */
function isUserSteer(m: unknown): boolean {
	if (typeof m !== "object" || m === null) return false;
	if ((m as { role?: unknown }).role !== "user") return false;
	return !messageText(m).startsWith(LOOP_PROMPT_PREFIX);
}

/**
 * Pure: is the run the user's? True when the head message is the user's, or when the user
 * still has a message QUEUED (pi exposes it as `event.context.pendingMessages` =
 * peekQueuedMessages + pending custom messages). A steer that has not run yet is the user
 * speaking; injecting over it is the same noise as injecting into their own prompt.
 * Unknowable input returns false = inject: a loop that silently stops is the worse failure.
 */
export function isUserInputHead(messages: unknown[] | undefined, pending?: unknown[]): boolean {
	if (Array.isArray(pending) && pending.some(isUserSteer)) return true;
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
	| { kind: "url" }
	| { kind: "reject"; reason: string };

const KANBAN_HELP =
	"/kanban <タスク内容>  TODO に追加（add は省略可）\n" +
	"/kanban add <タスク内容>  同じ（空のカードは作りません）\n" +
	"/kanban priority <id> [n]  優先度（大きいほど先に autoPick、-99〜99。無指定で表示、id 無しで TODO 一覧）\n" +
	"/kanban img <id> <path>  ローカル画像を #id に添付（media/ にコピー、8MBまで）\n" +
	// ツール専用の操作。`/kanban edit ...` はコマンドとして実在しない（parseKanbanArgs に無い語は
	// カード追加になる）ので、スラッシュ記法では書かない。
	"kanban ツール action=\"edit\" <id> <本文>  本文を差し替える（列・所有権は変わらない。空は不可）\n" +
	"/kanban interval <分>  自動再開の間隔（無指定で現在値）\n" +
	"/kanban stuck <回>  スタック判定の閾値（無指定で現在値）\n" +
	"/kanban maxloops <回>  ループ上限（無指定で現在値、0 = 無制限）\n" +
	"/kanban loop on|off|status / pick on|off  自動再開ループ / 自動ピック（このプロジェクトボードのスイッチ）\n" +
	"/kanban take  auto-tick の駆動元をこのセッションに切り替える\n" +
	"/kanban url  この看板を開く URL（トークン付き）\n" +
	// #90: ツールの description から落とした正規化規則の置き場所。既存の行は消さない。
	"カードの project は [A-Za-z0-9._-]（24 文字まで・大文字小文字は保持）、session は [A-Za-z0-9._:@-]、commit は 7-40 hex（小文字で保存）。空文字は解除\n" +
	"ref は元ファイルを指すだけ（file:<path>、コピーしない）。ダッシュボードは /api/ref 経由で読み、serve の許可ルート（既定 ~/workspace）の外は開けない\n" +
	// #92: 成果物は別ツール。kanban の img/ref は card 専用（id 空間が別）。
	"deliverable ツール（add/list/edit/remove/img/ref）は成果物専用。見せたい出力は card ではなくこちらに置く\n" +
	"ボードは project（既定）/ global（読み取り専用）の 2 つ。session ボードは #17 で廃止\n" +
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
	// #83b: the board needs a token; this is how a human gets one without reading the file.
	if (head === "url") return { kind: "url" };
	if (head === "add") {
		const text = argv.slice(1).join(" ").trim();
		return text.length === 0 ? { kind: "reject", reason: "使い方: /kanban add <タスク内容>（空のカードは作りません）" } : { kind: "add", text };
	}
	const key = MODE_KEY[head];
	if (key !== undefined) {
		const sub = argv[1];
		if (sub !== undefined && sub !== "on" && sub !== "off" && sub !== "status") {
			return { kind: "reject", reason: "使い方: /kanban loop on|off|status / /kanban pick on|off" };
		}
		// #29: scope=session は #17 で消えた語で、HTTP は 400 SESSION_SCOPE_GONE で弾く。
		// scope 無指定と同じに読むと、誰も名指ししていない project ボードのスイッチを書く。
		if (argv.slice(2).includes("session")) return { kind: "reject", reason: SESSION_SCOPE_GONE };
		const scope: Scope | undefined = argv.slice(2).includes("global") ? "global" : undefined;
		if (sub === "on" || sub === "off") {
			return { kind: "mode", key, value: sub === "on", ...(scope === undefined ? {} : { scope }) };
		}
		return { kind: "modeStatus", key, ...(scope === undefined ? {} : { scope }) };
	}
	if (head === "interval") {
		const global = argv[1] === "global";
		const minutesTok = global ? argv[2] : argv[1];
		const scope: Scope = global ? "global" : "project";
		if (minutesTok === undefined) return { kind: "intervalStatus", scope };
		const minutes = Number(minutesTok);
		if (!Number.isFinite(minutes) || minutes <= 0) {
			return { kind: "reject", reason: `使い方: /kanban interval <分>（0より大きい数値）: ${minutesTok}` };
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
		const scope: Scope = global ? "global" : "project";
		if (countTok === undefined) return { kind: "stuckStatus", scope };
		const count = Number(countTok);
		if (!isValidStuckLimit(count)) {
			return { kind: "reject", reason: `使い方: /kanban stuck <回>（1〜${MAX_STUCK_LIMIT}の整数）: ${countTok}` };
		}
		return { kind: "stuck", scope, count };
	}
	if (head === "maxloops") {
		// #67: 0 = 無制限. Same shape as `stuck`, one number, same scope syntax.
		const global = argv[1] === "global";
		const nTok = global ? argv[2] : argv[1];
		const scope: Scope = global ? "global" : "project";
		if (nTok === undefined) return { kind: "maxLoopsStatus", scope };
		const n = Number(nTok);
		if (!isValidMaxLoops(n)) {
			return { kind: "reject", reason: `使い方: /kanban maxloops <回>（0〜${MAX_LOOPS_CAP}の整数、0 = 無制限）: ${nTok}` };
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
 * #52: TODO ownership, for the dashboard view and for autoPick. A TODO's owner is the
 * session that last touched it (`movedBy`), because nobody has claimed it as work yet.
 * Absent/"" means unowned: the first card a session drops in belongs to nobody, so every
 * session may see and pick it. An empty sid (a curl, a process with no driver session)
 * keeps the old "everything is visible" answer - there is no viewer to hide it from.
 */
export function todoMineOrUnowned(c: Card, sid: string, scope: Scope = "project"): boolean {
	if (!sid) return true;
	if (scope === "global") return true; // #87: GLOBAL は sid 区分が意味を持たない (aggregate)。無主判定をしない
	return !c.movedBy || c.movedBy === sid;
}

/**
 * Pure: the TODO autoPick would move next, without moving it. `pickFirstTodo` uses
 * this too, so the poll's wake card is the same card the settle will pick.
 * scope/sid stay in the signature: they are the poll/settle call convention, and every
 * caller (and test) passes them.
 * #52: another session's TODO is no longer picked automatically - it stops a sibling's
 * half-started card being dragged into this session's turn. Picking it stays possible by
 * hand (dashboard drag / `kanban` move), which is the explicit door the spec asks for.
 */
export function nextTodo(cards: Card[], _scope: Scope, sid: string, now: number = Date.now()): Card | undefined {
	// orderTodos: priority descending, then id ascending (the old rule at equal priority).
	// Silent cards are dropped before ordering, so a blocked/scheduled head cannot
	// starve the pickable card behind it (autoPick as a whole stays alive).
	return orderTodos(cards.filter((c) => c.col === "todo" && !isSilent(c, now) && todoMineOrUnowned(c, sid, _scope)))[0];
}

/**
 * Move the first TODO card into DOING. Returns the card, or null when there is no
 * TODO left. autoPick keeps a card moving, so the stale warning starts now.
 *
 * #87 CAS: with TODO ownership gone, two sessions may aim at the same card. The move is
 * a read-modify-write, so the card is re-read from disk right before the write and only
 * moved while it is STILL an unclaimed TODO. The claim itself is the write: `movedBy`
 * holds one value, so the winner's name survives and the loser's `headOwnedDoing` no
 * longer matches. There is no file lock to reuse (the session-wide write lock was removed
 * in 2e5d4ca); inside one process the whole read/verify/write block is synchronous, so
 * the only remaining window is another process pre-empting between the two file ops.
 */
export function pickFirstTodo(sessionId: string, scope: Scope, actor: string = sessionId): Card | null {
	const path = boardPath(scope, sessionId);
	// The claim is the ACTOR, never the board key (a project key is a slug), so the pick
	// filter and the CAS below both look through the session that will own the card.
	const target = nextTodo(readBoard(path).cards, scope, actor);
	if (target === undefined) return null;
	const b = readBoard(path); // CAS: re-read, do not trust the snapshot we chose from
	const live = b.cards.find((c) => c.id === target.id);
	// #52: a sibling that stamped it between our read and this re-read now owns it.
	if (live === undefined || live.col !== "todo" || isSilent(live) || !todoMineOrUnowned(live, actor, scope)) return null;
	// The claim is the SESSION, not the board key: a project board's key is a slug, and
	// the poll's ownership filter compares movedBy against the session.
	moveCardTo(live, "doing", actor);
	writeBoard(path, b);
	// Read back: if a sibling wrote between our verify and our rename, its movedBy is what
	// survived and this session must not go on working as if it owned the card.
	const claimed = readBoard(path).cards.find((c) => c.id === target.id);
	if (claimed === undefined || claimed.movedBy !== actor) return null;
	return claimed;
}

/**
 * Record that the wake for THIS schedule happened: firedFor = the nextFireAt we acted
 * on, so `nextFireAt !== firedFor` means "armed again". nextFireAt itself is never moved
 * (the user decides when it fires next). Call ONLY after a successful injection: a
 * pre-write would turn a failed wake into permanent silence.
 * 同じ nextFireAt の再設定では再発火しない（firedFor と等値）。再点火したいなら値をずらす。
 */
function markFired(card: Card, key: string, scope: Scope): void {
	if (fireAtMs(card) === null) return;
	const path = boardPath(scope, key);
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
 * #80-⑨: the names this server answers to. Same-host Origin cannot tell an attacker's
 * domain from ours — that is exactly what DNS rebinding buys: `evil.example` resolves to
 * 127.0.0.1, so the browser sends `Host: evil.example` and sees a same-origin page. The
 * Host header is the one place the name the browser used survives, so it is checked
 * against this finite set before anything else looks at the request.
 *
 * Read per request, not cached: interfaces change under us (tailscale up/down, a new
 * docker bridge) and the user's fix is to reload, not to restart the server. The set is
 * small and networkInterfaces() is a netlink read, far cheaper than the board work behind
 * it. The learned serve host is NOT in here on purpose — it was learned from a Host header,
 * so trusting it would make the allowlist self-poisoning.
 */
function allowedHosts(): Set<string> {
	// `nas` is this deployment's established spelling (`http://nas:8789/`) and is carried by
	// no interface, so leaving it out would 403 a board that worked the day before this gate
	// landed. Any other alias a user reaches the board as still has to be listed in
	// KANBAN_HOSTS — those are open-ended in a way this one is not.
	const names = new Set(["localhost", "127.0.0.1", "::1", "::ffff:127.0.0.1", "nas", hostname().toLowerCase()]);
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries ?? []) names.add(entry.address.toLowerCase());
	}
	// #80-⑨: the escape hatch. A user who reaches the board as `nas` (a DNS alias, a
	// MagicDNS name, a reverse proxy) has no interface carrying that spelling, and `nas` is
	// also what the dashboard passes on to /serve — refusing it would break a working setup.
	for (const raw of (process.env.KANBAN_HOSTS ?? "").split(",")) {
		const name = hostNameOf(raw);
		if (name.length > 0) names.add(name);
	}
	return names;
}

/**
 * #80-⑨: the Host gate. Applies to every path, `/` included, because the token gate
 * below deliberately lets `/` through (it is where the cookie is handed out) and the
 * Origin gate only knows how to judge a browser. A missing Host is refused: HTTP/1.1
 * requires one, so its absence is a hand-built request, not a browser.
 * The port is ignored (hostNameOf) — the listener port is ours and the dashboard's
 * absolute origin uses it on a different port anyway.
 */
function hostRefusal(req: IncomingMessage): boolean {
	const raw = req.headers.host;
	if (typeof raw !== "string") return true;
	return !allowedHosts().has(hostNameOf(raw));
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
 * #83b: the whole /api surface and /serve are token-gated (0.0.0.0 listener, no auth
 * before this). A wrong/missing token is a 401 before the Origin gate below runs; the
 * gate stays as the second layer. The agent's own tools write the store directly and
 * never come through here, so requiring a token breaks no in-process caller.
 */
function tokenMatches(candidate: string | null): boolean {
	const expected = ensureToken();
	if (candidate === null || candidate === "") return false;
	const a = Buffer.from(candidate);
	const b = Buffer.from(expected);
	if (a.length !== b.length) return false; // constant-time only compares equal lengths
	return timingSafeEqual(a, b);
}

/** The caller's token: `?token=` (curl, scripts) or the `kb_auth` cookie (the page). */
function callerToken(req: IncomingMessage, q: URLSearchParams): string | null {
	const fromQuery = q.get("token");
	if (fromQuery !== null && fromQuery !== "") return fromQuery;
	const raw = req.headers.cookie;
	if (typeof raw !== "string") return null;
	for (const part of raw.split(";")) {
		const eq = part.indexOf("=");
		if (eq < 0) continue;
		if (part.slice(0, eq).trim() !== TOKEN_COOKIE) continue;
		return part.slice(eq + 1).trim();
	}
	return null;
}

function isAuthorized(req: IncomingMessage, q: URLSearchParams): boolean {
	return tokenMatches(callerToken(req, q));
}

/**
 * #85: the "go get a token" text lives in the dashboard's own 401 handler (authFail), not
 * in a separate error page: `/` is always served now, so the page a stale bookmark lands
 * on is the board itself, saying where the URL comes from.
 */

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
	if (pathname === "/api/upload" || pathname === "/api/upload2" || pathname === "/api/selftest") return true;
	// #13: DB の診断と VACUUM も「読むだけの GET」では踏ませない（VACUUM は書き込み）。
	if (pathname === "/api/db/diagnose" || pathname === "/api/db/vacuum") return true;
	if (pathname === "/api/host" || pathname === "/api/serve") return true;
	if (method === "POST" && (pathname === SERVE_PREFIX || pathname.startsWith(`${SERVE_PREFIX}/`))) return true;
	if (method !== "GET") return false;
	switch (pathname) {
		case "/api/add":
		case "/api/quickadd":
		case "/api/move":
		case "/api/remove":
		case "/api/rename":
		case "/api/modes":
		case "/api/interval":
		case "/api/stuck":
		case "/api/maxloops":
		case "/api/resume":
		case "/api/halt":
		case "/api/priority":
		case "/api/schedule":
		case "/api/project":
		case "/api/decision":
		case "/api/attach/del":
		// #82: the deliverables' three write routes.
		case "/api/deliv/add":
		case "/api/deliv/edit":
		case "/api/deliv/remove":
			return true;
		default:
			return false;
	}
}

/**
 * #80-⑥: GET is not a safe verb on the write surface. Eleven routes take their arguments
 * from the query, so anything that merely *follows* a URL — an unfurl bot, a URL scanner, a
 * proxy prefetch, a link a logged-in user clicks — mutates the board. The token gate does
 * not cover it: the browser sends kb_auth along with a clicked link, and a shared `?token=`
 * link carries the secret in the URL itself.
 *
 * Sec-Fetch-Site is what tells those callers apart, and it is a forbidden header name — a
 * page can neither set nor omit it. Present and not `same-origin` means the fetch was not
 * this page's own action (a pasted URL/bookmark is `none`, a card in a chat app is
 * `cross-site`, `same-site` is a sibling origin), so a write GET is refused. `same-origin`
 * stays a 200: it is the dashboard's own click, and breaking it takes the whole GUI (#38).
 *
 * 暫定 / PROVISIONAL: no Sec-Fetch-Site = let through untouched. curl, an older browser, a
 * sibling pi's probe and every script caller send none, and they are outside the
 * prefetch/CSRF threat model. Tighten this — require the header on the write surface — once
 * Sec-Fetch-* is universal and those callers present the token instead.
 */
function methodNotAllowedOnGet(req: IncomingMessage, pathname: string): boolean {
	if (req.method !== "GET") return false; // POST keeps its own dispatch (405 or the POST routes)
	const site = req.headers["sec-fetch-site"];
	if (typeof site !== "string") return false; // 暫定: header-less caller = pre-Sec-Fetch-* client
	if (site.trim().toLowerCase() === "same-origin") return false; // the dashboard itself
	return isWritePath(pathname, "GET");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

/**
 * #85: the dashboard poller gets a body hash so an unchanged board costs a header round
 * trip instead of the whole payload. There is no cache layer on purpose — the body is
 * built every request, so every write changes the hash by construction. `no-cache` (not
 * `no-store`) keeps the 304 reachable: the client must revalidate, not stop asking.
 *
 * The caller's CORS headers (and `Vary: Origin`) are already on the response and are left
 * alone here; a 304 the browser cannot read is worthless, so they ride along.
 */
function sendEtagJson(req: IncomingMessage, res: ServerResponse, body: string): void {
	const etag = `"${createHash("sha1").update(body).digest("hex")}"`;
	res.setHeader("ETag", etag);
	res.setHeader("Cache-Control", "no-cache");
	const inm = req.headers["if-none-match"];
	// Weak comparison (RFC 9110): W/ prefixes are the same representation for our purpose.
	const match =
		typeof inm === "string" && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag);
	if (match) {
		res.writeHead(304);
		res.end();
		return;
	}
	res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
	res.end(body);
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

// --- #23: 週次サマリの自動生成 -----------------------------------------------
// 専用の setInterval は作らない（ensurePollTimer が唯一のタイマー生成箇所という
// 不変条件を壊さない）。poll() に相乗りし、中で時刻で間引く点は sweep と同じ。
const WEEKLY_MS = 60 * 60 * 1000;
const WEEKLY_LAST = "weekly:lastWeek"; // 直近に観測した ISO 週
const WEEKLY_KEY = "weekly:"; // weekly:<week> -> WeeklySummary の JSON
const WEEKLY_INDEX = "weekly:index"; // 保存済みの週（?week= で引ける一覧）
let lastWeeklyAt = 0;

/** 保存済みの週。壊れた値は空で読み直す（索引は導出物でしかない）。 */
function weeklyIndex(db: KanbanDb): string[] {
	const raw = db.getMeta(WEEKLY_INDEX);
	if (raw === null) return [];
	try {
		const v = JSON.parse(raw) as unknown;
		return Array.isArray(v) ? v.filter((w): w is string => typeof w === "string") : [];
	} catch {
		return [];
	}
}

/**
 * その週の行を meta に書く。例外は握る: tick の中で投げると poll の deadCtx 判定に
 * 巻き込まれ、セッションが死んでいないのに poll が止まる。週次は導出物なので、
 * 失敗してもボードは正しいまま。
 */
function storeWeekly(week: string, now: number): void {
	try {
		const db = kanbanDb();
		db.setMeta(WEEKLY_KEY + week, JSON.stringify(weeklySummary(projectBoardsOf(allRollupCards()), week, now)));
		const idx = weeklyIndex(db);
		if (!idx.includes(week)) {
			idx.push(week);
			idx.sort();
			db.setMeta(WEEKLY_INDEX, JSON.stringify(idx));
		}
	} catch (err) {
		process.stderr.write(`kanban: weekly summary failed: ${(err as Error).message}\n`);
	}
}

/**
 * 毎 tick 呼ばれるが、実際に動くのは 1 時間に 1 回だけ。
 * 週が変わったら先週の行をもう一度作ってから今週を作る: 週末の最終 tick 以降の移動を
 * 先週の側に拾い直すため（movedAt は上書きされるので、放っておくと先週の事実が消える）。
 *
 * 本体は丸ごと握る: 呼び元は setInterval のコールバックなので、ここを抜けた throw は
 * uncaughtException に達し、deadCtx 経路と違って pi プロセスごと落ちる。
 * `now` はテストが時刻を注入するため（実時計に依存させない）。
 */
export function weeklyTickThrottled(now: number = Date.now()): void {
	if (now - lastWeeklyAt < WEEKLY_MS) return;
	lastWeeklyAt = now; // 失敗しても 1 時間は再試行しない（毎 tick 叩き続けない）
	try {
		const db = kanbanDb();
		const cur = isoWeek(new Date(now));
		const last = db.getMeta(WEEKLY_LAST);
		if (last !== null && last !== cur && weekRange(last) !== null) storeWeekly(last, now);
		storeWeekly(cur, now);
		if (last !== cur) db.setMeta(WEEKLY_LAST, cur);
	} catch (err) {
		process.stderr.write(`kanban: weekly tick failed: ${(err as Error).message}\n`);
	}
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
 * #94: what the board calls itself. This used `os.hostname()` directly, so a box whose
 * /etc/hostname is a docker container id titled the page "KANBAN - 0ac4a588fea8" while
 * every /serve URL it handed out said "nas". The learned host is the name the user's
 * browser actually reaches this machine by, so the title should agree with the URLs.
 */
function hostLabel(): string {
	return learnedServeHost() ?? hostname();
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
		const tmp = `${SERVE_HOST_JSON}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify({ host, at: new Date().toISOString() }));
		renameSync(tmp, SERVE_HOST_JSON);
	} catch {
		// a read-only HOME must still serve
	}
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
			const tmp = `${SERVE_HOST_JSON}.${process.pid}.tmp`;
			writeFileSync(tmp, JSON.stringify({ host: value, at: new Date().toISOString() }));
			renameSync(tmp, SERVE_HOST_JSON);
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
	// #80-⑪: one bounded segment, no control characters. The name lands in logs, in the
	// dashboard and in `ls`, so bytes a terminal can interpret stop here.
	if (
		name.length === 0 ||
		name.length > INBOX_NAME_MAX ||
		name === "." ||
		name === ".." ||
		/[\/\\\0]/.test(name) ||
		// eslint-disable-next-line no-control-regex
		/[\u0000-\u001f\u007f]/.test(name)
	) {
		return { status: 400, error: "bad name" };
	}
	// #80-⑪: _inbox bytes are served back by /serve/*, so the extension decides what a
	// browser can be persuaded to parse there. Allowlist, see INBOX_EXTS above.
	const dot = name.lastIndexOf(".");
	const ext = dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
	if (!INBOX_EXTS.has(ext)) {
		return { status: 400, error: `extension not allowed: ${ext === "" ? "(none)" : `.${ext}`}` };
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
		// #80-⑪: the body limit above bounds ONE request; this bounds the volume. The
		// inbox and media/ share a disk and media/ is only ever cleaned per card, so the
		// budget is measured once, before the write, and refuses rather than evicting.
		// shortcut: the total is a fresh walk per POST (fine at this file count), upgrade
		// to a cached counter if media/ ever reaches the thousands.
		const used = mediaDirBytes();
		if (used + buf.length > MEDIA_DIR_MAX_BYTES) {
			sendJson(res, 413, {
				ok: false,
				error: `media budget exceeded (max ${fmtMB(MEDIA_DIR_MAX_BYTES)})`,
			});
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
		// #80-⑦: `target` is an absolute path. The writer already knows the name it
		// sent, so echoing the server's directory layout back buys it nothing.
		sendJson(res, 200, { ok: true, name, bytes: buf.length });
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
type FileServeOpts = {
	contentType: string;
	cacheControl: string;
	lastModified?: string;
	download?: boolean;
	/** #53: extra response headers (the html attachment's sandbox CSP). */
	headers?: Record<string, string>;
};

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
	if (opts.headers !== undefined) Object.assign(headers, opts.headers);
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
 * #80-⑦: what the browser is allowed to see instead of the absolute path. The registry
 * is reachable from any same-host page (the CORS answer reflects a same-host Origin), so
 * an absolute path turned "enumerate, then fetch" into two requests and handed a foreign
 * page the server's directory layout. The last segment is enough to recognise an entry.
 */
function serveDisplayName(entry: ServeEntry): string {
	return basename(entry.path) || entry.path;
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
			// #80-⑦: id + name only; the absolute path stays a server-side concept.
			return `<li><a href="${escHtml(href)}">${escHtml(e.id)}</a> <span class="m">${escHtml(serveDisplayName(e))}</span>${badge}</li>`;
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

/** #82: a write may only name a phase. "deliverable" is not one (deliv has its own table), so
 * /api/add and a fresh upload can no longer mint a row; old rows are still READ as-is. */
function parseCol(value: string | null): Col | undefined {
	return value === "todo" || value === "doing" || value === "done" ? value : undefined;
}

/** #80-⑪: total bytes under MEDIA_DIR. Missing directory = 0, unreadable entry = skipped. */
function mediaDirBytes(): number {
	let names: string[];
	try {
		names = readdirSync(MEDIA_DIR, { recursive: true }) as string[];
	} catch {
		return 0;
	}
	let total = 0;
	for (const name of names) {
		try {
			const st = statSync(join(MEDIA_DIR, name));
			if (st.isFile()) total += st.size;
		} catch {
			// gone between readdir and stat -> not part of the budget
		}
	}
	return total;
}

/** A bare filename directly under MEDIA_DIR (no path traversal). */
function isSafeMediaName(name: string): boolean {
	return name.length > 0 && !name.includes("..") && !name.includes("/") && !name.includes("\\");
}

/** 8 hex chars. Math.random is fine here: names only need per-card uniqueness. */
function randHex8(): string {
	return Math.random().toString(16).slice(2, 10).padEnd(8, "0");
}

/** #82: which row an upload / attach touches. `deliv=<id>` means a deliverable, never a card;
 * without it the old `id=` path is unchanged (and `new` = /api/upload's "no id" card). */
type MediaTarget =
	| { kind: "card"; card: Card }
	| { kind: "deliv"; deliv: Deliv }
	| { kind: "new" }
	| { kind: "missing"; error: string };

function mediaTarget(q: URLSearchParams, b: Board): MediaTarget {
	const delivRaw = q.get("deliv");
	if (delivRaw !== null) {
		const deliv = b.deliverables.find((d) => d.id === Number(delivRaw));
		if (deliv === undefined) return { kind: "missing", error: `no deliverable with id ${delivRaw}` };
		return { kind: "deliv", deliv };
	}
	const idParam = q.get("id");
	if (idParam === null) return { kind: "new" };
	const card = b.cards.find((c) => c.id === Number(idParam));
	if (card === undefined) return { kind: "missing", error: `no card with id ${idParam}` };
	return { kind: "card", card };
}

/** Write bytes as a card's media file; returns the stored filename, or null on failure. */
function writeMedia(cardId: number, ext: string, bytes: Buffer): string | null {
	const name = `${cardId}-${randHex8()}.${ext}`;
	try {
		mkdirSync(MEDIA_DIR, { recursive: true });
		// tmp+rename: serveMedia must never hand out a half-written upload.
		const path = join(MEDIA_DIR, name);
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, bytes);
		renameSync(tmp, path);
	} catch {
		return null;
	}
	return name;
}

// #80-⑧: deleting a card must not destroy the file. The bytes are unrecoverable once
// unlinked, and every delete path (/api/remove, /api/upload replace, the `kanban` tool,
// the dashboard menu) is reachable by a misclick, a CSRF and a plain bug. So a delete is
// a rename into media/.trash instead; 7 days later the sweeper drops it for real.
// To restore by hand: `mv ~/.pi/kanban/media/.trash/<epoch>-<name> ~/.pi/kanban/media/<name>`
// and put the basename back on the card (`/api/upload?id=<id>` is the easy way).
const TRASH_DIR = join(MEDIA_DIR, ".trash");
const TRASH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Drop what has sat in .trash longer than the TTL. Only the top level is ours. */
function sweepTrash(now: number): void {
	let entries: Dirent[];
	try {
		entries = readdirSync(TRASH_DIR, { withFileTypes: true });
	} catch {
		return; // no .trash yet
	}
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const path = join(TRASH_DIR, entry.name);
		try {
			if (now - statSync(path).mtimeMs > TRASH_TTL_MS) unlinkSync(path);
		} catch {
			// gone between readdir and stat/unlink -> nothing to do
		}
	}
}

/**
 * #80-⑧: move a media file into MEDIA_DIR/.trash/<epoch_ms>-<basename> (same filesystem,
 * so the rename is atomic). Returns the new path, or null when the path is outside
 * MEDIA_DIR / already gone. The path check is the traversal guard: `../` resolves out and
 * is refused, so only files directly under media/ can be moved.
 */
function trashMedia(absPath: string): string | null {
	const root = resolve(MEDIA_DIR);
	const abs = resolve(absPath);
	// root + sep, so a sibling like `media-evil/` cannot pass on a bare prefix match.
	if (!abs.startsWith(root + sep)) return null;
	if (!existsSync(abs)) return null;
	const now = Date.now();
	sweepTrash(now);
	try {
		mkdirSync(TRASH_DIR, { recursive: true });
		const dest = join(TRASH_DIR, `${now}-${basename(abs)}`);
		renameSync(abs, dest);
		// rename keeps the original mtime; stamp the entry time so the TTL counts time
		// spent in .trash, not the age of the upload (an old file would be swept at once).
		utimesSync(dest, now / 1000, now / 1000);
		return dest;
	} catch {
		return null;
	}
}

/** #92: an `img` csv -> its entries. The split/trim/filter was written out four times. */
function mediaNames(img: string | undefined): string[] {
	return (img ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * #92: the ONE rule for dropping an attachment: `file:` references are not ours, only bare
 * media names are, and a name any other row still shows stays. Written out twice before
 * (/api/deliv/remove and /api/attach/del) with the same expression; `owner` names the space
 * being changed, so a card id and a deliverable id can never be confused for each other.
 *
 * Not yet the one rule everywhere: the three card-delete paths still call removeMedia(card),
 * which trashes unconditionally. Harmless today - writeMedia names files with an owner
 * prefix plus randHex8(), so a card and a deliverable can never share one, and no copy
 * path exists either - but if a shared name ever becomes possible, those three are the holes.
 */
function trashUnusedMedia(b: Board, kind: "card" | "deliv", ownerId: number, gone: string[]): void {
	const kept = [
		...(kind === "card" ? b.cards.filter((c) => c.id !== ownerId) : b.cards),
		...(kind === "deliv" ? b.deliverables.filter((d) => d.id !== ownerId) : b.deliverables),
	].flatMap((o) => mediaNames(o.img));
	for (const name of gone) {
		if (name.startsWith("file:") || !isSafeMediaName(name)) continue;
		if (!kept.includes(name)) trashMedia(join(MEDIA_DIR, name));
	}
}

/** Best-effort delete of a card's media files. Missing file is not an error. */
function removeMedia(card: Card): void {
	if (!card.img) return;
	// #53: a card holds a comma-separated list now; every entry is trashed, not just the first.
	for (const name of card.img.split(",")) {
		const n = name.trim();
		if (isSafeMediaName(n)) trashMedia(join(MEDIA_DIR, n));
	}
}

/** The extension (lowercase, no dot) of a path, or "" when it has none. */
function extOfPath(abs: string): string {
	const b = basename(abs);
	const dot = b.lastIndexOf(".");
	return dot < 0 ? "" : b.slice(dot + 1).toLowerCase();
}

/**
 * #56: one file on disk -> one response. /api/media (a name under MEDIA_DIR) and /api/ref
 * (an absolute path under the serve allowlist) share this, so the MIME table, the size cap
 * and the html sandbox CSP cannot drift apart. The caller owns the allowlist/naming checks;
 * this only decides what the bytes are.
 */
function serveRefAbs(req: IncomingMessage, res: ServerResponse, abs: string, limit?: number): void {
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
	if (limit !== undefined && st.size > limit) {
		sendJson(res, 413, { ok: false, error: `too large (max ${fmtMB(limit)})` });
		return;
	}
	// #53: an html attachment is opened by the dashboard in a sandboxed iframe. The CSP is
	// the load-bearing part (it applies even if the iframe's sandbox attribute is lost) and
	// it deliberately sets no X-Frame-Options - being framed is the whole point. No
	// script-src restriction either: a three.js page loads its modules from a CDN.
	// #60: allow-forms lets an interactive attachment (a questionnaire) submit inside the
	// frame; allow-same-origin stays out, so the page keeps an opaque origin and no cookie.
	// #91: a ref may also be a document (REF_MIME). It gets inline - without it the browser
	// downloads the file instead of showing it - but NOT the CSP: a PDF viewer does not
	// render under CSP: sandbox.
	const ext = extOfPath(abs);
	const type = MIME_BY_EXT[ext] ?? REF_MIME[ext] ?? "application/octet-stream";
	const html = type === "text/html";
	serveFile(req, res, abs, st, {
		contentType: type,
		cacheControl: "no-store",
		...(html || REF_MIME[ext] !== undefined
			? {
					headers: {
						...(html ? { "Content-Security-Policy": "sandbox allow-scripts allow-forms" } : {}),
						"Content-Disposition": "inline",
					},
				}
			: {}),
	});
}

/**
 * #56: /api/ref?f=<absolute path> - view a file where it lives instead of copying it into
 * media/. The allowlist is the whole guard: this route is an arbitrary-file read for anyone
 * who holds the board token, so it is checked on the realpath before the file is touched and
 * an outside path is refused the same way /serve refuses one.
 */
function handleRef(req: IncomingMessage, res: ServerResponse, rawF: string | null): void {
	// URLSearchParams already decoded `f` once; decoding again would break a path with %41 in it.
	const input = (rawF ?? "").trim();
	if (input === "") {
		sendJson(res, 400, { ok: false, error: "f is required (an absolute path)" });
		return;
	}
	const abs = realOrSelf(resolve(input));
	if (!isUnder(abs, serveAllowRoots())) {
		sendJson(res, 403, { ok: false, error: `outside the serve allowlist: ${abs}` });
		return;
	}
	// Same cap /api/upload applies to a copy of the same file: 8MB, 64MB for video.
	serveRefAbs(req, res, abs, uploadLimitOf(extOfPath(abs)));
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
	// The name policy stays here (400/415 before the filesystem); the response itself is
	// serveRefAbs, so a media html and a ref html get the same CSP.
	if (MIME_BY_EXT[extOfPath(name)] === undefined) {
		sendJson(res, 415, { ok: false, error: "unsupported media type" });
		return;
	}
	serveRefAbs(req, res, join(MEDIA_DIR, name));
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

/** Files directly under ~/.pi/kanban/media (the dashboard's `media` stat). */
function mediaFileCount(): number {
	try {
		return readdirSync(MEDIA_DIR, { withFileTypes: true }).filter((d) => d.isFile()).length;
	} catch {
		return 0;
	}
}

/** The card fields a project roll-up reads. Narrow on purpose: JSON shape, not the DB row. */
type RollupCard = {
	id: number;
	text: string;
	col: string;
	project?: string;
	due?: string;
	estimate?: number;
	blocked?: string;
};

export type ProjectSummary = {
	slug: string;
	name: string;
	/** false while the slug exists only on cards: nobody has given it a name yet. */
	declared: boolean;
	counts: { todo: number; doing: number; done: number };
	total: number;
	done: number;
	/** Estimate sums. A card without an estimate counts as 0 points. */
	points: { total: number; done: number };
	/** Percent of cards done, derived on every read. A stored percentage drifts. */
	progress: number;
	/** Cards not done whose due date has passed. */
	overdue: number;
	milestones: { id: number; text: string; due: string; col: string; scope: string; sid: string }[];
	blockers: { id: number; text: string; blocked: string; scope: string; sid: string }[];
	decisions: Decision[];
};

/**
 * Cards in, one row per project out. Progress is never stored: the card is the only truth,
 * and a cached percentage is wrong the moment someone drags a card.
 *
 * A board nobody has named is listed too (name falls back to the slug), otherwise work
 * would disappear from the project tab just because nobody "created" the project.
 * The board (scope + sid) is the project: card.project is a label that outlived that job,
 * so counting it here would list a tag that no board holds and hide real boards with none.
 */
export function projectRollup(
	declared: { slug: string; name: string }[],
	decisions: Decision[],
	cards: { scope: string; sid: string; card: RollupCard }[],
	today: string,
): ProjectSummary[] {
	const named = new Map(declared.map((p) => [p.slug, p.name]));
	const slugs = new Set(named.keys());
	for (const { scope, sid } of cards) if (scope === "project" && sid !== "") slugs.add(sid);
	const log = new Map<string, Decision[]>();
	for (const d of decisions) {
		// A decision can be written for a slug no card names yet: it must still show up.
		if (d.slug !== "") slugs.add(d.slug);
		const list = log.get(d.slug);
		if (list === undefined) log.set(d.slug, [d]);
		else list.push(d);
	}
	return [...slugs].sort().map((slug) => {
		const mine = cards.filter((e) => e.scope === "project" && e.sid === slug);
		// #82: 成果物は card ではないので、進捗の総数・完了・ポイント・期限超過には入らない。
		const counted = mine;
		const done = counted.filter((e) => e.card.col === "done");
		const points = (list: { card: RollupCard }[]) => list.reduce((n, e) => n + (e.card.estimate ?? 0), 0);
		const at = (e: { card: RollupCard; scope: string; sid: string }) => ({ scope: e.scope, sid: e.sid });
		return {
			slug,
			name: named.get(slug) ?? slug,
			declared: named.has(slug),
			counts: {
				todo: mine.filter((e) => e.card.col === "todo").length,
				doing: mine.filter((e) => e.card.col === "doing").length,
				done: done.length,
			},
			total: counted.length,
			done: done.length,
			points: { total: points(counted), done: points(done) },
			progress: counted.length === 0 ? 0 : Math.round((done.length / counted.length) * 100),
			overdue: counted.filter((e) => e.card.col !== "done" && e.card.due !== undefined && e.card.due < today).length,
			milestones: mine
				.filter((e) => e.card.due !== undefined)
				.map((e) => ({ id: e.card.id, text: e.card.text, due: e.card.due as string, col: e.card.col, ...at(e) }))
				.sort((a, b) => a.due.localeCompare(b.due) || a.id - b.id),
			blockers: mine
				.filter((e) => (e.card.blocked ?? "") !== "")
				.map((e) => ({ id: e.card.id, text: e.card.text, blocked: e.card.blocked as string, ...at(e) })),
			decisions: log.get(slug) ?? [],
		};
	});
}

/** #28: 「この機械の全カード」の唯一の式。 */
type RollupEntry = { scope: Scope; sid: string; card: Card };

function allRollupCards(): RollupEntry[] {
	return [
		...readBoard(GLOBAL_JSON).cards.map((card) => ({ scope: "global" as const, sid: "", card })),
		// Fixed order: slug ascending, id ascending inside a board (listProjectBoards).
		...kanbanDb()
			.listProjectBoards()
			.flatMap(({ slug, cards }) => cards.map((card) => ({ scope: "project" as const, sid: slug, card }))),
	];
}

/** allRollupCards() からプロジェクトボードだけを slug ごとに畳む（週次は GLOBAL 残骸を数えない）。 */
function projectBoardsOf(entries: RollupEntry[]): { slug: string; cards: Card[] }[] {
	const by = new Map<string, Card[]>();
	for (const { scope, sid, card } of entries) {
		if (scope !== "project") continue;
		const list = by.get(sid);
		if (list === undefined) by.set(sid, [card]);
		else list.push(card);
	}
	return [...by].map(([slug, cards]) => ({ slug, cards }));
}

/**
 * #16: global is a READ-ONLY VIEW over every project board — it holds no cards of its own.
 * `sid` on each card is the project slug it came from, so the dashboard can label it.
 * GLOBAL_JSON cards stay in the sum for pre-migration rows and for tests that seed it.
 * #28: the sum itself is allRollupCards() — one expression, so the four supply paths cannot drift.
 */
/** #82: 機械全体の成果物（cross-project）。sid = その行が属するプロジェクト。 */
function aggregateDelivs(): (Deliv & { sid: string })[] {
	return [
		...readBoard(GLOBAL_JSON).deliverables.map((d) => ({ ...d, sid: "" })),
		...kanbanDb()
			.listProjectDeliverables()
			.flatMap(({ slug, deliverables }) => deliverables.map((d) => ({ ...d, sid: slug }))),
	];
}

function aggregateGlobal(): {
	cards: (Card & { sid: string })[];
	nextId: number;
	deliverables: (Deliv & { sid: string })[];
	delivNextId: number;
} {
	return {
		cards: allRollupCards().map(({ sid, card }) => ({ ...card, sid })),
		nextId: 1,
		deliverables: aggregateDelivs(),
		// Aggregate view: nothing is ever numbered here (a write goes to a real board).
		delivNextId: 1,
	};
}

/**
 * GET /api/weekly: 週次タブの payload。`week` を渡すと保存済みのその週だけを返し、
 * 省くと現週をその場で計算する（tick を待たない: 開いた瞬間の状態を見せる）。
 */
function weeklyPayload(week: string | null): unknown {
	const db = kanbanDb();
	if (week !== null) {
		const raw = db.getMeta(WEEKLY_KEY + week);
		if (raw === null) return { ok: true, summary: null };
		try {
			return { ok: true, summary: JSON.parse(raw) as WeeklySummary };
		} catch {
			// 壊れた行は「保存が無い」と同じに見せる（描けない JSON を GUI に渡さない）
			return { ok: true, summary: null };
		}
	}
	const now = Date.now();
	const cur = isoWeek(new Date(now));
	const last = db.getMeta(WEEKLY_LAST);
	// 索引と lastWeek の両方から作る: setMeta(WEEKLY_KEY+week) と setMeta(WEEKLY_INDEX) の
	// 間で落ちると「行は在るのに一覧に出ない週」が残り、過去週は永久にセレクトへ出ない。
	// lastWeek も検証する: 壊れた値は選択肢に出すと選んだ瞬間 400 になるだけ。
	const weeks = [...new Set([...weeklyIndex(db), ...(last !== null && weekRange(last) !== null ? [last] : []), cur])];
	return {
		ok: true,
		current: weeklySummary(projectBoardsOf(allRollupCards()), cur, now),
		// 現週は計算で出るので、tick がまだ書いていなくても選択肢に出す。新しい順。
		weeks: weeks.sort().reverse(),
	};
}

/** GET /api/projects: the project tab's whole payload. */
async function projectsPayload(): Promise<unknown> {
	// #17/#25: 供給は aggregateGlobal() / weekly と同じ、この機械の全プロジェクトボード。
	// 自 cwd の 1 枚だけだと他リポのカードが黙って欠ける（件数だけ 0 に見える）。
	const cards = allRollupCards();
	const db = kanbanDb();
	return {
		ok: true,
		projects: projectRollup(db.listProjects(), db.listDecisions(), cards, new Date().toISOString().slice(0, 10)),
		// Decisions with no project live nowhere else: the per-project lists cannot hold them.
		decisions: db.listDecisions(""),
	};
}

/**
 * #11: 設定タブの「保存データ」。パスは固定名だけ（絶対パスは出さない #80-⑦）。
 * 読めないときは null — ダッシュボードは何も描かない（旧サーバー互換と同じ見え方）。
 * counts は呼び出し元が既に持っている数字（totals 合計）を使って二重に数えない。
 */
type DbInfo = {
	file: string;
	bytes: number;
	boards: number;
	cards: number;
	projects: number;
	decisions: number;
};
function dbInfo(cards: number): DbInfo | null {
	try {
		const st = statSync(DB_FILE);
		const store = kanbanDb();
		return {
			file: basename(DB_FILE),
			bytes: st.size,
			// +1 = GLOBAL board. Project boards are every board on the machine. The +1 is
			// conceptual: no GLOBAL row exists, but global is always shown in the heading.
			boards: 1 + store.projectKeys().length,
			cards,
			projects: store.listProjects().length,
			decisions: store.listDecisions().length,
		};
	} catch {
		return null;
	}
}

/**
 * #13: 設定タブからの DB 診断と VACUUM。件数は dbInfo に任せる（/api/dashboard と同じ
 * 実装で、同じ数字を埋める）。VACUUM の失敗は握り潰さず 500 で返す。
 */
async function dbMaintenance(pathname: string, res: ServerResponse): Promise<void> {
	const { cards: aggCards, nextId } = aggregateGlobal();
	// #13: same count as /api/dashboard's stats now that both read the one aggregate.
	const totals = countCols({ cards: aggCards, nextId });
	const countCards = totals.todo + totals.doing + totals.done;
	if (pathname === "/api/db/diagnose") {
		const info = dbInfo(countCards) ?? {};
		const m = kanbanDb().maintenance();
		const ok = m.integrity === "ok";
		sendJson(res, ok ? 200 : 503, { ok, ...m, ...info });
		return;
	}
	try {
		const before = statSync(DB_FILE).size;
		kanbanDb().vacuum();
		const after = statSync(DB_FILE).size;
		// info は VACUUM 後に取る: 先に取ると応答内の bytes と after が食い違う。
		sendJson(res, 200, { ok: true, before, after, saved: before - after, ...(dbInfo(countCards) ?? {}) });
	} catch (err) {
		sendJson(res, 500, { ok: false, error: String((err && (err as Error).message) || err) });
	}
}

/**
 * #35: one board, reported the same way whether it came from the session cwd or from ?p=.
 * Both routes must answer these 7 keys - the dashboard reads all of them, and a board
 * rendered without counts/next/loops looks like a board with nothing on it.
 *
 * #19: 次にやる 1 枚。nextTodo の規則（priority 降順 → id 昇順、blocked/予約済みを除く）を
 * そのまま使い、無ければ null（undefined は JSON から消えて UI が「空」と区別できない）。
 * 第 2/3 引数（scope/sid）は呼び出し規約。
 * この値は request 時点のスナップショット。sigOf は now を除外しているので、時刻だけで
 * 変わる候補（予約が発火しなかった等）は次の payload 変化まで古いまま。
 *
 * #52: another session's TODO is hidden by default (it polluted the board with work that is
 * not this session's). `hiddenTodoCount` says how many were withheld so the UI can offer
 * "他 N 件" as the explicit door; `showOthers` (from ?showOthers=1) hands them back. Only the
 * cards are filtered - `counts` stays the whole board, so nothing silently loses a number.
 */
function projectReport(
	slug: string,
	pb: Board,
	f: ReturnType<typeof readModesFile>,
	sidActor: string,
	showOthers = false,
) {
	// `mine` is view-only (Card.mine): the dashboard has no sid of its own, so the server
	// decides whose card this is and which TODOs are somebody else's.
	const tagged = pb.cards.map((c) => (sidActor !== "" && c.movedBy === sidActor ? { ...c, mine: true } : c));
	const others = tagged.filter((c) => c.col === "todo" && !todoMineOrUnowned(c, sidActor));
	return {
		id: slug,
		counts: countCols(pb),
		// #82: 成果物は deliv テーブルの件数。counts は 3 キーのまま。
		deliverableCount: pb.deliverables.length,
		deliverables: pb.deliverables,
		cards: showOthers ? tagged : tagged.filter((c) => c.col !== "todo" || todoMineOrUnowned(c, sidActor)),
		hiddenTodoCount: others.length,
		next: nextTodo(pb.cards, "project", sidActor) ?? null,
		modes: modesFor(f, slug, "project"),
		loops: loopCountOf(sidActor, "project"),
		halted: haltedBySid.get(sidActor)?.scope === "project",
	};
}

/** GET /api/dashboard: one request carrying everything the dashboard renders. */
async function dashboardPayload(): Promise<unknown> {
	// #16: global is the aggregate over every project board, so its counts ARE the board
	// counts. Summing this process's project board on top of it (the old shape) counted
	// the same card twice.
	const agg = aggregateGlobal();
	const aggBoard: Board = agg;
	const globalCounts = countCols(aggBoard);
	// The GLOBAL board's switches live under scope=global, keyed by the active session.
	const f = readModesFile();
	// The halt tag and the used count are published per (session, scope) by paintLoop.
	const sidActor = activeSessionId ?? "";
	// stats.todo/doing/done = every project board + GLOBAL's residual rows. That IS the
	// aggregate now, so no other board can be summed on top of it.
	const totals = countCols(aggBoard);
	// Phase 0: project is where cards live now. Its counts are already inside `totals`
	// (they are part of the aggregate), so they are reported, never added again.
	// #27/#93: the cwd is the one published for the driver session (`pinDriver`) - not ctx's,
	// because dashboardPayload is module level and the route passes no ctx. #27's residual is
	// closed by that: a session resumed with a cwdOverride (dist/main.js:563-566) now names the
	// board it was resumed into, not the one recorded in its header. Residual that remains: a sid
	// nobody published (a subagent that never started, a sibling pi's session) has no cwd, but
	// /api/dashboard never names one - it asks for the driver's board, which is the only panel
	// this process draws. With no pin at all (a test double, a host that never fires
	// session_start) driverCwd stays "" and this is process.cwd(), exactly as before.
	const slug = storedProjectKey(projectSlugOf(cwdOfSidSync(null)));
	const pb = readBoard(boardPath("project", slug));
	return {
		// #53: the serve pane is gone - cards carry their files now. The field keeps its
		// shape for anything still reading it, and /serve/* routes stay for old links.
		serve: [] as unknown[],
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
		stats: {
			todo: totals.todo,
			doing: totals.doing,
			done: totals.done,
			serve: 0,
			media: mediaFileCount(),
		},
		// #11: 設定タブの「保存データ」。絶対パスは出さない（#80-⑦）。
		db: dbInfo(totals.todo + totals.doing + totals.done),
		// The board picker's choices. projectKeys() is the board table itself, so a board with
		// no cards yet is still selectable (listProjectBoards() only returns boards with cards).
		boards: kanbanDb()
			.projectKeys()
			.map((b) => b.slug)
			.sort(),
		// #17/B2: a halt and a used count belong to a BOARD now, not to a session row. `loops`
		// is the count this session has used on that board; `halted` says the loop is stopped.
		// The dashboard draws 「残り N / 上限」 and the 再開 button off these two (B3).
		global: {
			counts: globalCounts,
			cards: agg.cards,
			// #82: 横断ビューの成果物（sid = その行のプロジェクト）。
			deliverables: agg.deliverables,
			// #26: no modes - global is not a board and owns no switches. `loops`/`halted` stay
			// as the measured values of a board that never drives (always 0 / false).
			loops: loopCountOf(sidActor, "global"),
			halted: haltedBySid.get(sidActor)?.scope === "global",
		},
		// Phase 0: the board of the active session's cwd (#27: one server can host several cwds).
		// global stays above for the un-migrated rows the tests and the UI still read.
		project: projectReport(slug, pb, f, sidActor),
	};
}

const P_BAD = "p must match [A-Za-z0-9._-]";

/**
 * #35: the board ?p=<slug> names, as the spelling it is STORED under.
 * `named: false` = the request named no board. `named: true, key: ""` = it named one that
 * normalizes away: the caller must answer 400, never fall back to the cwd board.
 * All three gates read this, so the read and the two writes cannot drift apart.
 */
function boardKeyOfP(q: URLSearchParams): { named: false } | { named: true; key: string } {
	const pRaw = q.get("p");
	if (pRaw === null || pRaw === "") return { named: false };
	const slug = normalizeProject(pRaw);
	return { named: true, key: slug === "" ? "" : storedProjectKey(slug) };
}

/** The file a write targets, or the 400 reason. Never both. */
type WriteTarget = { ok: true; path: string } | { ok: false; error: string };

/**
 * The project board key a request may write, or null when its sid cannot name one.
 * Only a sid `pinDriver()` published (every session_start, plus `/kanban take`) has a cwd, so
 * an unknown sid would fall back to the driver's cwd and touch the wrong repo's board: refuse.
 * (The UI sends no sid.)
 * Both gates (board writes and the switch routes) and the /api/kanban read read the key from
 * here, so their answers cannot drift: they accept exactly the same sids.
 */
function projectKeyOfWrite(sid: string | null): string | null {
	if (sid !== null && sid !== "" && !cwdBySid.has(sid)) return null;
	return projectSlugOf(cwdOfSidSync(sid));
}

/**
 * Board file for a write. A sid is only a way to name a cwd: the board it picks is that
 * cwd's project board, so a concurrent write from that session's own pi can still overwrite
 * us - the same condition every shared board accepts, and not a reason to refuse here.
 * Phase 0 (D5): global is a read-only aggregate, so a board write there is a 400 - not a
 * silent merge into a board no session owns. project needs no sid: the cwd names the board.
 * #26: no route is exempt any more - global has no switches, so every write names a board.
 */
function writeBoardPath(q: URLSearchParams): WriteTarget {
	// #17: a stale tab still sends scope=session, and parseScope reads that as project - the
	// write would land on a project board named by a session id. Refuse it first.
	if (isLegacySessionScope(q)) return { ok: false, error: SESSION_SCOPE_GONE };
	const scope = parseScope(q.get("scope"));
	if (scope === "global") return { ok: false, error: "global board is read-only" };
	// p names the board the dashboard is showing: without it every write lands on the cwd's
	// board, so dragging a card while another board is open would edit the wrong repo.
	const p = boardKeyOfP(q);
	if (p.named) {
		if (p.key === "") return { ok: false, error: P_BAD };
		return { ok: true, path: boardPath("project", p.key) };
	}
	const key = projectKeyOfWrite(q.get("sid"));
	if (key === null) return { ok: false, error: "unknown sid" };
	// #36: the board's own spelling, so a write and the reader above name the same board.
	return { ok: true, path: boardPath("project", storedProjectKey(key)) };
}

/** #17: parseScope reads scope=session as project, so a write gate has to see the raw value. */
const isLegacySessionScope = (q: URLSearchParams): boolean => q.get("scope") === "session";

/**
 * The sid a settings write targets, or null with a 400 already sent.
 * scope=project names its slug, or a sid whose cwd we know.
 * #78: the 400 names the scope that actually failed.
 * #26: global owns no switch any more, so it cannot name a key at all.
 */
function settingsSidOf(q: URLSearchParams, res: ServerResponse): string | null {
	if (isLegacySessionScope(q)) {
		sendJson(res, 400, { ok: false, error: SESSION_SCOPE_GONE });
		return null;
	}
	const scope = parseScope(q.get("scope"));
	// project keys its settings by board (the slug); the sid only says whose cwd to use.
	if (scope === "project") {
		// p names the board directly, exactly as writeBoardPath reads it: the panel must write
		// the switches of the board it is showing, not of the cwd's board.
		const p = boardKeyOfP(q);
		if (p.named) {
			if (p.key === "") {
				sendJson(res, 400, { ok: false, error: P_BAD });
				return null;
			}
			return p.key;
		}
		const key = projectKeyOfWrite(q.get("sid"));
		if (key !== null) return storedProjectKey(key);
		// Same 400 as a board write: an unknown sid must not land on OUR cwd's board.
		sendJson(res, 400, { ok: false, error: "unknown sid" });
		return null;
	}
	// #26: only global is left here. It has no switches, so a stray caller is refused
	// instead of being handed a key nothing reads. Belt-and-braces: the /api/modes|interval|
	// stuck|resume routes already reject scope=global above, and /api/priority is stopped
	// earlier by writeBoardPath's "global board is read-only" 400 - so this arm is
	// unreachable today.
	sendJson(res, 400, { ok: false, error: GLOBAL_NO_SWITCH });
	return null;
}

/** The session credited for a move made through the HTTP API. */
function actorOf(q: URLSearchParams): string {
	const sid = q.get("sid");
	// A project write may omit sid (the dashboard does): the driver session is the attribution.
	// #26: global cannot reach here - a global board write is a 400 in writeBoardPath.
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
	const target = writeBoardPath(q);
	if (!target.ok) {
		sendJson(res, 400, { ok: false, error: target.error });
		req.resume();
		return;
	}
	const path = target.path;
	collectBody(req, res, uploadLimitOf(ext), (buf) => {
		if (buf === null) return; // 413/400 already sent
		// #86: the per-file limit above bounds ONE request; this bounds the volume. The
		// check sits before removeMedia/writeMedia on purpose: evicting the old file and
		// then refusing would leave the card pointing at media that no longer exists, so a
		// refusal here leaves the card and its current media exactly as they were.
		// shortcut: the total is a fresh walk per upload (fine at this file count), upgrade
		// to a cached counter if media/ ever reaches the thousands.
		if (mediaDirBytes() + buf.length > MEDIA_DIR_MAX_BYTES) {
			sendJson(res, 413, {
				ok: false,
				error: `media budget exceeded (max ${fmtMB(MEDIA_DIR_MAX_BYTES)})`,
			});
			return;
		}
		const b = readBoard(path);
		const t = mediaTarget(q, b);
		if (t.kind === "missing") {
			sendJson(res, 404, { ok: false, error: t.error });
			return;
		}
		let owner: { id: number; img?: string };
		if (t.kind === "new") {
			// #82: same rule as /api/add - never create a legacy col=deliverable row.
			if (q.get("col") === "deliverable") {
				sendJson(res, 400, { ok: false, error: "deliverable is not a phase" });
				return;
			}
			const card: Card = { id: b.nextId++, text: "", col: parseCol(q.get("col")) ?? "todo" };
			stampMove(card, actorOf(q));
			card.text = `#${card.id} (${ext === "html" ? "html" : MIME_BY_EXT[ext].startsWith("video/") ? "video" : "image"})`;
			const projectRaw = q.get("project");
			const project = normalizeProject(projectRaw);
			// Only an exact empty string clears (a fresh upload card only); anything else unnormalizable is a typo.
			if (project === "" && (projectRaw ?? "") !== "") {
				sendJson(res, 400, { ok: false, error: "project must match [A-Za-z0-9._-]" });
				return;
			}
			if (project !== "") card.project = project;
			b.cards.push(card);
			owner = card;
		} else if (t.kind === "deliv") {
			// #82: a deliverable's attachment. No project label, no card id space.
			owner = t.deliv;
		} else {
			// Uploading to an existing card leaves its project label alone (the dashboard only sends project for a new card).
			// #53: an upload ADDS to the card: dropping the old file on every upload made a
			// second attachment impossible. Removal is per card (delete trashes them all).
			owner = t.card;
		}
		const name = writeMedia(owner.id, ext, buf);
		if (name === null) {
			sendJson(res, 500, { ok: false, error: "media write failed" });
			return;
		}
		owner.img = owner.img ? `${owner.img},${name}` : name;
		writeBoard(path, b);
		sendJson(res, 200, t.kind === "deliv" ? { ok: true, deliverable: owner } : { ok: true, card: owner });
	});
}

/**
 * #55: a pasted image arrives as a base64 dataURL in the QUERY, not as a POST body.
 * Same shape as /api/ehr and for the same reason: a clipboard File cannot be uploaded
 * from the sandboxed iframe path the dashboard already uses, and a small screenshot
 * (a 640x360 png is 10-30KB base64) fits the 128KB request line /api/ehr established.
 * The cap is the dataURL string, so it bounds the request line before anything is decoded.
 */
const UPLOAD2_PATH = "/api/upload2";
const UPLOAD2_MAX_BYTES = 128 * 1024; // 128KB, the same request-line budget QUIZ_EHR_MAX_BYTES set
const DATA_URL_RE = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/;

/** dataURL -> `{ ext, bytes }`, or null when the shape or the MIME is not one we store. */
function dataUrlOf(raw: string): { ext: string; bytes: Buffer } | null {
	const m = DATA_URL_RE.exec(raw.trim());
	if (m === null) return null;
	const mime = m[1].toLowerCase();
	// The MIME decides the stored extension. MIME_BY_EXT is the one table, so an ext that
	// /api/media will not serve can never be written here either.
	const ext = Object.keys(MIME_BY_EXT).find((k) => MIME_BY_EXT[k] === mime);
	if (ext === undefined) return null;
	return { ext, bytes: Buffer.from(m[2].replace(/\s+/g, ""), "base64") };
}

/**
 * GET /api/upload2?p=&id=&data=<dataURL>[&ext=] : a paste -> media file on an EXISTING card.
 * Deliberately not a clone of /api/upload: no new card (the dashboard decides which card
 * receives the paste), and the payload is inline.
 */
function handleUpload2(req: IncomingMessage, res: ServerResponse, q: URLSearchParams): void {
	req.resume();
	const raw = q.get("data") ?? "";
	if (raw.length > UPLOAD2_MAX_BYTES) {
		sendJson(res, 413, { ok: false, error: `data too large (max ${fmtMB(UPLOAD2_MAX_BYTES)} as base64)` });
		return;
	}
	const parsed = dataUrlOf(raw);
	if (parsed === null) {
		// Two different mistakes: not a dataURL at all (400) vs a dataURL we do not store (415).
		if (!raw.trim().startsWith("data:")) {
			sendJson(res, 400, { ok: false, error: "data must be a dataURL (data:image/png;base64,...)" });
			return;
		}
		sendJson(res, 415, {
			ok: false,
			error: `data must be a base64 dataURL of: ${Object.values(MIME_BY_EXT).join(", ")}`,
		});
		return;
	}
	// An `ext` the caller added must agree with the MIME: two sources for one decision is
	// how a png ends up stored as .webp and served as the wrong type.
	const declared = (q.get("ext") ?? "").toLowerCase();
	if (declared !== "" && declared !== parsed.ext) {
		sendJson(res, 415, { ok: false, error: `ext ${declared} does not match ${MIME_BY_EXT[parsed.ext]}` });
		return;
	}
	const target = writeBoardPath(q);
	if (!target.ok) {
		sendJson(res, 400, { ok: false, error: target.error });
		return;
	}
	const b = readBoard(target.path);
	const t = mediaTarget(q, b);
	if (t.kind === "missing") {
		sendJson(res, 404, { ok: false, error: t.error });
		return;
	}
	// This route never creates a row: "no id and no deliv" is the caller's mistake.
	if (t.kind === "new") {
		sendJson(res, 400, { ok: false, error: "id required" });
		return;
	}
	const owner: { id: number; img?: string } = t.kind === "deliv" ? t.deliv : t.card;
	if (parsed.bytes.length === 0) {
		sendJson(res, 400, { ok: false, error: "empty payload" });
		return;
	}
	// Same budget as /api/upload, checked before the write so a refusal leaves the card alone.
	if (mediaDirBytes() + parsed.bytes.length > MEDIA_DIR_MAX_BYTES) {
		sendJson(res, 413, { ok: false, error: `media budget exceeded (max ${fmtMB(MEDIA_DIR_MAX_BYTES)})` });
		return;
	}
	const name = writeMedia(owner.id, parsed.ext, parsed.bytes);
	if (name === null) {
		sendJson(res, 500, { ok: false, error: "media write failed" });
		return;
	}
	// #53: add, do not replace (a card can hold several attachments).
	owner.img = owner.img ? `${owner.img},${name}` : name;
	writeBoard(target.path, b);
	sendJson(res, 200, t.kind === "deliv" ? { ok: true, deliverable: owner } : { ok: true, card: owner });
}

const MEDIA_PREFIX = "/api/media/";

// #60/#64: an interactive attachment (a quiz/wizard/paint html in the sandboxed iframe)
// posts its payload back here. The iframe's origin is null and it carries no cookie, so
// this route is the one place that answers without the token and allows any origin.
// #64: the route is the generic /api/ehr now; /api/quiz stays as an alias so an already
// attached html written against the old name keeps posting to the same handler.
const EHR_PATH = "/api/ehr";
const EHR_ALIAS_PATH = "/api/quiz";
// #63: 128KB, because a paint demo posts canvas PNG dataURLs here and a 640x360 png is
// 10-30KB base64. The value still travels in the query, so the request LINE is that big -
// node's 16KB default would answer 431, hence the maxHeaderSize in listenLoop.
const QUIZ_EHR_MAX_BYTES = 131072;
const QUIZ_EHR_MAX_RECORDS = 50;
type EhrRecord = { at: number; key: string; value: string };

/** #64: true for the canonical route and the old alias alike. */
function isEhrPath(pathname: string): boolean {
	return pathname === EHR_PATH || pathname === EHR_ALIAS_PATH;
}

/**
 * Answers stored for one card. `meta` is a plain k/v table and this is a value nobody
 * else reads, so it needs no schema of its own.
 * shortcut: keyed by card id alone, so two boards with the same id share answers; add the
 * board key here if the dashboard ever needs them separated.
 */
function ehrRecords(id: number): EhrRecord[] {
	const db = kanbanDb();
	// #64: `ehr:<id>` is the new key; the old `quiz:<id>` is read only when the new one was
	// never written, so the answers collected before the rename stay readable.
	const raw = db.getMeta(`ehr:${id}`) ?? db.getMeta(`quiz:${id}`);
	if (raw === null) return [];
	try {
		const v = JSON.parse(raw) as unknown;
		return Array.isArray(v) ? (v as EhrRecord[]) : [];
	} catch {
		return [];
	}
}

/**
 * #60/#64: GET lists answers (optionally one `key`), POST appends {at, key, value}.
 * The iframe posts with a plain URL, so every field is in the query and no body is read.
 */
function handleEhr(req: IncomingMessage, res: ServerResponse, q: URLSearchParams): void {
	// #91(lens): was `*`. The answers on this route are token-less (see the #60 note: the
	// sandboxed iframe has an opaque origin and no cookie), so a wildcard let any page that
	// found the port read them. The only cross-origin caller is that iframe, whose Origin
	// is the literal "null" - echo just that. Same-host callers need no header at all.
	// (corsHeaders() next to isSameHostOrigin is the strict variant for token routes.)
	if (req.headers.origin === "null") {
		res.setHeader("Access-Control-Allow-Origin", "null");
		res.setHeader("Vary", "Origin");
	}
	if (req.method === "OPTIONS") {
		res.writeHead(204);
		res.end();
		return;
	}
	req.resume();
	const idRaw = q.get("id");
	const id = Number(idRaw);
	if (idRaw === null || !Number.isInteger(id) || id <= 0) {
		sendJson(res, 400, { ok: false, error: "id must be a positive integer" });
		return;
	}
	const key = (q.get("key") ?? "").trim().slice(0, 64);
	if (req.method === "GET") {
		const rows = ehrRecords(id);
		sendJson(res, 200, key === "" ? rows : rows.filter((r) => r.key === key));
		return;
	}
	if (req.method !== "POST") {
		sendJson(res, 405, { ok: false, error: "method not allowed" });
		return;
	}
	const value = q.get("value");
	if (key === "") {
		sendJson(res, 400, { ok: false, error: "key is required" });
		return;
	}
	if (value === null || value === "") {
		sendJson(res, 400, { ok: false, error: "value is required" });
		return;
	}
	if (Buffer.byteLength(value, "utf8") > QUIZ_EHR_MAX_BYTES) {
		sendJson(res, 413, { ok: false, error: `value too large (max ${QUIZ_EHR_MAX_BYTES} bytes)` });
		return;
	}
	// New rows go to the new key: a POST through the alias migrates the record set.
	const rows = ehrRecords(id);
	rows.push({ at: Date.now(), key, value });
	// Newest last; the cap drops the oldest answers first.
	while (rows.length > QUIZ_EHR_MAX_RECORDS) rows.shift();
	kanbanDb().setMeta(`ehr:${id}`, JSON.stringify(rows));
	sendJson(res, 200, { ok: true, count: rows.length });
}

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
			const paths = [GLOBAL_JSON];
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
			// #80-⑧: not user data (a zero-byte file this probe just made), so it is unlinked
			// rather than trashed; `.trash` itself is a directory and is not counted here.
			unlinkSync(probe);
			return `${MEDIA_DIR} (${mediaFileCount()} file(s))`;
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
	"project",
	"due",
	"estimate",
	"blocks",
	// #20: the conversation/commit tags. Missing here = `?fields=` callers never see them.
	"sessionId",
	"commit",
	"labels",
	// #16: the aggregate stamps each card with the project board it came from.
	"sid",
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
	return { cards, nextId: b.nextId, deliverables: b.deliverables, delivNextId: b.delivNextId };
}


function handle(req: IncomingMessage, res: ServerResponse): void {
	// Phase 0: a write must not land between the fold's read and its deletes. Waiting here
	// (only while the one startup pass runs) keeps the bind immediate and the write safe.
	if (migrationPending !== null && isWritePath(new URL(req.url ?? "/", "http://127.0.0.1").pathname, req.method ?? "GET")) {
		void migrationPending.then(() => route(req, res));
		return;
	}
	route(req, res);
}

function route(req: IncomingMessage, res: ServerResponse): void {
	// #80-⑨: the Host gate runs FIRST — before CORS, before the token gate. It is the layer
	// that decides whether this request is even addressed to us, and a rebound attacker's
	// page carries the kb_auth cookie (the browser thinks it is same-origin), so the token
	// gate cannot see the attack; the Host header can. Refusing here also means no Cookie
	// header is ever parsed for a name we do not answer to.
	if (hostRefusal(req)) {
		sendJson(res, 403, { ok: false, error: "host not allowed" });
		req.resume();
		return;
	}

	// #76: the allow-origin value is per-caller now, so it is decided here rather than in a
	// module constant. Vary: Origin rides along or a shared cache serves one caller's answer
	// to another.
	const cors = corsHeaders(req);
	for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);

	const url = new URL(req.url ?? "/", "http://127.0.0.1");

	// #83b/#85: the token gate. Every /api and /serve route is protected here, before the
	// Origin gate, because the Origin gate only knows how to judge a browser: a header-less
	// curl had no reason to be refused. `/` is deliberately NOT gated - it is the entry
	// point that sets the cookie, and the page it serves tells the user how to get one.
	// OPTIONS is exempt (a preflight carries no credentials by design) and /favicon.ico too
	// (a bare retry loop).
	const gated =
		url.pathname === SERVE_PREFIX ||
		url.pathname.startsWith(`${SERVE_PREFIX}/`) ||
		url.pathname === "/api" ||
		// #60: the interactive attachment has no cookie to present (origin null). #64: alias too.
		(url.pathname.startsWith("/api/") && !isEhrPath(url.pathname));
	if (gated && req.method !== "OPTIONS" && url.pathname !== "/favicon.ico" && !isAuthorized(req, url.searchParams)) {
		// The 401 body is a constant: it must never echo the token the caller tried.
		sendJson(res, 401, { ok: false, error: "unauthorized" });
		req.resume();
		return;
	}

	// #80-⑥: a write GET from a caller that is not this page is a 405, before the #76 Origin
	// gate below (which lets `none`/`same-site` through — fine for POST, not for a verb that
	// a prefetcher can issue). Auth comes first on purpose: an anonymous caller stays a 401
	// and learns nothing about which routes are writes.
	if (methodNotAllowedOnGet(req, url.pathname)) {
		// No Allow header: GET is allowed on this resource for same-origin, and the refusal is
		// about who is calling, not which methods exist here.
		sendJson(res, 405, { ok: false, error: "method not allowed" });
		req.resume();
		return;
	}

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

	// #60: the ehr route answers its own OPTIONS and CORS, so it sits before the shared
	// gates - a sandboxed iframe's preflight carries Origin: null and would be refused.
	if (isEhrPath(url.pathname)) {
		handleEhr(req, res, url.searchParams);
		return;
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

	// #55: a paste rides the query as a dataURL (GET+query, like the write routes below), so
	// it sits here rather than next to POST /api/upload.
	if (url.pathname === UPLOAD2_PATH && req.method === "GET") {
		handleUpload2(req, res, q);
		return;
	}

	// #56: a card attachment may be a reference (file:<abs>). Same GET/HEAD shape as
	// /api/media, the allowlist is inside handleRef.
	if (url.pathname === "/api/ref") {
		if (req.method !== "GET" && req.method !== "HEAD") {
			sendJson(res, 405, { ok: false, error: "method not allowed" });
			req.resume();
			return;
		}
		handleRef(req, res, q.get("f"));
		return;
	}
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
		if (url.pathname === "/api/db/diagnose" || url.pathname === "/api/db/vacuum") {
			void dbMaintenance(url.pathname, res).catch(() =>
				sendJson(res, 500, { ok: false, error: "db maintenance failed" }),
			);
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
		// #85: `/` is always served - the dashboard's own fetch shows the login guidance
		// when it gets a 401, so the page itself is the entry point, not an error page.
		// `?token=` is the way in: it is swapped for the cookie and the browser is sent to
		// the bare path, so the secret does not stay in the address bar, history or a shared
		// link. A wrong token is still a 401 (it must not become a cookie).
		const given = url.searchParams.get("token");
		if (given !== null) {
			if (!tokenMatches(given)) {
				sendJson(res, 401, { ok: false, error: "unauthorized" });
				return;
			}
			res.writeHead(303, {
				"Set-Cookie": `${TOKEN_COOKIE}=${ensureToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${TOKEN_TTL_SEC}`,
				Location: "/",
				"Content-Type": "text/html; charset=utf-8",
			});
			res.end();
			return;
		}
		res.writeHead(200, {
			"Content-Type": "text/html; charset=utf-8",
			// #80-⑩: a cross-origin page must not be able to frame the board and overlay its
			// own controls on top of it — a clickjacked move/remove is a write the user never
			// made, and the token gate does not help because the browser sends the cookie.
			"X-Frame-Options": "SAMEORIGIN",
			"Content-Security-Policy": "frame-ancestors 'self'",
		});
		res.end(DASHBOARD_HTML);
		return;
	}
	if (url.pathname === "/api/dashboard") {
		void dashboardPayload().then(
			(body) => sendEtagJson(req, res, JSON.stringify(body)),
			() => sendJson(res, 500, { ok: false, error: "dashboard failed" }),
		);
		return;
	}
	if (url.pathname === "/api/kanban") {
		// #17: a stale tab still asks for scope=session. parseScope reads that as project, so
		// answering it would hand back (and let the page write) a project board named by a
		// session id. Refuse instead.
		if (q.get("scope") === "session") {
			sendJson(res, 400, { ok: false, error: SESSION_SCOPE_GONE });
			return;
		}
		// A bare call (no scope) stays a 200 read: it is the readiness probe every caller and
		// test uses, and sid===null means "this process's cwd", never someone else's board.
		const sidRaw = q.get("sid");
		const sid = sidRaw === null || sidRaw === "" ? null : sidRaw;
		const f = readModesFile();
		// #38-14: absent fields = the unchanged payload; present = cards are projected.
		const fieldsRaw = q.get("fields");
		const keys = fieldsRaw === null ? null : fieldsRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
		const global = aggregateGlobal();
		// Phase 0: the project board needs no sid - the browser's session names the cwd, and
		// without one the active session (or this process) stands in for it.
		// #35: ?p=<slug> names the board outright. Without it, cwd resolution can fall back to
		// process.cwd() (the pi-web install dir) and answer for a board nobody asked for. A
		// present-but-invalid p is a 400, never a silent fallback to that cwd.
		const p = boardKeyOfP(q);
		if (p.named && p.key === "") {
			sendJson(res, 400, { ok: false, error: P_BAD });
			return;
		}
		// #36: `?p=` is the caller spelling, not the board; boardKeyOfP answers the stored one.
		// #93: a sid nobody published has no cwd, so resolving it would name the driver's board:
		// refuse like the write gate does, instead of showing a board nobody asked for.
		const cwdKey = p.named ? p.key : projectKeyOfWrite(sid);
		if (cwdKey === null) {
			sendJson(res, 400, { ok: false, error: "unknown sid" });
			return;
		}
		const storedSid = p.named ? cwdKey : storedProjectKey(cwdKey);
		const pb = readBoard(boardPath("project", storedSid));
		// #52: whose eyes is this? ?sid= names the session explicitly; without it the driver
		// stands in (the dashboard sends none, and it is the driver's board it draws). "" = no
		// viewer (a curl, a process with no session): every TODO is shown, hiddenTodoCount 0.
		const viewer = sid ?? ""; // #52-fix: 暗黙 fallback (activeSessionId) は最近の subagent に化け得るので外す。sid 無し = 全 TODO 見せ。
		// ?showOthers=1 = the explicit "go get the other sessions' TODOs" mode behind the badge.
		const showOthers = q.get("showOthers") === "1";
		sendJson(res, 200, {
			ok: true,
			projectId: storedSid,
			global: keys === null ? global : projectBoard(global, keys),
			// `fields=` still wins: a projected answer stays a bare Board (the callers that
			// ask for it want cards only). Without it, answer the same keys as /api/dashboard.
			project:
				keys === null
					? projectReport(storedSid, pb, f, viewer, showOthers)
					: projectBoard(pb, keys),
			// #26: global is an aggregate view with no switches, so the panel has one row.
			// Kept for the callers that read it from here instead of project.modes.
			modes: { project: modesFor(f, storedSid, "project") },
		});
		return;
	}
	if (url.pathname === "/api/weekly") {
		const week = q.get("week");
		// ?week= は ISO 週の往復検証を通らないと 400（"2026-W54" のような存在しない週を弾く）。
		// 空文字もここで落ちる: weekRange("") === null。
		if (week !== null && weekRange(week) === null) {
			sendJson(res, 400, { ok: false, error: "bad week" });
			return;
		}
		let body: unknown;
		try {
			body = weeklyPayload(week);
		} catch {
			sendJson(res, 500, { ok: false, error: "weekly failed" });
			return;
		}
		sendEtagJson(req, res, JSON.stringify(body));
		return;
	}
	if (url.pathname === "/api/projects") {
		void projectsPayload().then(
			(body) => sendEtagJson(req, res, JSON.stringify(body)),
			() => sendJson(res, 500, { ok: false, error: "projects failed" }),
		);
		return;
	}
	if (url.pathname === "/api/project") {
		const project = normalizeProject(q.get("project"));
		if (project === "") {
			sendJson(res, 400, { ok: false, error: "project must match [A-Za-z0-9._-]" });
			return;
		}
		// No name = the slug. Renaming is the only reason to call this: a card naming the
		// slug is enough to make the project exist.
		const name = (q.get("name") ?? "").trim() || project;
		sendJson(res, 200, { ok: true, created: kanbanDb().writeProject(project, name) });
		return;
	}
	if (url.pathname === "/api/decision") {
		const db = kanbanDb();
		const action = q.get("action");
		// Same rule as /api/serve: an unknown action is a 400, not the default branch.
		if (action !== null && action !== "delete") {
			sendJson(res, 400, { ok: false, error: "action must be delete" });
			return;
		}
		if (action === "delete") {
			const id = Number(q.get("id"));
			if (!Number.isInteger(id) || id <= 0) {
				sendJson(res, 400, { ok: false, error: "id must be a positive integer" });
				return;
			}
			sendJson(res, 200, { ok: true, deleted: db.deleteDecision(id) });
			return;
		}
		const text = (q.get("text") ?? "").trim();
		if (text === "") {
			sendJson(res, 400, { ok: false, error: "text required" });
			return;
		}
		const projectRaw = q.get("project") ?? "";
		const project = normalizeProject(projectRaw);
		// Same rule as /api/add: only an exact empty string means "no project at all".
		if (project === "" && projectRaw !== "") {
			sendJson(res, 400, { ok: false, error: "project must match [A-Za-z0-9._-]" });
			return;
		}
		const why = (q.get("why") ?? "").trim();
		sendJson(res, 200, { ok: true, decision: db.addDecision(project, text, why === "" ? undefined : why) });
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
		// #34: modes.json keys are case-sensitive while the DB is NOCASE, so the write has to
		// use the same stored spelling the poll and the dashboard read (boardKeyFor).
		const bkey = storedProjectKey(sid);
		const n = plan.n;
		if (!isValidMaxLoops(n)) {
			sendJson(res, 400, { ok: false, error: `n must be an integer 0..${MAX_LOOPS_CAP} (0 = unlimited)` });
			return;
		}
		const f = readModesFile();
		setMaxLoops(f, bkey, scope, n);
		writeModesFile(f);
		sendJson(res, 200, {
			ok: true,
			// #26: the panel draws one row now - global owns no switches.
			modes: { project: modesFor(f, bkey, "project") },
		});
		return;
	}

	// #84: the right-panel template was retired, so its 404 guard went with it. A stale
	// caller now falls through to the board gate's sid 400 — still "no such document"
	// for the #83 probe, which only needs "not served".

	// #26: the switch routes were the one global caller that was not a board write. global has no
	// switch now, so they answer the scope here, before the board gate below would word it as a
	// read-only board.
	if (parseScope(q.get("scope")) === "global" && ["/api/modes", "/api/interval", "/api/stuck", "/api/resume", "/api/halt"].includes(url.pathname)) {
		sendJson(res, 400, { ok: false, error: GLOBAL_NO_SWITCH });
		return;
	}

	const target = writeBoardPath(q);
	if (!target.ok) {
		sendJson(res, 400, { ok: false, error: target.error });
		return;
	}
	const path = target.path;
	const b = readBoard(path);

	switch (url.pathname) {
		case "/api/add": {
			const text = (q.get("text") ?? "").trim();
			if (text.length === 0) {
				sendJson(res, 400, { ok: false, error: "text required" });
				return;
			}
			// #82: a deliverable is not a phase. Say so instead of quietly making a TODO card.
			if (colParam === "deliverable") {
				sendJson(res, 400, { ok: false, error: "deliverable is not a phase" });
				return;
			}
			const col = parseCol(colParam) ?? "todo";
			const card: Card = { id: b.nextId++, text, col };
			stampMove(card, actorOf(q));
			const projectRaw = q.get("project");
			const project = normalizeProject(projectRaw);
			// Only an exact empty string clears; anything else unnormalizable is a typo.
			if (project === "" && (projectRaw ?? "") !== "") {
				sendJson(res, 400, { ok: false, error: "project must match [A-Za-z0-9._-]" });
				return;
			}
			if (project !== "") card.project = project;
			const sessionRaw = q.get("session");
			const sessionId = normalizeSessionId(sessionRaw);
			// Same rule as project: only an exact empty string means "no session".
			if (sessionId === "" && (sessionRaw ?? "") !== "") {
				sendJson(res, 400, { ok: false, error: "session must match [A-Za-z0-9._:@-]" });
				return;
			}
			const commitRaw = q.get("commit");
			const commit = normalizeCommit(commitRaw);
			// Same rule as project: only an exact empty string means "no commit". normalizeCommit
			// trims, so commit=%20%20 is a typo and commit=%20abc1234%20 is a value.
			if (commit === "" && (commitRaw ?? "") !== "") {
				sendJson(res, 400, { ok: false, error: "commit must be 7-40 hex characters" });
				return;
			}
			const due = parseDue(q.get("due"));
			if (due === null) {
				sendJson(res, 400, { ok: false, error: "due must be YYYY-MM-DD" });
				return;
			}
			const estimate = parseEstimate(q.get("estimate"));
			if (estimate === null) {
				sendJson(res, 400, { ok: false, error: "estimate must be an integer >= 0" });
				return;
			}
			const blocks = parseBlocks(q.get("blocks"));
			if (blocks === null) {
				sendJson(res, 400, { ok: false, error: "blocks must be a comma-separated list of card ids" });
				return;
			}
			// #22: no labels param at all is the old payload; a bad one is a typo, not a clear.
			const labels = parseLabels(q.get("labels"));
			if (labels === null) {
				sendJson(res, 400, { ok: false, error: `labels must be a comma-separated list of: ${LABELS.join(", ")}` });
				return;
			}
			if (blocks.length > 0 && wouldCycle(b.cards, card.id, blocks)) {
				sendJson(res, 400, { ok: false, error: "blocks must not form a cycle" });
				return;
			}
			if (due !== undefined) card.due = due;
			if (estimate !== undefined) card.estimate = estimate;
			if (sessionId !== "") card.sessionId = sessionId;
			if (commit !== "") card.commit = commit;
			if (blocks.length > 0) card.blocks = blocks;
			if (labels.length > 0) card.labels = labels;
			b.cards.push(card);
			// #94: ダッシュボードの「+」はユーザーの意思なので、次の poll は 5 分待たない。
			// slug は書き込み先から取る（route がボードを特定したのと同じ値。sid から引き直すと
			// storedProjectKey の揺れで poll の key とズレ、永久に発火しなくなる）。
			// 合図は永続化が通ったときだけ: writeBoard は失敗を戻り値で返す（throw しない）。
			// TODO 以外（doing/done 直行）はループの仕事ではない。
			if (writeBoard(path, b) === null && col === "todo") userPickAt.set(storedProjectKey(boardKeyOf(path).sid), Date.now());
			sendJson(res, 200, { ok: true, cards: b.cards });
			return;
		}
		// #50: 複数行の一括追加。パースは parseQuickAdd が持ち、ここは id を詰めて 1 回だけ書く。
		case "/api/quickadd": {
			const parsed = parseQuickAdd(q.get("text") ?? "", b.nextId);
			if (!parsed.ok) {
				sendJson(res, 400, { ok: false, error: parsed.error });
				return;
			}
			const sid = actorOf(q);
			for (const card of parsed.cards) {
				// 新しい id は既存カードの blocks から指され得るので、/api/add と同じ検査を通す。
				if (card.blocks !== undefined && wouldCycle(b.cards, card.id, card.blocks)) {
					sendJson(res, 400, { ok: false, error: "blocks must not form a cycle" });
					return;
				}
				stampMove(card, sid);
				b.cards.push(card);
			}
			b.nextId += parsed.cards.length;
			// #94: /api/quickadd も入力欄の + の経路（複数行・トークン付き）で、作るカードは常に todo。
			// /api/add と同じく「ユーザーが今足した」合図を置く。
			if (parsed.cards.length > 0 && writeBoard(path, b) === null) userPickAt.set(storedProjectKey(boardKeyOf(path).sid), Date.now());
			sendJson(res, 200, { ok: true, cards: b.cards, added: parsed.cards });
			return;
		}
		case "/api/move": {
			// #82: a deliverable is output, not a phase. Its rows live in deliv.
			if (colParam === "deliverable") {
				sendJson(res, 400, { ok: false, error: "deliverable is not a phase" });
				return;
			}
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
			// #18: same-column moves are a no-op (moveCardTo). The save stays unconditional.
			moveCardTo(card, col, actorOf(q));
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
			// A removed card must not stay in anyone's blocks: the card that would clear
			// it is gone, so the dependent would wait forever for nothing.
			for (const c of b.cards) {
				if (c.blocks && c.blocks.includes(id)) c.blocks = c.blocks.filter((x) => x !== id);
			}
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
			// A project write needs a sid (only its cwd can name the board); any sid is accepted —
			// there is no per-session write lock. #26: scope=global was refused above, so the
			// #67 global-panel fallback this comment used to justify is gone with the panel.
			const sid = settingsSidOf(q, res);
			if (sid === null) return;
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
			// #26: the global scope was refused above, so a switch write is always project.
			const f = readModesFile();
			setMode(f, sid, "project", key, value === "on");
			writeModesFile(f);
			sendJson(res, 200, { ok: true, modes: { project: modesFor(f, sid, "project") } });
			return;
		}
		case "/api/interval": {
			// Same sid rule as every other write (writeBoardPath above); names only the interval.
			const sid = settingsSidOf(q, res);
			if (sid === null) return;
			const minutes = Number(q.get("min"));
			if (!Number.isFinite(minutes) || minutes <= 0) {
				sendJson(res, 400, { ok: false, error: "min must be a positive number" });
				return;
			}
			const f = readModesFile();
			setIntervalMin(f, sid, "project", minutes);
			writeModesFile(f);
			sendJson(res, 200, { ok: true, modes: { project: modesFor(f, sid, "project") } });
			return;
		}
		case "/api/stuck": {
			// Same sid rule and naming as /api/interval; n is a settle COUNT, not minutes.
			const sid = settingsSidOf(q, res);
			if (sid === null) return;
			const n = Number(q.get("n"));
			if (!isValidStuckLimit(n)) {
				sendJson(res, 400, { ok: false, error: `n must be an integer 1..${MAX_STUCK_LIMIT}` });
				return;
			}
			const f = readModesFile();
			setStuckLimit(f, sid, "project", n);
			writeModesFile(f);
			sendJson(res, 200, { ok: true, modes: { project: modesFor(f, sid, "project") } });
			return;
		}
		case "/api/resume": {
			// #67: ダッシュボードの「再開」。(sid,scope) は他の書き込みと同じで、実際の書き換えは
			// そのセッションの poll が行う（halt はサーバではなく拡張プロセスのメモリ）。
			// ここは 202 で受けるだけ: 見つからないときは 404 を返さない
			// （セッションはいるが今は止まっていない、が普通なので）。
			const key = settingsSidOf(q, res);
			if (key === null) return;
			// #17: resume is process state. The poll consumes it by the DRIVER's session id, so a
			// project-scope request (which resolves to a slug) has to be re-keyed onto the actor.
			// No driver yet (activeSessionId null): the key stays a slug, but poll returns at skip:no-ctx,
			// so nothing ever reads it back. Harmless.
			const sid = activeSessionId ?? key;
			// One counter of outstanding requests: a stuck consumer must not grow the map.
			const pending = (resumeRequests.get(sid) ?? 0) + 1;
			resumeRequests.set(sid, Math.min(pending, 5));
			sendJson(res, 202, { ok: true, queued: true, sid });
			return;
		}
		case "/api/halt": {
			// #48: 再開（/api/resume）の逆。halt はサーバではなく拡張プロセスのメモリなので、
			// ここも 202 で受けるだけ。実際の停止はそのセッションの poll が行う。
			const key = settingsSidOf(q, res);
			if (key === null) return;
			// #17: resume と同じ re-key。process state はドライバの sid で引く。
			const sid = activeSessionId ?? key;
			haltRequests.add(sid);
			sendJson(res, 202, { ok: true, queued: true, sid });
			return;
		}
		case "/api/priority": {
			// Same sid rule and naming as /api/stuck; n is a card's autoPick priority (not minutes).
			const sid = settingsSidOf(q, res);
			if (sid === null) return;
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
			if (q.get("at") === null && q.get("blocked") === null && q.get("project") === null && q.get("session") === null && q.get("commit") === null && q.get("labels") === null) {
				sendJson(res, 400, { ok: false, error: "at, blocked, project, session, commit or labels is required" });
				return;
			}
			const card = b.cards.find((c) => c.id === Number(idParam));
			if (!card) {
				sendJson(res, 404, { ok: false, error: `no card with id ${idParam}` });
				return;
			}
			// Validate every parameter before mutating: a 400 must not leave half the change applied.
			const at = q.get("at");
			const atIso = at === null ? null : normalizeFireAt(at);
			// Non-empty but unparseable is a user mistake, not a clear.
			if (at !== null && atIso === null && at.trim().length > 0) {
				sendJson(res, 400, { ok: false, error: "at must be ISO 8601 or +Nm/+Nh/+Nd" });
				return;
			}
			const blocked = q.get("blocked");
			const projectParam = q.get("project");
			const p = projectParam === null ? null : normalizeProject(projectParam);
			// Only an exact empty string clears; anything else unnormalizable (incl. spaces) is a typo.
			if (p !== null && p.length === 0 && projectParam !== "") {
				sendJson(res, 400, { ok: false, error: "project must match [A-Za-z0-9._-]" });
				return;
			}
			const sessionParam = q.get("session");
			const sess = sessionParam === null ? null : normalizeSessionId(sessionParam);
			if (sess !== null && sess.length === 0 && sessionParam !== "") {
				sendJson(res, 400, { ok: false, error: "session must match [A-Za-z0-9._:@-]" });
				return;
			}
			const commitParam = q.get("commit");
			const sha = commitParam === null ? null : normalizeCommit(commitParam);
			if (sha !== null && sha.length === 0 && commitParam !== "") {
				sendJson(res, 400, { ok: false, error: "commit must be 7-40 hex characters" });
				return;
			}
			// #22: whole-set replacement, like project/session/commit - labels=bug clears 調査.
			// undefined = 未指定（触らない）, null = 不正な値。ここを null 一つで兼ねると
			// labels を渡さない全呼び出しが 400 になる。
			const labelsParam = q.get("labels");
			const labs = labelsParam === null ? undefined : parseLabels(labelsParam);
			if (labs === null) {
				sendJson(res, 400, { ok: false, error: `labels must be a comma-separated list of: ${LABELS.join(", ")}` });
				return;
			}
			if (at !== null) {
				if (atIso === null) {
					delete card.nextFireAt;
					delete card.firedFor;
				} else card.nextFireAt = atIso;
			}
			if (blocked !== null) {
				const t = blocked.trim();
				if (t.length === 0) delete card.blocked;
				else card.blocked = t;
			}
			if (p !== null) {
				if (p.length === 0) delete card.project;
				else card.project = p;
			}
			if (sess !== null) {
				if (sess.length === 0) delete card.sessionId;
				else card.sessionId = sess;
			}
			if (sha !== null) {
				if (sha.length === 0) delete card.commit;
				else card.commit = sha;
			}
			if (labs !== undefined) {
				if (labs.length === 0) delete card.labels;
				else card.labels = labs;
			}
			writeBoard(path, b);
			sendJson(res, 200, { ok: true, cards: b.cards });
			return;
		}
		// #82: the deliverables' own routes. They are not cards: no col, no phase, no nextId.
		// `p=` (writeBoardPath) decides the board; the id sequence is delivNextId.
		case "/api/deliv/add": {
			const text = (q.get("text") ?? "").trim();
			if (text.length === 0) {
				sendJson(res, 400, { ok: false, error: "text required" });
				return;
			}
			const deliverable: Deliv = { id: b.delivNextId++, text, at: Date.now() };
			b.deliverables.push(deliverable);
			writeBoard(path, b);
			sendJson(res, 200, { ok: true, deliverable });
			return;
		}
		case "/api/deliv/edit": {
			const text = (q.get("text") ?? "").trim();
			if (text.length === 0) {
				sendJson(res, 400, { ok: false, error: "text required" });
				return;
			}
			const deliverable = b.deliverables.find((d) => d.id === Number(idParam));
			if (deliverable === undefined) {
				sendJson(res, 404, { ok: false, error: `no deliverable with id ${idParam}` });
				return;
			}
			deliverable.text = text;
			writeBoard(path, b);
			sendJson(res, 200, { ok: true, deliverable });
			return;
		}
		case "/api/deliv/remove": {
			const deliverable = b.deliverables.find((d) => d.id === Number(idParam));
			if (deliverable === undefined) {
				sendJson(res, 404, { ok: false, error: `no deliverable with id ${idParam}` });
				return;
			}
			// Same rule as a card: only our own media names, and only when nothing else shows them.
			trashUnusedMedia(b, "deliv", deliverable.id, mediaNames(deliverable.img));
			b.deliverables = b.deliverables.filter((d) => d.id !== deliverable.id);
			writeBoard(path, b);
			sendJson(res, 200, { ok: true });
			return;
		}
		// #61: drop ONE attachment entry (the deliverables tile's ×). `n` is the index after
		// the dashboard's csv split. A reference (`file:<abs>`) leaves its file alone - only
		// the csv entry is ours; a media name is trashed unless another card still shows it.
		// Removing the last entry drops `img` itself, so the card stops being a deliverable.
		case "/api/attach/del": {
			const t = mediaTarget(q, b);
			if (t.kind === "missing") {
				sendJson(res, 404, { ok: false, error: t.error });
				return;
			}
			if (t.kind === "new") {
				sendJson(res, 400, { ok: false, error: "id required" });
				return;
			}
			const owner: { id: number; img?: string } = t.kind === "deliv" ? t.deliv : t.card;
			const list = (owner.img ?? "").split(",").map((s) => s.trim()).filter(Boolean);
			const nRaw = q.get("n");
			const n = Number(nRaw);
			// nRaw empty/null first: Number("") and Number(null) are both 0, which would
			// silently mean "the first one" instead of a 400.
			if (nRaw === null || nRaw.trim() === "" || !Number.isInteger(n) || n < 0 || n >= list.length) {
				sendJson(res, 400, { ok: false, error: `n out of range (0..${list.length - 1})` });
				return;
			}
			const gone = list.splice(n, 1)[0];
			// #92: one rule, shared with /api/deliv/remove and the deliverable tool.
			trashUnusedMedia(b, t.kind, owner.id, [gone]);
			if (list.length === 0) delete owner.img;
			else owner.img = list.join(",");
			writeBoard(path, b);
			sendJson(res, 200, { ok: true, cards: b.cards, deliverables: b.deliverables });
			return;
		}
		default:
			sendJson(res, 404, { ok: false, error: "not found" });
	}
}

/**
 * #83b: the board URL a human (or the agent answering "where's the board?") hands to a
 * browser. The token rides in the query exactly once: `GET /?token=` swaps it for an
 * HttpOnly cookie and 303s to the bare `/`. Never embed it in the HTML itself.
 */
function boardUrl(): string {
	return `${serveBaseUrl()}/?token=${ensureToken()}`;
}

/** The board URL without the secret: safe for the prompt block (and stable across restarts). */
function boardUrlBare(): string {
	return `${serveBaseUrl()}/`;
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
		// #83b: header, not `?token=` - a path is matched verbatim by the servers we are
		// fingerprinting, and an old kanban would 404 the query away.
		const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { signal: AbortSignal.timeout(1500), headers: probeHeaders() });
		if (r.status !== 200) return null;
		const body: unknown = await r.json();
		return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** #83b: /api is token-gated, so the self-probe has to present ours. Tokens never reach
 * the log; this header is only ever sent to 127.0.0.1 on our own port. */
function probeHeaders(): Record<string, string> {
	return { Cookie: `${TOKEN_COOKIE}=${ensureToken()}` };
}

/** #83: does the listener on PORT answer /api/dashboard with JSON? Current-gen kanban only. */
async function servesDashboard(): Promise<boolean> {
	return (await probeJson("/api/dashboard")) !== null;
}

/** #83b: `/api/kanban` はどの世代も残す指紋。`projectId`（Phase 0 以降）か `sessionId`
 * （#17 以前）があれば「kanban である」の判定になる。cards/modes/stats は世代で違うので見ない。
 * 世代そのものは版・identity 側が判定する。 */
async function servesBoard(): Promise<boolean> {
	const body = await probeJson("/api/kanban");
	return body !== null && body.ok === true && ("projectId" in body || "sessionId" in body);
}

/** #83b: `/api/kanban.html` is served only before #67 (the pi-web split deleted it). */
async function servesLegacyPanel(): Promise<boolean> {
	try {
		const r = await fetch(`http://127.0.0.1:${PORT}/api/kanban.html`, { signal: AbortSignal.timeout(1500), headers: probeHeaders() });
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
			headers: probeHeaders(),
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
		// #83b: the token is the one piece of startup work a request needs - without it
		// the first request after bind answers 401. A token file that cannot be written
		// still leaves a process-local token, so the board stays reachable for this run.
		ensureToken();
		// Startup-only: the branch above keeps this to a real first attempt.
		void firstStart();
		return;
	}
	void startListening();
}

/**
 * The first real attempt. The scope reset is a synchronous DELETE, so it runs before the
 * bind and no write route has to wait for it: `migrationPending` stays null (its gate never
 * closes) and #84's "the first request of a cold start does not wait" still holds.
 */
async function firstStart(): Promise<void> {
	// Sync, and its global board must exist before the reset runs.
	migrateLegacyBoard();
	resetScopesOnce();
	void startListening();
	sweepServe(); // 起動時に一度。以降は poll が 1 時間 throttle で回す。
	lastServeSweep = Date.now();
	writeBoardHtml();
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
		// #63: /api/ehr carries its value in the query, so the request line alone can pass
		// node's 16KB header default (a 128KB value is refused with 431, not 413). The cap
		// stays local: this budget is per incoming request, and the route is the one that
		// answers without a token.
		const s = createServer({ maxHeaderSize: QUIZ_EHR_MAX_BYTES * 4 }, handle);
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
// Dashboard shell (GET /). The source is web/dashboard.html; `npm run build`
// expands web/md.js and web/memory.js into it and writes dashboard.generated.ts.
// __KB_HOST__ is filled in per listening host.
// ---------------------------------------------------------------------------
const DASHBOARD_HTML = DASHBOARD_TEMPLATE.replace(/__KB_HOST__/g, hostLabel);

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
	// #51-②: when the settle chain last injected. A chain never touches lastTickAt (that clock
	// is the poll's pacing), so the starvation guard needs this to see a loop that is alive.
	// Per session like lastTickAt: one closure per session; module scope would let a sibling's
	// settle silence this session's starvation escape (the same bug lastTickAt is per-session for).
	let lastChainAt = 0;
	let tickInFlight = false;
	// True only while a /kanban dialog is on screen: a menu must never be talked over.
	const uiGuard = { menuOpen: false };
	/** #51-④: the one menu test, read by the poll gate and by the settle gate. */
	const menuOpen = (): boolean => uiGuard.menuOpen;
	// #51-⑤(c): the halt reason is worth one sentence, once, on the first injection after a resume.
	let resumeNote: "stuck" | "limit" | null = null;

	/**
	 * Build one injection and spend the one-shot extras. `limit` is the driving board's stuck
	 * threshold; without it the `(n/3)` note is omitted rather than guessed.
	 */
	const injectPrompt = (card: Card, scope: Scope, limit: number | undefined): string => {
		const note = resumeNote;
		resumeNote = null; // one shot: the injection after this one must not repeat it
		return continuationPrompt(card, scope, {
			resumeNote: note ?? undefined,
			stuck:
				limit !== undefined && loop.stuckCount >= STUCK_NOTE_FROM
					? { count: loop.stuckCount, limit }
					: undefined,
		});
	};

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
				// The old JSONL could name `global` (or `session`), neither of which LoopState admits.
				const d = (entry.data ?? {}) as Partial<Omit<LoopState, "scope">> & { scope?: Scope | null };
				// #26: global never drives, and its budget is not the project board's. Nulling only
				// `scope` left count/halted/stuckCount behind, and paintLoop reads a null scope AS
				// project - so a legacy global entry at its cap halted this board on the first
				// settle. Drop the counter side too; an entry with no scope is a real project count.
				const legacyGlobal = d.scope === "global";
				loop = {
					count: legacyGlobal ? 0 : typeof d.count === "number" ? d.count : 0,
					halted: !legacyGlobal && (d.halted === "limit" || d.halted === "stuck") ? d.halted : null,
					scope: d.scope === "project" ? "project" : null,
					stuckId: legacyGlobal ? null : typeof d.stuckId === "number" ? d.stuckId : null,
					stuckCount: legacyGlobal ? 0 : typeof d.stuckCount === "number" ? d.stuckCount : 0,
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
		const scope = loop.scope ?? "project";
		const tag = haltTag(loop);
		// One settle drives one board: leaving a tag on another line would be a lie. Both lines
		// are redrawn because only the driving one carries the tag.
		for (const s of ["global", "project"] as const) {
			setLoopTag(sid, s, s === scope ? tag : "");
			loopCount.delete(tagKey(sid, s));
		}
		// Only the count is published; modeTags turns it into "3/10" against the cap it
		// reads at draw time, so the footer can never show a cap the file no longer has.
		if (loop.count > 0) loopCount.set(tagKey(sid, scope), loop.count);
		// Same value the footer shows, published for the HTTP dashboard (see haltedBySid).
		if (loop.halted === null) haltedBySid.delete(sid);
		else {
			const cap = maxLoopsOf(modesFor(readModesFile({ repair: false }), boardKeyFor(ctx, sid, scope), scope));
			haltedBySid.set(sid, { halted: loop.halted, stuckId: loop.stuckId, stuckCount: loop.stuckCount, cap, scope });
		}
		refresh(ctx, sid);
	};

	/**
	 * Clear the halt and give the loop its budget back. The project board's doingLoop goes ON
	 * because turning it off is what caused a `limit` halt; a `stuck` halt is lifted too,
	 * since a resume is the user saying "try again". Shared by `/kanban loop on`
	 * and the `kanban` tool's resume so the two can never drift.
	 * #26: global has no switch to turn back on - it cannot drive.
	 */
	const resetLoopForResume = (): { was: string; oldCount: number } => {
		const was = loop.halted === null ? "なし" : `halted:${loop.halted}`;
		const oldCount = loop.count;
		// #51-⑤(c): remember what was lifted while it is still known; injectPrompt spends it.
		resumeNote = loop.halted;
		loop = { count: 0, halted: null, scope: null, stuckId: null, stuckCount: 0, lastActivityAt: 0 };
		lastTickAt = 0; // resume must fire on the next poll, not after the interval
		lastChainAt = 0; // #51-②: the chain clock belongs to the halted loop it measured
		pollSnapshot = null; // force the next poll to redraw
		warnedDeadCtx = false;
		deadCtxStrikes = 0;
		persistLoop();
		return { was, oldCount };
	};

	/**
	 * #67: the one resume. resetLoopForResume alone is not a resume — the cap achieved its
	 * stop by switching the driving board's doingLoop off (#26: project is the only one that
	 * can be switched), so lifting the halt while that stays off would resume a loop that
	 * still cannot run. Shared by `/kanban loop on`, the `kanban`
	 * tool's resume and the dashboard's 再開 (via /api/resume -> resumeRequests).
	 */
	const resumeWithModes = (ctx: ExtensionContext, sid: string): { was: string; oldCount: number } => {
		const before = resetLoopForResume();
		const f = readModesFile();
		// #26: only the project board can drive, so only its switch is turned back on.
		// #34: the same stored spelling the GUI writes, or the resume turns on a key no poll reads.
		setMode(f, boardKeyFor(ctx, sid, "project"), "project", "doingLoop", true);
		writeModesFile(f);
		// #89: a resume turns the loop back ON, so the timer must exist. No-op when it already
		// does (the /api/resume path runs inside poll) and when this process has no ownCtx yet;
		// adopting an owner here would steal the driver from the session that pinned it.
		ensurePollTimer();
		paintLoop(ctx, sid); // clears the footer tag and the dashboard's halted row
		return before;
	};

	/**
	 * `/kanban loop on|off|status` and `/kanban pick on|off`. `loop on` is also the
	 * reset: a halted loop restarts only when the user asks for it.
	 */
	const runModeCommand = (ctx: ExtensionContext, sid: string, scope: Scope, key: SwitchKey, sub: string | undefined): void => {
		// #26: global waves no switch any more; say so instead of writing a bucket nobody reads.
		if (scope === "global") {
			ctx.ui.notify(GLOBAL_NO_SWITCH);
			return;
		}
		if (sub !== undefined && sub !== "on" && sub !== "off" && sub !== "status") {
			ctx.ui.notify("使い方: /kanban loop on|off|status / /kanban pick on|off");
			return;
		}
		const f = readModesFile();
		// #17: the modes key is the board key (a slug for project), never the session id.
		const bkey = boardKeyFor(ctx, sid, scope);
		if (sub === "on" || sub === "off") {
			setMode(f, bkey, scope, key, sub === "on");
			writeModesFile(f);
			// Only `loop` owns the budget and the halt: `pick` must not clear a LOOP HALTED banner.
			if (key === "doingLoop") resetLoopForResume();
		}
		ctx.ui.notify(statusText(modesFor(readModesFile(), bkey, scope), loop, scope));
		paintLoop(ctx, sid);
	};

	/** `/kanban interval [分]`: no value = show, invalid = reject without writing. */
	const runIntervalCommand = (ctx: ExtensionContext, sid: string, scope: Scope, minutes: number | undefined): void => {
		// #26: global は集約ビューでスイッチを持たない。書いても読まれないので notify で止める。
		if (scope === "global") {
			ctx.ui.notify(GLOBAL_NO_SWITCH);
			return;
		}
		const f = readModesFile(); // writes back a corrupt file once; the poll uses the read-only form
		const bkey = boardKeyFor(ctx, sid, scope); // #17: the modes key is the board key
		if (minutes === undefined) {
			ctx.ui.notify(`[${scope}] 自動再開の間隔: ${intervalMinOf(modesFor(f, bkey, scope))}分`);
			return;
		}
		if (!Number.isFinite(minutes) || minutes <= 0) {
			ctx.ui.notify(`不正な値: ${minutes}。現状維持（0より大きい分数を指定）`);
			return;
		}
		setIntervalMin(f, bkey, scope, minutes);
		writeModesFile(f);
		lastTickAt = 0; // a shorter interval applies now, not after the old one elapses
		ctx.ui.notify(`[${scope}] 自動再開の間隔を ${minutes}分 に設定`);
		refresh(ctx, sid);
	};

	/** `/kanban stuck [回]`: no value = show, invalid = reject without writing. */
	const runStuckCommand = (ctx: ExtensionContext, sid: string, scope: Scope, count: number | undefined): void => {
		if (scope === "global") {
			ctx.ui.notify(GLOBAL_NO_SWITCH);
			return;
		}
		const f = readModesFile();
		const bkey = boardKeyFor(ctx, sid, scope); // #17: the modes key is the board key
		if (count === undefined) {
			ctx.ui.notify(`[${scope}] スタック判定: ${stuckLimitOf(modesFor(f, bkey, scope))}回`);
			return;
		}
		if (!isValidStuckLimit(count)) {
			ctx.ui.notify(`不正な値: ${count}。現状維持（1〜${MAX_STUCK_LIMIT}の整数を指定）`);
			return;
		}
		setStuckLimit(f, bkey, scope, count);
		writeModesFile(f);
		ctx.ui.notify(`[${scope}] スタック判定を ${count}回 に設定`);
		refresh(ctx, sid);
	};

	/** #67: `/kanban maxloops [回]`。0 = 無制限。無指定で現在値。stuck と同じ形。 */
	const runMaxLoopsCommand = (ctx: ExtensionContext, sid: string, scope: Scope, n: number | undefined): void => {
		if (scope === "global") {
			ctx.ui.notify(GLOBAL_NO_SWITCH);
			return;
		}
		const f = readModesFile();
		const bkey = boardKeyFor(ctx, sid, scope); // #17: the modes key is the board key
		if (n === undefined) {
			const cur = maxLoopsOf(modesFor(f, bkey, scope));
			ctx.ui.notify(`[${scope}] ループ上限: ${cur > 0 ? `${cur}回` : "無制限"}`);
			return;
		}
		if (!isValidMaxLoops(n)) {
			ctx.ui.notify(`不正な値: ${n}。現状維持（0〜${MAX_LOOPS_CAP}の整数、0 = 無制限）`);
			return;
		}
		setMaxLoops(f, bkey, scope, n);
		writeModesFile(f);
		ctx.ui.notify(`[${scope}] ループ上限を ${n > 0 ? `${n}回` : "無制限"} に設定`);
		refresh(ctx, sid);
	};

	/** A local image into media/ and onto a card. Validates everything before the first write. */
	type AttachImageResult =
		| { ok: true; card: Card; name: string; basename: string }
		| { ok: false; error: string };

	/** #92: validation only - "may this local file become a media entry?". The owner lookup is
	 * deliberately NOT here: `attachImage(b, delivId, …)` found the same-numbered CARD and
	 * attached to it silently, because a card id and a deliverable id are different spaces. */
	type PrepareImageResult = { ok: true; ext: string; bytes: Buffer; basename: string } | { ok: false; error: string };

	const prepareImage = (input: string): PrepareImageResult => {
		const sized = input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
		const abs = resolve(sized === "~" ? homedir() : sized);
		const dot = abs.lastIndexOf(".");
		const ext = dot < 0 ? "" : abs.slice(dot + 1).toLowerCase();
		if (!(MIME_BY_EXT[ext] ?? "").startsWith("image/")) {
			return { ok: false, error: `画像ではない（${ext === "" ? "拡張子無し" : `.${ext}`}）: ${abs}` };
		}
		let st: Stats;
		try {
			st = statSync(abs);
		} catch {
			return { ok: false, error: `ファイルが無い / 読めない: ${abs}` };
		}
		if (!st.isFile()) {
			return { ok: false, error: `ファイルが無い / 読めない（通常ファイルではない）: ${abs}` };
		}
		if (st.size > MAX_UPLOAD) {
			return { ok: false, error: `大きすぎる（上限 ${fmtMB(MAX_UPLOAD)}）: ${abs}` };
		}
		let bytes: Buffer;
		try {
			bytes = readFileSync(abs);
		} catch {
			return { ok: false, error: `ファイルが無い / 読めない: ${abs}` };
		}
		return { ok: true, ext, bytes, basename: basename(abs) };
	};

	/**
	 * The copy local image -> media/ -> `card.img` path, the same shape /api/upload writes
	 * (basename in `img`, bytes under MEDIA_DIR). Shared by `/kanban img` and the tool's
	 * `img` action, so both validate identically. Every validation runs before the first
	 * write: missing / unreadable / not an image / over 8MB only return, so the board can
	 * never gain a broken image path. writeBoard is the caller's job.
	 */
	const attachToCard = (b: Board, id: number, input: string): AttachImageResult => {
		const card = b.cards.find((c) => c.id === id);
		if (card === undefined) return { ok: false, error: `その id は無い: #${id}` };
		const prepared = prepareImage(input);
		if (!prepared.ok) return prepared;
		// #53: /api/upload と対称 — 追加で、置換ではない。既存添付は消さない
		const name = writeMedia(card.id, prepared.ext, prepared.bytes);
		if (name === null) return { ok: false, error: "media への書き込みに失敗" };
		card.img = card.img ? `${card.img},${name}` : name;
		return { ok: true, card, name, basename: prepared.basename };
	};

	/**
	 * #92: the same copy, onto a DELIVERABLE. Same validation, same media/ layout - only the
	 * owner is looked up in b.deliverables, which is why it is a separate function and not a
	 * flag on attachToCard (`owner=card|deliv` is exactly the shape that mis-filed the file).
	 */
	const attachToDeliv = (
		b: Board,
		id: number,
		input: string,
	): { ok: true; deliv: Deliv; name: string; basename: string } | { ok: false; error: string } => {
		const deliv = b.deliverables.find((d) => d.id === id);
		if (deliv === undefined) return { ok: false, error: `その id は無い: deliverable #${id}` };
		const prepared = prepareImage(input);
		if (!prepared.ok) return prepared;
		const name = writeMedia(deliv.id, prepared.ext, prepared.bytes);
		if (name === null) return { ok: false, error: "media への書き込みに失敗" };
		deliv.img = deliv.img ? `${deliv.img},${name}` : name;
		return { ok: true, deliv, name, basename: prepared.basename };
	};

	/**
	 * #56: attach a REFERENCE. The file stays where it is; the owner's img gets `file:<abs>`.
	 * #92: the allowlist check is shared (prepareRef); only the owner lookup is per space.
	 */
	type PrepareRefResult = { ok: true; abs: string } | { ok: false; error: string };

	const prepareRef = (input: string): PrepareRefResult => {
		const sized = input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
		if (!isAbsolute(sized) && sized !== "~") return { ok: false, error: `絶対パスで渡す: ${sized}` };
		const abs = realOrSelf(resolve(sized === "~" ? homedir() : sized));
		// The allowlist is checked here too - /api/ref refuses an outside path, so writing one
		// would only give the tile a thumbnail that never loads (a permanent 403).
		if (!isUnder(abs, serveAllowRoots())) return { ok: false, error: `allowlist の外: ${abs}` };
		try {
			if (!statSync(abs).isFile()) return { ok: false, error: `通常ファイルではない: ${abs}` };
		} catch {
			return { ok: false, error: `ファイルが無い / 読めない: ${abs}` };
		}
		return { ok: true, abs };
	};

	/** #92: `shortcut:` a path containing a comma splits into two csv entries. */
	const refToCard = (
		b: Board,
		id: number,
		input: string,
	): { ok: true; card: Card; abs: string } | { ok: false; error: string } => {
		const card = b.cards.find((c) => c.id === id);
		if (card === undefined) return { ok: false, error: `その id は無い: #${id}` };
		const prepared = prepareRef(input);
		if (!prepared.ok) return prepared;
		card.img = card.img ? `${card.img},file:${prepared.abs}` : `file:${prepared.abs}`;
		return { ok: true, card, abs: prepared.abs };
	};

	/** #92: the reference form, onto a deliverable (owner lookup in the deliv space). */
	const refToDeliv = (
		b: Board,
		id: number,
		input: string,
	): { ok: true; deliv: Deliv; abs: string } | { ok: false; error: string } => {
		const deliv = b.deliverables.find((d) => d.id === id);
		if (deliv === undefined) return { ok: false, error: `その id は無い: deliverable #${id}` };
		const prepared = prepareRef(input);
		if (!prepared.ok) return prepared;
		deliv.img = deliv.img ? `${deliv.img},file:${prepared.abs}` : `file:${prepared.abs}`;
		return { ok: true, deliv, abs: prepared.abs };
	};

	/**
	 * `/kanban img <id> <path>`: attachToCard on this cwd's project board, then save.
	 * A failed attach notifies the same message the tool reports, and writes nothing.
	 */
	const runImgCommand = (ctx: ExtensionContext, sid: string, id: number, input: string): void => {
		// #17: the card lives on this cwd's project board.
		const path = boardPath("project", boardKeyFor(ctx, sid, "project"));
		const b = readBoard(path);
		const r = attachToCard(b, id, input);
		if (!r.ok) {
			ctx.ui.notify(r.error);
			return;
		}
		writeBoard(path, b);
		ctx.ui.notify(`#${r.card.id} に画像を添付: ${r.basename}（session）`);
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

	/** Stat signature of every board layer plus modes.json; any disk change (ours or a sibling's) flips it. */
	// Boards live in sqlite now, so there is no per-board inode to stat. rev is a
	// per-board counter bumped inside the write transaction; modes.json is still a file.
	const diskSnapshot = (): string => {
		const store = kanbanDb();
		// #16: the footer's GLOBAL line is aggregateGlobal(), so the snapshot has to cover the
		// same set of boards. GLOBAL_JSON is always 0 after the migration, so watching it alone
		// left a GUI (or sibling process) write to a project board invisible to poll().
		// projectKeys() carries rev, so this is one query instead of a revOf() per board.
		const projects = store
			.projectKeys()
			.map(({ slug, rev }) => `${slug}@${rev}`)
			.join(",");
		return `${store.revOf({ scope: "global", sid: "" })}\u0000${projects}\u0000${fileSig(MODES_JSON)}`;
	};

	/** Stop the timer and release the owned ctx (session end, or a ctx that cannot answer). */
	const stopPoll = (): void => {
		if (pollTimer !== null) clearInterval(pollTimer);
		pollTimer = null;
		ownCtx = null;
	};

	/**
	 * #89: the only place the timer is created, and the pair of stopPoll(). `sync()` fires on
	 * session_start/session_tree alone, so a process that never receives one (a restart, or
	 * the `/kanban take` handover into a session that never started here) sat at
	 * pollTimer=null forever: measured 0 wakes in 90s and 0 in 8s after take. Every path that
	 * makes the loop runnable calls this instead of waiting for the next event.
	 *
	 * Two guards: no ownCtx = nothing to poll, and an existing timer must never be replaced
	 * (a second interval would halve the period and wake too early).
	 */
	const ensurePollTimer = (): void => {
		if (ownCtx === null || pollTimer !== null) return;
		// Same period as the dashboard's poll so the footer and the page converge.
		pollTimer = setInterval(poll, 1500);
		pollTimer.unref(); // a stray timer must never hold the process open
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
		// Phase 0: the fold deletes the session/global rows it just read, so a firedFor recorded
		// now dies with them. The wake itself still goes out: a dropped tick costs the loop a
		// whole interval, and the fold is over in a microtask.
		const folding = migrationPending !== null;
		sweepServeThrottled(); // 1 時間に 1 回だけ実際に走る
		weeklyTickThrottled(); // 週が変わっていたら週次サマリを確定させる（同じ間引き方）
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
		// #48: ダッシュボードの一時停止。resume と対で、同じ tick が消費する。limit halt と
		// 同じ形（doingLoop を切る）にして、停止の理由も同じ `limit` にする。loop.count は
		// 据え置き: 解除（resumeWithModes）が budget ごと戻すので、ここでは触らない。
		if (haltRequests.delete(sid)) {
			try {
				// 既に halted なら何もしない（paintLoop は現在値を保つ）。
				if (loop.halted === null) {
					const hf = readModesFile();
					const hkey = boardKeyFor(ownCtx, sid, "project");
					loop.halted = "limit";
					setMode(hf, hkey, "project", "doingLoop", false);
					writeModesFile(hf);
					persistLoop();
					paintLoop(ownCtx, sid);
					logServer(`halt from dashboard sid=${sid}`);
				}
			} catch (err) {
				deadCtx(err);
			}
		}
		// Before the snapshot shortcut: time passes even when no board file changes,
		// so a still board would never wake the agent.
		if (!tickInFlight) {
			const f = readModesFile({ repair: false }); // 1.5s cadence: never rewrite here
			// Phase 0: project is the default board, so it is polled too. `key` is the board
			// slug; `sid` stays the actor - movedBy and haltedBySid must keep naming the
			// session or todo-ownership breaks.
			// #17: two boards, ever. The settle only ever writes this cwd's slug, so a card of
			// ours cannot sit on another repo's board: reading every project board here was
			// cost with no verdict behind it.
			// #26: this cwd's project board is the only board that can drive. global is an aggregate
			// view with no cards of its own, so polling it read an always-empty file.
			const boards: { scope: Scope; key: string }[] = [
				// cwdOfCtx, not process.cwd(): refresh/settle use the ctx cwd, and a key mismatch here
				// would poll a board nobody draws or settles.
				{ scope: "project", key: boardKeyFor(ownCtx, sid, "project") },
			];
			for (const { scope, key } of boards) {
				// Read the switch first: with doingLoop off this costs one
				// modes.json read per poll and no board reads at all.
				const m = modesFor(f, key, scope);
				const cards = m.doingLoop ? readBoard(boardPath(scope, key)).cards : [];
				// Phase 10: DOING empty + autoPick ON wakes on the first TODO instead of
				// staying silent forever. The wake only asks for the move; the board is never
				// written here (pickFirstTodo runs in the settle that follows this turn).
				// The ownership filter always takes the ACTOR (sid), never the board key.
				const card = m.doingLoop
					? (tickCardFor(cards, sid) ?? (m.autoPick ? nextTodo(cards, scope, sid) : undefined))
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
				// #94: ダッシュボードの「+」が残した合図。前回発火より新しく、まだ 5 分以内
				// のものだけが「今の追加」= 古い合図はゴミなので拾わない（lastTickAt も同条件）。
				const forcedAt = userPickAt.get(key) ?? 0;
				const forced = forcedAt > lastTickAt && now - forcedAt < AUTO_TICK_MS;
				// #94: 期限切れの合図は読んだ場所で捨てる（二度と発火しない板の Map を残さない）。
				if (!forced && forcedAt !== 0) userPickAt.delete(key);
				const v = autoTickVerdict({
					isIdle: isIdle === true,
					doingLoop: m.doingLoop,
					card,
					halted: loop.halted,
					lastTickAt,
					lastChainAt,
					// undefined (never active) stays undefined: 0 would read as "long ago".
					lastActivityAt: loop.lastActivityAt || undefined,
					now,
					intervalMs: intervalMsOf(m),
					menuOpen: menuOpen(),
					forced,
				});
				if (pollDebugEnabled()) {
					const why = v.fire ? (v.reason === "forced" ? "fire:forced" : "fire") : `skip:${v.reason}`;
					process.stderr.write(
						`kanban: poll sid=${sid} idle=${isIdle ?? "n/a"} doingLoop=${m.doingLoop} card=${card?.id ?? "null"} halted=${loop.halted ?? "null"} sinceLastTick=${now - lastTickAt} quiet=${v.quiet} => ${why}\n`,
					);
				}
				if (!v.fire) continue;
				if (card === undefined) continue; // v.fire implies a card; this only narrows for TS
				// #94: 合図は 1 回きり。lastTickAt の更新で自然に古くなるが、掃除は明示的に。
				userPickAt.delete(key);
				// Set and cleared inside one synchronous block, so this is effectively dead today:
				// sendUserMessage does not re-enter poll(). It guards the day it starts to, and the
				// `/kanban take` handler reads it to refuse a switch mid-wake.
				tickInFlight = true;
				lastTickAt = now;
				try {
					// #51-①: firedFor is stamped only once the wake actually LEFT. Stamping it next to
					// the dispatch marked a rejected wake ("Agent is already processing...") as delivered,
					// and that schedule could never fire again. lastTickAt above stays here on purpose:
					// it is the poll's pacing clock, not a delivery receipt, so a rejection still costs
					// exactly one interval instead of re-dispatching inside the same one.
					// The catch is not `void`: a rejected wake is logged, never swallowed.
					Promise.resolve(pi.sendUserMessage(injectPrompt(card, scope, stuckLimitOf(m))) as unknown)
						.then(() => {
							// A failed writeBoard here only buys one extra wake - loud beats a hole.
							if (!folding) markFired(card, key, scope);
						})
						.catch((err: unknown) => logServer(`wake rejected: ${err instanceof Error ? err.message : String(err)}`));
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
		const snap = diskSnapshot();
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
		// #90: the main use is "add a card"; the drilldown menu is only what a bare /kanban opens.
		description:
			"Add a card to this project's TODO, or run a subcommand: url / loop / pick / take / interval / stuck / maxloops / priority / img / help",
		handler: async (args, ctx) => {
		const sid = sidOf(ctx);
		// #17: project boards are keyed by their cwd slug; the pi session id stays the actor.
		// #27: same source as poll/refresh/settle (cwdOfCtx). Reading the HTTP cache's cwd here
		// made /kanban take write the repo this process STARTED in while the loop drove the
		// resumed session's repo: taken, and never woken.
		const projKey = boardKeyFor(ctx, sid, "project");
			const parsed = parseKanbanArgs((args ?? "").trim().split(/\s+/).filter((w) => w.length > 0));
			if (parsed.kind === "help") {
				ctx.ui.notify(KANBAN_HELP);
				return;
			}
			if (parsed.kind === "reject") {
				ctx.ui.notify(parsed.reason);
				return;
			}
			if (parsed.kind === "url") {
				ctx.ui.notify(`ダッシュボード: ${boardUrl()}`);
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
				// #93: take is a pin, so it publishes the cwd like sync() does - otherwise every
				// ctx-less request kept reading the previous repo's board after a handover.
				pinDriver(ctx, sid);
				lastTickAt = 0; // judge immediately in the new session, not after the interval
				pollSnapshot = null; // force the next poll to redraw
				warnedDeadCtx = false;
				deadCtxStrikes = 0;
				// loop is process state, not per-session: only clear the stop condition and the
				// activity clock, so the previous owner's quiet window cannot block the new one.
				loop.halted = null;
				loop.lastActivityAt = 0;
				// #89: adopting a ctx without arming the timer left the handover inert (8s -> 0 wakes).
				ensurePollTimer();
				// #17: boards are project/global only, so a DOING card stamped by a dead session would
				// never match any actor again; take is the explicit handover. movedAt is deliberately
				// not stamped: taking ownership is not progress.
				// global is an aggregate; there is no writable global row to hand over, and
				// resetScopesOnce removes the legacy one - so only this cwd's project board is read.
				let claimed = 0;
				for (const path of [boardPath("project", projKey)]) {
					const b = readBoard(path);
					const stolen = cardsIn(b, "doing").filter((c) => c.movedBy !== sid);
					if (stolen.length === 0) continue;
					for (const card of stolen) card.movedBy = sid;
					claimed += stolen.length;
					writeBoard(path, b);
				}
				ctx.ui.notify(
					`kanban: 駆動元を ${prev ?? "なし"} → ${sid} に切り替えた` +
						(claimed > 0 ? `（DOING ${claimed} 枚の所有権も引き継いだ）` : ""),
				);
				return;
			}
			if (parsed.kind === "mode" || parsed.kind === "modeStatus") {
				runModeCommand(ctx, sid, parsed.scope ?? "project", parsed.key, parsed.kind === "mode" ? (parsed.value ? "on" : "off") : "status");
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
				// Priority is a card's business: the id belongs to this conversation's project board.
				runPriorityCommand(ctx, projKey, "project", parsed.id, parsed.value);
				return;
			}
			if (parsed.kind === "img") {
				// Same rule as priority: card ids only exist on this conversation's board.
				runImgCommand(ctx, sid, parsed.id, parsed.path);
				return;
			}
			if (parsed.kind === "add") {
				// #17: the card belongs to this conversation, and the project board is the one
				// this cwd shares - there is no session board left to add it to.
				const path = boardPath("project", projKey);
				const b = readBoard(path);
				const card: Card = { id: b.nextId++, text: parsed.text, col: "todo" };
				stampMove(card, sid);
				b.cards.push(card);
				writeBoard(path, b);
				ctx.ui.notify(`TODO に追加: ${formatCard(card)}`);
				refresh(ctx, sid);
				return;
			}
			let scope: Scope = "project";
			refresh(ctx, sid);
			const guiOption = "🖥 ダッシュボードの URL";
			// #16: the drilldown may LOOK at the global aggregate, but global owns no board - every
			// write here targets the selected scope's own board. Refuse the writing branches only.
			const globalReadOnly = (): boolean => {
				if (scope !== "global") return false;
				ctx.ui.notify("GLOBAL は読み取り専用");
				return true;
			};
			// #16: global is a read-only projection of every project board; GLOBAL_JSON is always empty.
			const drillBoard = (): Board =>
				scope === "global"
					? aggregateGlobal()
					: readBoard(boardPath(scope, projKey));
			// Every dialog of this drilldown runs under the guard, so auto-tick stays off
			// while the user is reading a menu (A3). withMenuGuard clears it in `finally`.
			return withMenuGuard(uiGuard, async () => {
			for (;;) {
				const current = drillBoard();
				const colOptions = COLS.map((c) => `${COL_LABELS[c].trim()} (${cardsIn(current, c).length})`);
				// #16: global owns no cards - say so on the row instead of offering a dead click.
				const colRows = scope === "global" ? colOptions.map((o) => `${o}（読取専用）`) : colOptions;
				const switchOption = scope === "project" ? "🌐 グローバル看板へ" : "📂 プロジェクト看板へ";
				// One row in the BOARD menu; the two toggles live one level down so the
				// column list below keeps its shape. sid is always this session, scope is
				// the board the user is looking at.
				// #27: the writer (runModeCommand) stores under boardKeyFor, so reading `sid` here
				// hit no key at all and fell back to "absent = ON": a loop switched OFF still drew ON.
				// And `scope` flips to global below, where the key is the sid - boardKeyFor answers both.
				const cur = modesFor(readModesFile(), boardKeyFor(ctx, sid, scope), scope);
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
					...colRows,
					"終了",
				]);
				if (picked === undefined || picked === "終了") return;
				if (picked === guiOption) {
					ctx.ui.notify(`ダッシュボード: ${boardUrl()}`);
					continue;
				}
				if (picked === switchOption) {
					scope = scope === "project" ? "global" : "project";
					continue;
				}
				if (picked === modeOption) {
					for (;;) {
						const m = modesFor(readModesFile(), boardKeyFor(ctx, sid, scope), scope); // #27: the writer's key
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
					if (globalReadOnly()) continue;
					// One row per TODO card, same one-line style as formatPriorityCard.
					const todos = orderTodos(cardsIn(drillBoard(), "todo"));
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
					if (raw !== undefined) runPriorityCommand(ctx, projKey, scope, chosen.id, raw.trim() === "" ? 0 : Number(raw));
					continue;
				}
				const col = COLS[colRows.indexOf(picked)];
				if (col === undefined) return;

				for (;;) {
					// #16: one guard for the whole column - global has no card of its own to write, so
					// both the add branch and the move/delete branches are already out of reach.
					if (globalReadOnly()) break;
					// Re-read every iteration so GUI edits show up mid-drilldown.
					const b = drillBoard();
					const inCol = cardsIn(b, col);
					const choice = await ctx.ui.select(`${COL_LABELS[col].trim()} (${inCol.length})`, [
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
							writeBoard(boardPath(scope, projKey), b);
						}
						refresh(ctx, sid);
						continue;
					}

					const card = inCol.find((c) => formatCard(c) === choice);
					if (card === undefined) continue;

					// #18: drop the card's current column from the menu. Moving a card to where it
					// already is used to stamp movedAt and silently reset the staleness clock.
					const op = await ctx.ui.select(`#${card.id} ${card.text}`, [
						...MOVE_LABELS.filter((_, i) => COLS[i] !== col),
						"削除",
						"← 列選択に戻る",
					]);
					if (op === undefined) return;
					if (op === "← 列選択に戻る") continue;
					if (op === "削除") {
						removeMedia(card); // the `kanban` tool already drops the image; keep the paths symmetric
						b.cards = b.cards.filter((c) => c.id !== card.id);
					} else {
						moveCardTo(card, COLS[MOVE_LABELS.indexOf(op)], sid);
					}
					writeBoard(boardPath(scope, projKey), b);
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
		// #90: four blocks, in the order a first-time reader needs them - what it is, what each
		// action does, what it is NOT (deliverables), and which board you are touching. The
		// normalization rules moved to the per-parameter descriptions and KANBAN_HELP.
		// #96: one fact per clause, <=900 chars. Attachment details live on `image`.
		description:
			"Shared kanban board for this project: columns todo / doing / done, persisted in ~/.pi/kanban, shown in the GUI. Holds what you owe — one card per promise; done only when it actually works.\n" +
			"Actions: list reads; add creates; move sets col; edit rewrites text/project/session/commit/labels (column, owner stay); remove deletes; check self-tests board/media/modes; resume clears a doing-loop halt (GUI cannot); url returns the token link; img copies into media/; ref keeps file:<path>; /api/ref serves it under the serve roots only.\n" +
			"A deliverable is not a card: it is a deliv row (deliverable tool) in the belt under the board. No column is called deliverable. Priority/loop switches are /kanban subcommands, not tool actions.\n" +
			"scope picks the board: project (default — this repo, shared by every session in it) or global (read-only aggregate). Ids are per board. There is no per-session board (#17).",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("list"),
				Type.Literal("add"),
				Type.Literal("move"),
				Type.Literal("remove"),
				Type.Literal("check"),
				// #83b: the agent creates cards in-process (writeBoard), so it never needs the
				// HTTP token - the `kanban` tool is not an HTTP client.
				Type.Literal("resume"),
				Type.Literal("url"),
				// edit rewrites a card's text only. Same rules as /api/rename: no stampMove,
				// movedAt/movedBy stay (a rename does not transfer ownership), empty text is an error.
				Type.Literal("edit"),
				// The tool had no way to attach an image; /kanban img was the only door.
				// Same validation and same media/ layout through attachToCard.
				Type.Literal("img"),
				// #56: attach by reference - the path is stored on the card, not copied.
				Type.Literal("ref"),
			], { description: "What to do. See the tool description for each action; add/move/edit/remove act on the selected scope's own board. img/ref attach to a CARD; for output the user should see, call the deliverable tool." }),
			// #17/#90: two boards, not three. There is no per-session board (the HTTP routes answer
			// scope=session with 400 SESSION_SCOPE_GONE), so the schema must not offer one either.
			scope: Type.Optional(
				Type.Union([Type.Literal("global"), Type.Literal("project")], {
					description: "Which board: project (default, this repo), global (read-only aggregate).",
				}),
			),
			text: Type.Optional(Type.String({ description: "Card body. Required by add; edit replaces it (empty is an error)." })),
			id: Type.Optional(Type.Number({ description: "Card id inside the selected board (ids are per board — see list). Not a deliverable id: the deliverable tool has its own space." })),
			col: Type.Optional(
				Type.Union([Type.Literal("todo"), Type.Literal("doing"), Type.Literal("done")], {
					description: "Target column: todo | doing | done.",
				}),
			),
			// Same fields as the card editor: the agent must be able to arm a card too.
			// nextFireAt takes ISO 8601 or +90m/+3h/+1d; it is resolved to absolute
			// before saving. "" clears either field.
			nextFireAt: Type.Optional(Type.String({ description: "ISO 8601 or +90m/+3h/+1d; resolved to absolute before saving. \"\" clears it." })),
			blocked: Type.Optional(Type.String({ description: "Free-text reason the card is blocked. \"\" clears it." })),
			// A slug, normalized on write ([A-Za-z0-9._-], case kept, max 24 chars). "" clears it.
			project: Type.Optional(
				Type.String({ description: "Optional project slug ([A-Za-z0-9._-], max 24 chars, case kept). \"\" clears it. Never affects the loop." }),
			),
			// #20: conversation tags. "" clears either one; commit must be 7-40 hex.
			session: Type.Optional(Type.String({ description: "Conversation tag on a card ([A-Za-z0-9._:@-]). \"\" clears it." })),
			commit: Type.Optional(Type.String({ description: "Commit sha, 7-40 hex, stored lowercase. \"\" clears it." })),
			// #22: comma-separated. Allowed: bug, feature, chore, 調査. "" clears.
			labels: Type.Optional(Type.String({ description: "Comma-separated labels. Allowed: bug, feature, chore, 調査. \"\" clears it." })),
			// img: a local image path. Absolute, or ~/ prefixed. Copied, not referenced.
			// ref: a local path (image/video/html/anything). Absolute, or ~/ prefixed. Referenced, not copied.
			image: Type.Optional(
				Type.String({ description: "Local path for img (copied into media/) or ref (stored as file:<path>, not copied; /api/ref serves it back only under the serve roots, ~/workspace by default). Absolute or ~/ prefixed. On the card: images and video show as thumbnails, .html opens in a sandboxed iframe (a three.js page works, it loads its CDN modules itself), md/pdf/txt preview as text or pdf." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// Phase 0: the HTTP gate cannot see an in-process write, so the tool waits for the
			// fold itself - a card added in that window was overwritten by its final write.
			if (migrationPending !== null) await migrationPending;
			const scope: Scope = params.scope ?? "project";
			// A project board's key is the cwd slug, NOT the session (D4). The actor stays the
			// session, so movedBy/modes/loop reads keep naming this conversation.
			const sessionSid = sidOf(ctx);
			const sid = scope === "project" ? projectSlugOf(cwdOfCtx(ctx)) : sessionSid;
			const path = boardPath(scope, sid);
			// #16: global is a read-only aggregate everywhere else (HTTP, dashboard), so the tool
			// must read the same set - GLOBAL_JSON alone is empty after the migration.
			const b: Board = scope === "global" ? aggregateGlobal() : readBoard(path);
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
			// Phase 0 D5: global is a read-only aggregate. The HTTP routes already 400 it
			// (writeBoardPath); without this the in-process tool is the one back door.
			if (scope === "global" && (["add", "move", "remove", "edit", "img", "ref"] as readonly string[]).includes(params.action)) {
				return fail("global board is read-only");
			}

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
					// Validate before touching nextId: a failed add must not consume and report an unsaved id.
					const project = normalizeProject(params.project);
					if (project === "" && (params.project ?? "") !== "") return fail("project must match [A-Za-z0-9._-]");
					const sessionId = normalizeSessionId(params.session);
					if (sessionId === "" && (params.session ?? "") !== "") return fail("session must match [A-Za-z0-9._:@-]");
					const commit = normalizeCommit(params.commit);
					if (commit === "" && (params.commit ?? "") !== "") return fail("commit must be 7-40 hex characters");
					const labels = parseLabels(params.labels ?? null);
					if (labels === null) return fail(`labels must be a comma-separated list of: ${LABELS.join(", ")}`);
					const card: Card = { id: b.nextId++, text, col };
					stampMove(card, sessionSid);
					const gateError = applyGate(card);
					if (gateError !== null) return fail(gateError);
					if (project !== "") card.project = project;
					if (sessionId !== "") card.sessionId = sessionId;
					if (commit !== "") card.commit = commit;
					if (labels.length > 0) card.labels = labels;
					b.cards.push(card);
					persistError = writeBoard(path, b);
					message = `added ${formatCard(card)} to ${card.col} (${scope})${gateNote(card)}`;
					break;
				}
				case "move": {
					const card = params.id === undefined ? undefined : b.cards.find((c) => c.id === params.id);
					if (card === undefined) return fail(`no card with id ${params.id} in the ${scope} board`);
					if (params.col === undefined) return fail("move requires col");
					const changed = moveCardTo(card, params.col, sessionSid);
					const gateError = applyGate(card);
					if (gateError !== null) return fail(gateError);
					persistError = writeBoard(path, b);
					// #18: do not report "moved" for a no-op. The board already had it there.
					message = changed
						? `moved #${card.id} to ${card.col} (${scope})${gateNote(card)}`
						: `#${card.id} is already in ${card.col} (${scope})${gateNote(card)}`;
					break;
				}
				case "edit": {
					if (params.id === undefined) return fail("edit requires id");
					const text = (params.text ?? "").trim();
					// project/session/commit alone is a valid edit (relabeling a card without touching its text).
					if (text.length === 0 && params.project === undefined && params.session === undefined && params.commit === undefined && params.labels === undefined)
						return fail("edit requires text, project, session, commit or labels");
					const proj = params.project === undefined ? undefined : normalizeProject(params.project);
					// Validate before mutating: a failed edit must not report text that was never saved.
					if (proj === "" && params.project !== undefined && params.project !== "") return fail("project must match [A-Za-z0-9._-]");
					const sess = params.session === undefined ? undefined : normalizeSessionId(params.session);
					if (sess === "" && params.session !== undefined && params.session !== "") return fail("session must match [A-Za-z0-9._:@-]");
					const sha = params.commit === undefined ? undefined : normalizeCommit(params.commit);
					if (sha === "" && params.commit !== undefined && params.commit !== "") return fail("commit must be 7-40 hex characters");
					// #22: undefined = leave labels alone, "" = clear them. A blank-but-not-empty
					// value (" ") is a typo, not a clear - #20 shipped that bug for ?commit=%20%20.
					const labs = params.labels === undefined ? undefined : parseLabels(params.labels);
					if (labs === null) return fail(`labels must be a comma-separated list of: ${LABELS.join(", ")}`);
					const card = b.cards.find((c) => c.id === params.id);
					if (card === undefined) return fail(`no card with id ${params.id} in the ${scope} board`);
					if (text.length > 0) card.text = text;
					if (proj !== undefined) {
						if (proj === "") delete card.project;
						else card.project = proj;
					}
					if (sess !== undefined) {
						if (sess === "") delete card.sessionId;
						else card.sessionId = sess;
					}
					if (sha !== undefined) {
						if (sha === "") delete card.commit;
						else card.commit = sha;
					}
					if (labs !== undefined) {
						if (labs.length === 0) delete card.labels;
						else card.labels = labs;
					}
					persistError = writeBoard(path, b);
					message = `edited #${card.id} (${scope})`;
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
					resumeWithModes(ctx, sessionSid);
					// #26: the cap in force is the project board's - global has no switch and no budget.
					const capNow = maxLoopsOf(modesFor(readModesFile(), boardKeyFor(ctx, sessionSid, "project"), "project"));
					message = `resumed: ${was} / count ${oldCount} → 0 / doingLoop ON (project) / ${loopBudgetText(capNow, 0)}`;
					break;
				}
				case "img": {
					const id = params.id;
					if (id === undefined || !Number.isInteger(id) || id < 1) return fail("img requires id (an integer 1 or more)");
					const input = (params.image ?? "").trim();
					if (input === "") return fail("img requires image (a local file path)");
					// attachToCard validates everything before removeMedia, so a bad path writes nothing.
					const r = attachToCard(b, id, input);
					if (!r.ok) return fail(r.error);
					persistError = writeBoard(path, b);
					message = `attached ${r.name} to #${r.card.id}`;
					break;
				}
				case "ref": {
					const id = params.id;
					if (id === undefined || !Number.isInteger(id) || id < 1) return fail("ref requires id (an integer 1 or more)");
					const input = (params.image ?? "").trim();
					if (input === "") return fail("ref requires image (an absolute file path)");
					// refToCard validates before the write, so a refused path leaves the card alone.
					const r = refToCard(b, id, input);
					if (!r.ok) return fail(r.error);
					persistError = writeBoard(path, b);
					message = `referenced ${r.abs} on #${r.card.id}`;
					break;
				}
				case "url": {
					// The board is token-gated; hand over the one URL that opens it.
					message = boardUrl();
					break;
				}
				default:
					message = `[${scope}]\n${renderLines(b).join("\n")}`;
			}

			refresh(ctx, sessionSid);
			return done(message);
		},
	});

	// #92: output the user should SEE is its own tool. It used to be a card with an attachment,
	// so a screenshot ended up as a TODO row and the board filled with finished work. `kanban`
	// stays for work, `deliverable` for output: two names, no flag to pick wrong. Registered
	// AFTER the kanban tool on purpose - tests/kanban-tool-schema.test.mjs cuts the FIRST
	// `parameters: Type.Object({` out of this file and checks the kanban twelve.
	pi.registerTool({
		name: "deliverable",
		label: "Deliverables",
		description:
			"Output you want the user to see: a screenshot, a report, a video, a file. Shown in the belt under the board, not in a column - do not create a TODO card for output.\n" +
			"Actions: add posts one (text); list shows them; edit rewrites the text; remove deletes it and its unused media; img copies a local image into media/; ref stores file:<path> without copying (the dashboard reads it back through /api/ref, allowlisted to the serve roots).\n" +
			"A deliverable is a deliv row, not a card: it has no column, no owner and no phase. ids are the deliv space, so #3 here and card #3 are different things.\n" +
			"scope picks the board: project (default, this repo) or global (read-only aggregate; writes are refused, and a global listing shows the id as <slug>/<id> because ids repeat per board).",
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("add"),
					Type.Literal("list"),
					Type.Literal("edit"),
					Type.Literal("remove"),
					Type.Literal("img"),
					Type.Literal("ref"),
				],
				{ description: "What to do: add posts one, list shows them, edit rewrites the text, remove deletes it and its unused media, img copies a local image, ref points at one in place." },
			),
			scope: Type.Optional(
				Type.Union([Type.Literal("global"), Type.Literal("project")], {
					description: "Which board: project (default, this repo), global (read-only aggregate; add/edit/remove/img/ref are refused). There is no per-session board.",
				}),
			),
			id: Type.Optional(
				Type.Number({ description: "Deliverable id (deliv space - not a card id; the same number can exist as a card). Required by edit/remove/img/ref." }),
			),
			text: Type.Optional(Type.String({ description: "What the deliverable is. Required by add; edit replaces it (empty is an error)." })),
			image: Type.Optional(
				Type.String({ description: "Local path for img (copied into media/) or ref (stored as file:<path>, not copied; /api/ref serves it back only under the serve roots, ~/workspace by default). Absolute or ~/ prefixed." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// Phase 0: same wait as the kanban tool - the fold's final write would eat ours.
			if (migrationPending !== null) await migrationPending;
			const scope: Scope = params.scope ?? "project";
			const sessionSid = sidOf(ctx);
			const sid = scope === "project" ? projectSlugOf(cwdOfCtx(ctx)) : sessionSid;
			const path = boardPath(scope, sid);
			// #16/#92: global reads the aggregate (GLOBAL_JSON is empty after the migration).
			const b: Board = scope === "global" ? aggregateGlobal() : readBoard(path);
			let persistError: string | null = null;
			const done = (text: string) => ({
				content: [{ type: "text" as const, text }],
				details: {
					scope,
					deliverables: [...b.deliverables],
					...(persistError === null ? {} : { persistError }),
				},
			});
			const fail = (text: string) => ({ ...done(text), isError: true });
			// Same back door as the kanban tool: an in-process write is invisible to the HTTP gate.
			if (scope === "global" && params.action !== "list") return fail("global board is read-only");

			let message: string;
			switch (params.action) {
				case "add": {
					const text = (params.text ?? "").trim();
					if (text.length === 0) return fail("add requires a non-empty text");
					// `at` is part of the row (the band sorts on it). The id is the board's own deliv
					// sequence; db.ts raises deliv_next_id to max(id)+1 inside its lock anyway.
					const deliverable: Deliv = { id: b.delivNextId, text, at: Date.now() };
					b.deliverables.push(deliverable);
					b.delivNextId += 1;
					persistError = writeBoard(path, b);
					message = `added ${text} to deliverable #${deliverable.id} (${scope})`;
					break;
				}
				case "edit": {
					if (params.id === undefined) return fail("edit requires id");
					const text = (params.text ?? "").trim();
					if (text.length === 0) return fail("edit requires a non-empty text");
					const deliverable = b.deliverables.find((d) => d.id === params.id);
					if (deliverable === undefined) return fail(`no deliverable with id ${params.id} in the ${scope} board`);
					deliverable.text = text; // at/img stay: a rewording is not a new row
					persistError = writeBoard(path, b);
					message = `edited deliverable #${deliverable.id} (${scope})`;
					break;
				}
				case "remove": {
					if (params.id === undefined) return fail("remove requires id");
					const i = b.deliverables.findIndex((d) => d.id === params.id);
					if (i < 0) return fail(`no deliverable with id ${params.id} in the ${scope} board`);
					// #92: the same trash rule as /api/deliv/remove. Never removeMedia(): that takes a
					// Card, so passing a Deliv needs `as Card` - which is how the two spaces got mixed.
					trashUnusedMedia(b, "deliv", params.id, mediaNames(b.deliverables[i].img));
					b.deliverables.splice(i, 1);
					persistError = writeBoard(path, b);
					message = `removed deliverable #${params.id} (${scope})`;
					break;
				}
				case "img": {
					const id = params.id;
					if (id === undefined || !Number.isInteger(id) || id < 1) return fail("img requires id (an integer 1 or more)");
					const input = (params.image ?? "").trim();
					if (input === "") return fail("img requires image (a local file path)");
					// attachToDeliv looks the owner up in b.deliverables: a deliv id can never land on
					// the same-numbered card.
					const r = attachToDeliv(b, id, input);
					if (!r.ok) return fail(r.error);
					persistError = writeBoard(path, b);
					message = `attached ${r.name} to deliverable #${r.deliv.id} (${scope})`;
					break;
				}
				case "ref": {
					const id = params.id;
					if (id === undefined || !Number.isInteger(id) || id < 1) return fail("ref requires id (an integer 1 or more)");
					const input = (params.image ?? "").trim();
					if (input === "") return fail("ref requires image (an absolute file path)");
					const r = refToDeliv(b, id, input);
					if (!r.ok) return fail(r.error);
					persistError = writeBoard(path, b);
					message = `referenced ${r.abs} on deliverable #${r.deliv.id} (${scope})`;
					break;
				}
				default: {
					// list. A global row carries `sid` (its project slug) because ids repeat per board.
					const rows = b.deliverables as (Deliv & { sid?: string })[];
					message =
						rows.length === 0
							? `[${scope}] no deliverables`
							: [
									`[${scope}]`,
									...rows.map(
										(d) => `${scope === "global" ? `${d.sid === undefined || d.sid === "" ? "global" : d.sid}/${d.id}` : `#${d.id}`}  ${d.text}`,
									),
								].join("\n");
					break;
				}
			}

			refresh(ctx, sessionSid);
			return done(message);
		},
	});

	// Auto-loop. Off by default (modes.json), and it never blocks input: this
	// handler only decides whether the settled run gets one more request.
	pi.on("agent_before_settle", (event, ctx) => {
		// Phase 0: the settle writes the board (pickFirstTodo, markFired), and the fold's last
		// write would overwrite it. Dropping the continuation is the safe outcome (the next
		// settle resumes the loop), and staying sync keeps every other caller's result a value.
		if (migrationPending !== null) return;
		// #51-④: a /kanban dialog is on screen. Same guard object the poll reads (menuOpen()),
		// so a menu cannot be talked over by one path and not the other.
		if (menuOpen()) return;
		const sid = sidOf(ctx);
		const f = readModesFile();
		// `key` names the board (modes, boardPath); `sid` stays the actor (movedBy, paint,
		// halt state). project is keyed by the cwd slug, never by the session.
		const projectKey = boardKeyFor(ctx, sid, "project");
		const mp = modesFor(f, projectKey, "project");
		// (1) every switch off -> nothing to drive. #26: only the project board has switches.
		if (!mp.doingLoop && !mp.autoPick) return;

		// A stuck halt belongs to the board that was driving it: checking the other
		// board too would clear the halt on its emptiness and restart the loop.
		if (loop.halted === "stuck") {
			// #26: the only driver is this cwd's project board.
			if (!cardsIn(readBoard(boardPath("project", projectKey)), "doing").some((c) => c.id === loop.stuckId)) {
				// #90: the activity clock says "active NOW", not 0. 0 reads as "no activity recorded"
				// (poll passes `|| undefined` and the gate treats undefined as just-active), so quiet
				// only opened at starved = 3 intervals: a 5-minute window became 15 (measured in #88).
				// Stamping now costs one interval and leaves lastTickAt alone, so the starvation guard
				// (lastTickAt alone decides) still fires after 3 intervals no matter what this says.
				loop = { count: 0, halted: null, scope: null, stuckId: null, stuckCount: 0, lastActivityAt: Date.now() };
				persistLoop();
				paintLoop(ctx, sid);
			}
		}
		if (loop.halted !== null) return; // halted until /kanban loop on / off+on

		// A settle whose head message is the user's is the user's run, not the board's: that is
		// exactly the steer noise. contextMessages keeps our own custom_message continuations
		// at role "custom", and a completed turn leaves role "assistant" last, so only a real
		// prompt at the head flips this. #51-③: a message still QUEUED from the user counts too
		// (pi's event.context.pendingMessages) - steering and injection must not share a turn.
		if (isUserInputHead(event.context.contextMessages, event.context.pendingMessages)) return;

		// autoPick: this cwd's PROJECT board. WIP=1: a board that already holds one of THIS
		// session's DOING cards does not pick another. A board whose DOING is empty and whose
		// only work is TODO is still woken (Phase 10: an idle agent must not stall).
		if (mp.autoPick && doingHeadOf(projectKey, "project", sid) === undefined) {
			if (pickFirstTodo(projectKey, "project", sid) !== null) refresh(ctx, sid); // the board moved: redraw now
		}

		// The driving card: this cwd's PROJECT board (#26: the only board that can drive).
		const scope: Scope = "project";
		const card = candidates(projectKey, "project", f, sid);
		if (card === undefined) return; // (2) nothing to drive

		// stuckId is a per-board id: it only means anything together with the scope.
		// The threshold belongs to the board that is driving (`loop.scope`), not to a
		// hard-coded constant: /kanban stuck must actually move where the loop halts.
		const next = nextStuckState(loop, card.id, scope, stuckLimitOf(modesFor(f, projectKey, scope)));
		loop.scope = scope;
		loop.stuckId = next.stuckId;
		loop.stuckCount = next.stuckCount;
		if (next.stuck) {
			loop.halted = "stuck";
			persistLoop();
			paintLoop(ctx, sid);
			return;
		}

		// (3) the cap: turn doingLoop off so the NEXT settle is a real stop.
		// #67: the cap is stored per (scope, sid); 0 means unlimited, so no halt at all.
		// #26: only the project board has a switch to turn off.
		const cap = maxLoopsOf(modesFor(f, projectKey, "project"));
		if (cap > 0 && loop.count >= cap) {
			loop.halted = "limit";
			setMode(f, projectKey, "project", "doingLoop", false);
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
		const prompt = injectPrompt(card, scope, stuckLimitOf(modesFor(f, projectKey, scope)));
		markFired(card, projectKey, scope);
		// #51-②: the chain just spoke, so its clock moves with it. lastTickAt stays untouched
		// on purpose (see the #88 relapse comment above): the poll's pacing must not be reset
		// by our own continuations, only the starvation guard reads both.
		lastChainAt = Date.now();
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
		pollSnapshot = diskSnapshot();
		// ownCtx is the FIRST session that started in this closure, not the newest: one
		// process hosts several sessions (subagents included), and adopting the newest
		// made poll() read that session's board forever - the real session went silent
		// until a message forced agent_before_settle to run on its own ctx.
		// session_tree is a branch move inside the SAME session, so it may refresh it.
		if (ownCtx === null) {
			ownCtx = ctx;
			// #40: the first session to start in this process pins the panel's default
			// sid. Later starts (siblings, subagents) must not move it.
			pinDriver(ctx, sid);
			warnedDeadCtx = false;
			deadCtxStrikes = 0;
		} else if (isTree) {
			try {
				if (sidOf(ownCtx) === sid) ownCtx = ctx;
			} catch {
				// disposed ownCtx: its poll strikes out and releases it for the next start
			}
		}
		// #93: every session_start publishes its OWN sid (cwdBySid), while only the pin above
		// moves the panel's default (driverCwd): a subagent's start must not move the panel.
		if (sid !== "") cwdBySid.set(sid, cwdOfCtx(ctx));
		// Started unconditionally: the HTTP server is shared with a sibling pi, but the loop
		// is this session's, so no listen result may gate it. ownCtx is set by now either way.
		ensurePollTimer();
	};
	pi.on("session_start", (_event, ctx) => sync(ctx, false));
	pi.on("session_tree", (_event, ctx) => sync(ctx, true));

	pi.on("session_shutdown", (_event, ctx) => {
		// #55: the driver pin must not outlive the session that pinned it - but only that
		// session may end it. Read the dying sid off the event's ctx: ownCtx is the live driver,
		// so a subagent's or a sibling's teardown would otherwise release our own pin.
		let dying: string | null = null;
		try {
			dying = sidOf(ctx);
		} catch {
			// disposed ctx cannot answer; that session is gone either way
		}
		// #100: stopPoll() also releases ownCtx and kills the one timer, so only the death of the
		// driver may call it - a subagent's or a sibling's teardown used to stop the live driver's
		// polling and freeze the board until the next session_start / take / resume. An unknown
		// sid (disposed ctx) keeps the old stop: it cannot be proven not to be the driver.
		const driverDied = dying === null || activeSessionId === dying;
		if (dying !== null && activeSessionId === dying) activeSessionId = null;
		if (driverDied) stopPoll();
		// #93: the published cwds outlive the pin on purpose - with no driver, the ctx-less
		// routes keep naming the last board this process drew, which beats an empty one (PID 1
		// cannot restart us). Only the dead sid's own entry is dropped (not the live driver's), so
		// a long-lived process does not grow one map entry per session it ever hosted.
		if (dying !== null) cwdBySid.delete(dying);
	});

	// Per-turn injection: attach this cwd's project board as a request-only trailing message.
	// Deliberately NOT a system-prompt section — mutating the system prompt on every board
	// edit invalidates the provider prefix cache for the entire conversation. The global
	// board is never injected. Empty project board -> nothing appended.
	pi.on("before_agent_start", (_event, ctx) => {
		const txt = renderInjectionText(readBoard(boardPath("project", projectSlugOf(cwdOfCtx(ctx)))));
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
			// #94: the title and the URLs must agree; a test needs both sides.
			serveBaseUrl,
			// #67: the dashboard's 再開 is exercised through the real poll hand-off
			// (/api/resume parks a token, poll consumes it); these let a test assert
			// the parked state instead of sleeping on a timer.
			resumeRequests,
			// #48: the halt hand-off is the same shape (park a token, poll consumes it).
			haltRequests,
			// Phase 0: the fold gate is only reachable while the real migration runs, so the
			// tests drive it directly instead of racing a startup they cannot pause.
			setMigrationPending: (p: Promise<void> | null) => {
				migrationPending = p;
			},
			// #83: the listen/probe path is only reachable through a real port conflict,
			// so the tests drive the two halves directly.
			probe: probeServer,
			decideReuse,
			apiState: () => apiState,
			trashMedia,
			resumeNow: (sid: string) => {
				if (ownCtx === null) throw new Error("no session ctx");
				return resumeWithModes(ownCtx, sid);
			},
		},
	};
}
