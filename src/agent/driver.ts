// Waking a card: a DOING card gets its own headless `pi -p` session. The session is named
// after the card, told to move it to DONE itself with the kanban tool, and its cwd is the
// board's settings.cwd so pi-web lists it under the workspace it is working in.
import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Db } from "../persistence/db.js";
import type { Card, Project } from "../shared/dto.js";
import type { ProjectId } from "../shared/ids.js";
import { updateCard } from "../persistence/repos.js";
import { parseAcceptance } from "../core/acceptance.js";

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

export interface WakeOptions { spawn?: SpawnFn; bin?: string }

export interface WakeResult { sessionId: string; pid: number | undefined }

/**
 * Spawn a headless session for a card. Returns null when the board already has one running.
 * stdout is dropped — the conversation belongs to the session JSONL, which pi-web reads.
 */
export function wakeCardSession(db: Db, project: Project, card: Card, opts: WakeOptions = {}): WakeResult | null {
  if (running.has(project.projectId)) return null;
  const sessionId = card.sessionId ?? randomUUID();
  if (!card.sessionId) updateCard(db, project.projectId, card.id, { sessionId }, { actor: "loop" });
  const spawnFn = opts.spawn ?? nodeSpawn;
  const child = spawnFn(opts.bin ?? "pi", [
    "-p", "--session-id", sessionId, "--name", `kanban #${card.id}`, buildCardPrompt(project, card),
  ], { cwd: sessionCwd(project), stdio: ["ignore", "pipe", "pipe"], env: process.env });
  running.set(project.projectId, child);
  const release = (): void => {
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
  return { sessionId, pid: child.pid };
}
