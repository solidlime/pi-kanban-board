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

export interface WakeOptions {
  spawn?: SpawnFn;
  bin?: string;
  /** Test seam: a unit test must not POST to a live pi-web. */
  fetch?: typeof globalThis.fetch;
  /** Test seam for the pi-web base URL; defaults to KANBAN_PIWEB_URL. */
  piwebUrl?: string;
}

export interface WakeResult {
  sessionId: string;
  pid: number | undefined;
  /** Which runner took the card: pi-web's own queue, or a `pi -p` we spawned ourselves. */
  via: "pi-web" | "pi";
}

/** Where pi keeps the JSONL of this board's sessions (the folder the picker reads). */
export function sessionDirOf(project: Project): string {
  return join(homedir(), ".pi", "agent", "sessions", sessionDirName(sessionCwd(project)));
}

const PIWEB_WAKE_TIMEOUT_MS = 5000;

/** True when pi-web accepted the session: from then on it is pi-web's session, not ours. */
async function wakeInPiWeb(project: Project, sessionId: string, prompt: string, opts: WakeOptions): Promise<boolean> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  try {
    const res = await doFetch(`${piWebUrl(opts.piwebUrl)}/api/agent/new`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: sessionCwd(project), sessionId, message: prompt }),
      signal: AbortSignal.timeout(PIWEB_WAKE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false; // pi-web is not there: spawn pi ourselves
  }
}

/**
 * Start a session for a card: pi-web when it is up (it owns the spawn queue and knows which
 * sessions are live), else a `pi -p` of our own. Returns null when the session already has a
 * writer — pi appends, so two writers corrupt the JSONL. stdout is dropped: the conversation
 * belongs to the session file, which pi-web reads.
 */
export async function wakeCardSession(db: Db, project: Project, card: Card, opts: WakeOptions = {}): Promise<WakeResult | null> {
  // An existing session is resumed (--session); a new one is minted (--session-id), and only a
  // new one gets a name — renaming a resumed session would overwrite the name its user gave it.
  const existing = card.sessionId ?? null;
  const sessionId = existing ?? randomUUID();
  // The gate comes before either runner: a session somebody is already on must not be started
  // twice. The lock is only kept by the pi path — pi-web never reports its exit, so a lock we
  // took for it would outlive the run.
  const lock = await acquireSessionLock(sessionId, sessionDirOf(project), { fetch: opts.fetch, url: opts.piwebUrl });
  if (lock === null) return null;
  if (running.has(project.projectId)) {
    lock.release();
    return null;
  }
  if (existing === null) updateCard(db, project.projectId, card.id, { sessionId }, { actor: "loop" });
  const prompt = buildCardPrompt(project, card);
  if (await wakeInPiWeb(project, sessionId, prompt, opts)) {
    lock.release();
    return { sessionId, pid: undefined, via: "pi-web" };
  }
  const args = existing === null
    ? ["-p", "--session-id", sessionId, "--name", `kanban #${card.id}`, prompt]
    : ["-p", "--session", sessionId, prompt];
  const spawnFn = opts.spawn ?? nodeSpawn;
  const child = spawnFn(opts.bin ?? "pi", args, { cwd: sessionCwd(project), stdio: ["ignore", "pipe", "pipe"], env: process.env });
  running.set(project.projectId, child);
  const release = (): void => {
    lock.release();
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
