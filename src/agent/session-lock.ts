// One writer per pi session JSONL. pi appends to a session file blindly, so two processes on
// one session (pi-web's own agent loop, the supervisor, a manual wake) corrupt it. The
// authority is pi-web, which spawns sessions through its own queue and never takes this lock;
// the lock file and a recent mtime are the fallback for a board that runs without pi-web.
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** The board's own kanban home keeps the locks next to the DB. */
function lockPathOf(sessionId: string): string {
  return path.join(homedir(), ".pi", "kanban", "locks", `${sessionId}.lock`);
}

/**
 * pi-web appends a record per turn, so a JSONL written inside this window has a writer we
 * cannot see as a pid (pi itself, a pi-web session). A session idle for longer is let through —
 * that is the only false negative, and pi-web's answer covers the normal case.
 */
const EXTERNAL_WRITE_WINDOW_MS = 120_000;

const PIWEB_DEFAULT_URL = "http://127.0.0.1:8787";
const PIWEB_TIMEOUT_MS = 1000;

/** The pi-web this board talks to: an explicit url, else KANBAN_PIWEB_URL, else the local port. */
export function piWebUrl(url?: string): string {
  return (url ?? process.env.KANBAN_PIWEB_URL ?? PIWEB_DEFAULT_URL).replace(/\/+$/, "");
}

export interface SessionLock { release: () => void }

export interface SessionLockOptions {
  /** Test seam: a unit test must not depend on a running pi-web. */
  fetch?: typeof globalThis.fetch;
  /** Defaults to KANBAN_PIWEB_URL, then the local pi-web port. */
  url?: string;
  /** Test seam for the mtime window; defaults to now. */
  now?: number;
}

/**
 * The sessions pi-web is running right now. null when pi-web could not answer (not running,
 * a timeout, anything but a 200 with the expected list) — then the local gates decide.
 */
async function runningInPiWeb(sessionId: string, opts: SessionLockOptions): Promise<boolean | null> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  try {
    const res = await doFetch(`${piWebUrl(opts.url)}/api/agent/running`, { signal: AbortSignal.timeout(PIWEB_TIMEOUT_MS) });
    if (!res.ok) return null;
    const body = await res.json() as { runningSessionIds?: unknown };
    return Array.isArray(body.runningSessionIds) ? body.runningSessionIds.includes(sessionId) : null;
  } catch {
    return null;
  }
}

function touchedRecently(sessionId: string, sessionDir: string, now: number): boolean {
  try {
    return statSync(path.join(sessionDir, `${sessionId}.jsonl`)).mtimeMs > now - EXTERNAL_WRITE_WINDOW_MS;
  } catch {
    return false; // no JSONL yet: a session nobody has written to
  }
}

function ownerPid(lockPath: string): number | null {
  try {
    const pid = Number(readFileSync(lockPath, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** EPERM is a live process we may not signal: still an owner. */
function isAlive(pid: number | null): boolean {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** "wx" is the atomic part: exactly one caller can create the file. */
function claim(lockPath: string): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch {
    return false;
  }
  try {
    writeSync(fd, String(process.pid));
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * null means "somebody is already on this session" — the caller must not start a process.
 */
export async function acquireSessionLock(
  sessionId: string, sessionDir: string, opts: SessionLockOptions = {},
): Promise<SessionLock | null> {
  const running = await runningInPiWeb(sessionId, opts);
  if (running === true) return null;
  // pi-web answering "not running" is no proof nobody is: the list covers the sessions pi-web
  // started, not a `pi` a user runs elsewhere. A JSONL touched seconds ago has a writer.
  if (touchedRecently(sessionId, sessionDir, opts.now ?? Date.now())) return null;

  const lockPath = lockPathOf(sessionId);
  mkdirSync(path.dirname(lockPath), { recursive: true });
  if (!claim(lockPath)) {
    if (isAlive(ownerPid(lockPath))) return null;
    // The owner is gone (a spawn that died, a reboot): the lock is debris, take it.
    try { unlinkSync(lockPath); } catch { return null; }
    if (!claim(lockPath)) return null;
  }
  return {
    /** Only our own lock: never delete the file a later owner wrote. */
    release: (): void => {
      if (ownerPid(lockPath) !== process.pid) return;
      try { unlinkSync(lockPath); } catch { /* already gone */ }
    },
  };
}
