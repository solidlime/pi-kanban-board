// Waking a card: a DOING card gets its own headless `pi -p` session. The session is named
// after the card, told to move it to DONE itself with the kanban tool, and its cwd is the
// board's settings.cwd so pi-web lists it under the workspace it is working in.
import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Db } from "../persistence/db.js";
import type { Card, Project } from "../shared/dto.js";
import type { ProjectId } from "../shared/ids.js";
import { updateCard } from "../persistence/repos.js";
import { parseAcceptance } from "../core/acceptance.js";
import { sessionDirName } from "../core/sessions.js";
import { acquireSessionLock, piWebUrl } from "./session-lock.js";

export type SpawnFn = typeof nodeSpawn;

/** The directory the session runs in: the board's `settings.cwd` when set, else ours. */
export function sessionCwd(project: Project): string {
  const cwd = project.settings?.cwd;
  return typeof cwd === "string" && cwd.trim() !== "" ? cwd : process.cwd();
}

/** Kept short on purpose: the card is the spec, the tool call is the exit condition. */
export function buildCardPrompt(project: Project, card: Card): string {
  const acceptance = parseAcceptance(card.body);
  const criteria = acceptance.length === 0
    ? "- （なし）"
    : acceptance.map(a => `- [${a.done ? "x" : " "}] ${a.text}`).join("\n");
  return [
    `カードを実装してください。`,
    ``,
    `project: ${project.slug}`,
    `card id: ${card.id}`,
    `title: ${card.title}`,
    `body: ${card.body?.trim() || "（なし）"}`,
    `受け入れ条件:`,
    criteria,
    ``,
    `完了したら kanban ツールでこのカードを done 列へ移してください（project: "${project.slug}", id: ${card.id}）。`,
    `中断するなら kanban ツールで blockedReason を書いて doing に残してください。`,
    `cwd の外のファイルは触らないこと。`,
  ].join("\n");
}

/** One live child per board: a second DOING card on the same board waits for the first. */
const running = new Map<ProjectId, ChildProcess>();
/** A wake already in flight. `/api/agent/new` mints the id on the pi-web side, so two
 *  concurrent calls would create two sessions the card can never reconcile. */
const waking = new Set<ProjectId>();

export interface WakeOptions {
  spawn?: SpawnFn;
  bin?: string;
  /** Test seam: a unit test must not POST to a live pi-web. */
  fetch?: typeof globalThis.fetch;
  /** Test seam for the pi-web base URL; defaults to KANBAN_PIWEB_URL. */
  piwebUrl?: string;
}

export interface WakeResult {
  /** null only when pi-web started a new session but did not report its id. */
  sessionId: string | null;
  pid: number | undefined;
  /** Which runner took the card: pi-web's own queue, or a `pi -p` we spawned ourselves. */
  via: "pi-web" | "pi";
}

/** Where pi keeps the JSONL of this board's sessions (the folder the picker reads). */
export function sessionDirOf(project: Project): string {
  return join(homedir(), ".pi", "agent", "sessions", sessionDirName(sessionCwd(project)));
}

const PIWEB_WAKE_TIMEOUT_MS = 30000;

/**
 * pi-web takes the session: a new card goes to `/api/agent/new` (pi-web mints the id and
 * answers with it), an existing one to `/api/agent/<id>`, which resumes the JSONL when the
 * session is not live. null = pi-web did not take it; the caller spawns pi itself.
 */
async function wakeInPiWeb(project: Project, sessionId: string | null, prompt: string, opts: WakeOptions): Promise<{ sessionId: string | null } | "unclear" | null> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const base = piWebUrl(opts.piwebUrl);
  try {
    const res = await doFetch(sessionId === null ? `${base}/api/agent/new` : `${base}/api/agent/${sessionId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // pi's own RPC body: pi-web forwards it to the session untouched, and only a `prompt`
      // command starts a turn.
      body: JSON.stringify(sessionId === null
        ? { cwd: sessionCwd(project), type: "prompt", message: prompt }
        : { type: "prompt", message: prompt }),
      signal: AbortSignal.timeout(PIWEB_WAKE_TIMEOUT_MS),
    });
    if (!res.ok) return null; // a 4xx/5xx means the session did not start
    if (sessionId !== null) return { sessionId };
    // pi-web mints the id for a new session; the response is the only place it appears.
    const body = await res.json() as { sessionId?: unknown };
    return { sessionId: typeof body.sessionId === "string" ? body.sessionId : null };
  } catch (err) {
    // A timeout is not "pi-web is down": it may still be starting the session, and spawning a
    // second writer on top of that corrupts the JSONL. Only a refused connection means down.
    const name = (err as { name?: string } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") return "unclear";
    return null; // connection refused / DNS: pi-web is not there, spawn pi ourselves
  }
}

/**
 * Start a session for a card: pi-web when it is up (it owns the spawn queue and knows which
 * sessions are live), else a `pi -p` of our own. Returns null when the session already has a
 * writer — pi appends, so two writers corrupt the JSONL. stdout is dropped: the conversation
 * belongs to the session file, which pi-web reads.
 */
export async function wakeCardSession(db: Db, project: Project, card: Card, opts: WakeOptions = {}): Promise<WakeResult | null> {
  if (running.has(project.projectId) || waking.has(project.projectId)) return null;
  waking.add(project.projectId);
  try {
    return await startSession(db, project, card, opts);
  } finally {
    waking.delete(project.projectId);
  }
}

async function startSession(db: Db, project: Project, card: Card, opts: WakeOptions): Promise<WakeResult | null> {
  // An existing session is resumed (--session); a new one is minted (--session-id), and only a
  // new one gets a name — renaming a resumed session would overwrite the name its user gave it.
  const existing = card.sessionId ?? null;
  const prompt = buildCardPrompt(project, card);
  // A card that has no session yet has nothing to lock: pi-web mints the id, and a `pi` of our
  // own gets its lock from the id we mint below. An existing session is gated first — the gate
  // covers both runners, because pi appends to the file without checking.
  const lock = existing === null
    ? null
    : await acquireSessionLock(existing, sessionDirOf(project), { fetch: opts.fetch, url: opts.piwebUrl });
  if (existing !== null && lock === null) return null;
  // The lock is released for the pi-web path: pi-web reports the session as running itself, so
  // a lock we took for it would only outlive the run (pi-web never tells us it exited).
  const viaPiWeb = await wakeInPiWeb(project, existing, prompt, opts);
  if (viaPiWeb === "unclear") {
    // Someone may be on it now; the next tick's running list and mtime decide, not us.
    lock?.release();
    return null;
  }
  if (viaPiWeb !== null) {
    lock?.release();
    // Remember the id pi-web minted, or the next wake would start a second session.
    if (existing === null && viaPiWeb.sessionId !== null) {
      updateCard(db, project.projectId, card.id, { sessionId: viaPiWeb.sessionId }, { actor: "loop" });
    }
    return { sessionId: viaPiWeb.sessionId, pid: undefined, via: "pi-web" };
  }
  // pi-web is not taking it: keep the lock until `pi` exits.
  const sessionId = existing ?? randomUUID();
  const held = lock ?? await acquireSessionLock(sessionId, sessionDirOf(project), { fetch: opts.fetch, url: opts.piwebUrl });
  if (held === null) return null;
  if (existing === null) updateCard(db, project.projectId, card.id, { sessionId }, { actor: "loop" });
  const args = existing === null
    ? ["-p", "--session-id", sessionId, "--name", `kanban #${card.id}`, prompt]
    : ["-p", "--session", sessionId, prompt];
  const spawnFn = opts.spawn ?? nodeSpawn;
  const child = spawnFn(opts.bin ?? "pi", args, { cwd: sessionCwd(project), stdio: ["ignore", "pipe", "pipe"], env: process.env });
  running.set(project.projectId, child);
  const release = (): void => {
    held.release();
    if (running.get(project.projectId) === child) running.delete(project.projectId);
  };
  child.on("exit", release);
  child.on("error", release);
  // shortcut: one stderr line per chunk, upgrade to a line buffer if output splits mid-line.
  child.stderr?.on("data", (chunk: Buffer | string) => {
    const line = String(chunk).trim().split("\n")[0];
    if (line !== "") console.error(`[kanban wake ${project.slug}] ${line}`);
  });
  child.stdout?.resume();
  return { sessionId, pid: child.pid, via: "pi" };
}
