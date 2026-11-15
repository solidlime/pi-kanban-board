// ~/.pi/kanban v2 initialization. DESTRUCTIVE to v1 contents — safety-gated on purpose:
//   planInit     → what would be removed/moved/created (no side effects)
//   inspectInit  → what actually exists right now, and how big
//   executeInit  → requires confirmed === true, then backup|delete, recreate, migrate
//   detectState  → classify a home (missing/empty/v1/v2) and NEVER touch it
//   initHomeIfNeeded → boot-time init: a v1/partial home is MOVED to a dated backup, never deleted
//   ensureInitialized → same answer for a caller that must then refuse and ask the user
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync
} from "node:fs";
import { randomBytes } from "node:crypto";
import { KANBAN_DIR_NAME, DB_FILE } from "../shared/constants.js";
import type { Db } from "./db.js";
import { closeDb, openDb } from "./db.js";
import { migrate, schemaVersion, tableExists } from "./migrations.js";

export function kanbanHome(): string { return join(homedir(), ".pi", KANBAN_DIR_NAME); }

/** v1 names that carry board data — presence of any of these means there is something to lose. */
export const V1_DATA = [
  "boards.sqlite", "global.json", "projects", "board.json", "modes.json",
  "inbox-seen.json", "dashboard.html", "media", "serve.json", "serve-allow.json"
] as const;

/** Everything init owns inside the home: v1 leftovers plus the two files v2 also writes. */
export const V1_CONTENTS = [...V1_DATA, "token", "server.log"] as const;

/** Everything init owns inside the home: v1 leftovers plus v2 artifacts. */
export const MANAGED_CONTENTS = [
  ...V1_CONTENTS, DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`, "servers.json"
] as const;

export interface InitPlan {
  home: string;
  targets: string[];
  backupDir: string;
  willCreate: string[];
}

export interface InspectedPath { path: string; name: string; exists: boolean; kind: "file" | "dir" | "other" | "missing"; size: number }

export interface InitInspection {
  home: string;
  homeExists: boolean;
  targets: InspectedPath[];
  existing: InspectedPath[];
  totalBytes: number;
  willCreate: string[];
  backupDir: string;
}

export type InitMode = "backup" | "delete";

export interface InitResult {
  home: string;
  mode: InitMode;
  backupDir: string | null;
  moved: string[];
  removed: string[];
  created: string[];
  schemaVersion: number;
}

export interface ExecuteInitOptions {
  confirmed: boolean;
  mode?: InitMode;
}

const isoStamp = (d: Date): string => d.toISOString().replace(/[:.]/g, "-");

export function planInit(now: Date = new Date(), home: string = kanbanHome()): InitPlan {
  return {
    home,
    targets: MANAGED_CONTENTS.map(n => join(home, n)),
    backupDir: `${home}.v1.bak-${isoStamp(now)}`,
    willCreate: [
      join(home, DB_FILE), join(home, "token"), join(home, "server.log"),
      join(home, "media"), join(home, "media", ".trash")
    ]
  };
}

function sizeOf(p: string): number {
  const st = lstatSync(p);
  if (!st.isDirectory()) return Number(st.size);
  let total = 0;
  for (const entry of readdirSync(p)) {
    try { total += sizeOf(join(p, entry)); } catch { /* vanished mid-scan */ }
  }
  return total;
}

function inspectPath(p: string): InspectedPath {
  const name = basename(p);
  try {
    const st = lstatSync(p);
    return { path: p, name, exists: true, kind: st.isDirectory() ? "dir" : st.isFile() ? "file" : "other", size: sizeOf(p) };
  } catch {
    return { path: p, name, exists: false, kind: "missing", size: 0 };
  }
}

/** Report what init would touch — reads only, no writes. */
export function inspectInit(plan: InitPlan): InitInspection {
  const targets = plan.targets.map(inspectPath);
  const existing = targets.filter(t => t.exists);
  return {
    home: plan.home,
    homeExists: existsSync(plan.home),
    targets,
    existing,
    totalBytes: existing.reduce((n, t) => n + t.size, 0),
    willCreate: plan.willCreate,
    backupDir: plan.backupDir
  };
}

export class InitRefused extends Error {
  readonly home: string; // explicit field: node's strip-only TS loader rejects parameter properties
  constructor(message: string, home: string) { super(message); this.name = "InitRefused"; this.home = home; }
}

/** Refuse homes that are not a kanban dir: a wrong argument here removes the wrong tree. */
function assertInitHome(home: string): void {
  const parent = dirname(home);
  if (parent === home) throw new InitRefused("refusing to init the filesystem root", home);
  if (basename(home) !== KANBAN_DIR_NAME || basename(parent) !== ".pi") {
    throw new InitRefused(`refusing to init ${home}: expected a ".../.pi/${KANBAN_DIR_NAME}" path`, home);
  }
}

function writeToken(home: string): string {
  const file = join(home, "token");
  const token = randomBytes(32).toString("hex");
  writeFileSync(file, token, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* win32 / foreign fs: the file is still private by ACL */ }
  return file;
}

/**
 * Move (backup) or delete the v1/v2 targets, recreate the layout, run migrations.
 * Needs opts.confirmed === true — there is no implicit mode and no dry run here.
 */
export function executeInit(plan: InitPlan, opts: ExecuteInitOptions): InitResult {
  if (!opts || opts.confirmed !== true) throw new Error("init requires explicit confirmation");
  const mode: InitMode = opts.mode ?? "backup";
  if (mode !== "backup" && mode !== "delete") throw new Error(`unknown init mode: ${String(mode)}`);
  assertInitHome(plan.home);

  const moved: string[] = [];
  const removed: string[] = [];
  const created: string[] = [];
  let backupDir: string | null = null;

  if (mode === "backup") {
    if (existsSync(plan.home)) {
      if (existsSync(plan.backupDir)) throw new InitRefused(`backup target already exists: ${plan.backupDir}`, plan.home);
      mkdirSync(dirname(plan.backupDir), { recursive: true });
      // Whole-home move: everything v1 had survives verbatim, and no per-file walk can miss one.
      renameSync(plan.home, plan.backupDir);
      moved.push(plan.home);
      backupDir = plan.backupDir;
    }
  } else {
    for (const t of plan.targets) {
      if (!existsSync(t)) continue;
      rmSync(t, { recursive: true, force: true });
      removed.push(t);
    }
  }

  mkdirSync(plan.home, { recursive: true, mode: 0o700 });
  try { chmodSync(plan.home, 0o700); } catch { /* see writeToken */ }
  created.push(plan.home);

  mkdirSync(join(plan.home, "media", ".trash"), { recursive: true });
  created.push(join(plan.home, "media"), join(plan.home, "media", ".trash"));

  writeFileSync(join(plan.home, "server.log"), "", { flag: "a" });
  created.push(join(plan.home, "server.log"));

  created.push(writeToken(plan.home));

  const db = openDb(join(plan.home, DB_FILE));
  let applied = 0;
  try {
    applied = migrate(db).to;
    created.push(join(plan.home, DB_FILE));
  } finally {
    closeDb(db);
  }

  return { home: plan.home, mode, backupDir, moved, removed, created, schemaVersion: applied };
}

export type HomeStatus = "missing" | "empty" | "v1" | "v2";

export interface HomeState {
  home: string;
  status: HomeStatus;
  /** true only when state.sqlite exists, has kv_meta, and is at the latest schema. */
  initialized: boolean;
  schemaVersion: number | null;
  v1Paths: string[];
}

/** Classify a home. Read-only by contract — this never creates, moves or deletes. */
export function detectState(home: string = kanbanHome()): HomeState {
  const dbPath = join(home, DB_FILE);
  const v1Paths = V1_DATA.map(n => join(home, n)).filter(p => existsSync(p));

  if (!existsSync(home)) return { home, status: "missing", initialized: false, schemaVersion: null, v1Paths };

  if (existsSync(dbPath)) {
    let db: Db | null = null;
    try {
      db = openDb(dbPath, { wal: false });
      if (tableExists(db, "kv_meta")) {
        const v = schemaVersion(db);
        if (v >= 1) return { home, status: "v2", initialized: true, schemaVersion: v, v1Paths };
      }
    } catch {
      // unreadable/corrupt db: treated as not v2 below
    } finally {
      if (db) closeDb(db);
    }
  }

  if (v1Paths.length > 0 || existsSync(dbPath)) {
    return { home, status: "v1", initialized: false, schemaVersion: null, v1Paths };
  }

  // Nothing worth keeping: token/server.log and stray files are not board data, and init moves
  // the whole home into the backup anyway. Calling this "v1" made a fresh machine demand a
  // human confirmation it had no reason to.
  return { home, status: "empty", initialized: false, schemaVersion: null, v1Paths };
}

export interface EnsureResult {
  initialized: boolean;
  state: HomeState;
  /** Present when initialized === false: show these paths, ask the user, then executeInit. */
  plan?: InitPlan;
  reason?: string;
}

/**
 * The opt-out path (startServer({ init: false }), tests): never auto-destroys. A caller that gets
 * initialized:false must stop, show state/plan to the user, and only then call executeInit.
 */
export function ensureInitialized(home: string = kanbanHome(), now: Date = new Date()): EnsureResult {
  const state = detectState(home);
  if (state.initialized) return { initialized: true, state };
  const plan = planInit(now, home);
  const reason = state.status === "missing" ? "kanban home does not exist"
    : state.status === "empty" ? "kanban home has no state.sqlite"
      : "kanban home holds a v1 (or partial) layout";
  return { initialized: false, state, plan, reason };
}

/**
 * Boot-time init. A home that is missing, empty or still holds a v1/partial layout is brought to
 * v2 without asking: the whole old home is MOVED to `<home>.v1.bak-<stamp>` first, so nothing is
 * destroyed and the previous board is one `cp` away. Returns null when the home was already v2.
 */
export function initHomeIfNeeded(home: string = kanbanHome(), now: Date = new Date()): InitResult | null {
  if (detectState(home).initialized) return null;
  return executeInit(planInit(now, home), { confirmed: true, mode: "backup" });
}


/** Open+migrate an already initialized home. Throws instead of initializing. */
export function openHomeDatabase(home: string = kanbanHome()): { db: Db; home: string; schemaVersion: number } {
  const state = detectState(home);
  if (!state.initialized) throw new Error(`kanban home is not initialized (${state.status}): ${home} — run init with confirmation`);
  const db = openDb(join(home, DB_FILE));
  const { to } = migrate(db);
  return { db, home, schemaVersion: to };
}

/** 64 hex chars at 0600, or the existing one. Read-only when the file is usable. */
export function readToken(home: string = kanbanHome()): string | null {
  const file = join(home, "token");
  if (!existsSync(file)) return null;
  try {
    const raw = lstatSync(file);
    if (!raw.isFile() || raw.size === 0) return null;
    const token = readFileSync(file, "utf8").trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}
