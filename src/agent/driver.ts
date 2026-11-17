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
import { getCard, getColumn, updateCard } from "../persistence/repos.js";
import { parseAcceptance } from "../core/acceptance.js";
import { sessionDirName } from "../core/sessions.js";
import { acquireSessionLock, piWebUrl } from "./session-lock.js";

export type SpawnFn = typeof nodeSpawn;

/** The directory the session runs in: the board's `settings.cwd` when set, else ours. */
export function sessionCwd(project: Project): string {
  const cwd = project.settings?.cwd;
  return typeof cwd === "string" && cwd.trim() !== "" ? cwd : process.cwd();
}

/**
 * Kept short on purpose: the card is the spec, the tool call is the exit condition.
 * The first line tags the origin so a session can tell a card's text (which anything on the
 * board can write) from the human speaking now. It stays in the message, not a system header:
 * a prefix that changes every turn would miss the prompt cache (same reason as `[NOUS STATE]`).
 */
export function buildCardPrompt(project: Project, card: Card): string {
  const acceptance = parseAcceptance(card.body);
  const criteria = acceptance.length === 0
    ? "- （なし）"
    : acceptance.map(a => `- [${a.done ? "x" : " "}] ${a.text}`).join("\n");
  return [
    `[kanban ${project.slug}#${card.id}]`,
    // A queued wake outlives the card it was written for: the session has to look before it works.
    // Model-dependent, not a guarantee — the tool call is the only exit condition we control.
    `まず kanban ツールでこのカードが doing に居るか確認し、done か doing 以外なら何もせず終了してください。`,
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
    // WIP=1: a blocked card left in doing starves the board until the stuck halt.
    `中断するなら kanban ツールで blockedReason を書いて TODO に戻してください。`,
    `cwd の外のファイルは触らないこと。`,
  ].join("\n");
}

/** One live child per board: a second DOING card on the same board waits for the first. */
const running = new Map<ProjectId, { child: ChildProcess; startedAt: number }>();
/** A wake already in flight. `/api/agent/new` mints the id on the pi-web side, so two
 *  concurrent calls would create two sessions the card can never reconcile. */
const waking = new Set<ProjectId>();
/**
 * A child whose exit we never saw keeps a board's wakes dead for good. After this long the entry
 * is a leftover and is swept — the process itself is never killed, that would throw a turn away.
 * Long on purpose: a real card turn can run for a long time.
 */
const WAKE_CHILD_TTL_MS = 60 * 60 * 1000;

export interface WakeOptions {
  spawn?: SpawnFn;
  bin?: string;
  /** Test seam: a unit test must not POST to a live pi-web. */
  fetch?: typeof globalThis.fetch;
  /** Test seam for the pi-web base URL; defaults to KANBAN_PIWEB_URL. */
  piwebUrl?: string;
  /** Test seam for the running-entry TTL; defaults to Date.now. */
  now?: () => number;
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

const PIWEB_WAKE_TIMEOUT_MS = 30000;

/**
 * pi-web takes the session: a new card goes to `/api/agent/new` (pi-web mints the id and
 * answers with it), an existing one to `/api/agent/<id>`, which resumes the JSONL when the
 * session is not live. null = pi-web is not there, so the caller may spawn pi itself;
 * "unclear" = pi-web may be on it, so nobody else may.
 */
async function wakeInPiWeb(project: Project, sessionId: string | null, prompt: string, opts: WakeOptions): Promise<{ sessionId: string } | "unclear" | null> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const base = piWebUrl(opts.piwebUrl);
  try {
    const res = await doFetch(sessionId === null ? `${base}/api/agent/new` : `${base}/api/agent/${sessionId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // pi's own RPC body: pi-web forwards it to the session untouched, and only a `prompt`
      // command starts a turn. `followUp` queues behind a turn the session is already running
      // instead of failing it — a card moved while its session is busy still has to arrive.
      body: JSON.stringify(sessionId === null
        ? { cwd: sessionCwd(project), type: "prompt", message: prompt }
        : { type: "prompt", message: prompt, streamingBehavior: "followUp" }),
      signal: AbortSignal.timeout(PIWEB_WAKE_TIMEOUT_MS),
    });
    // A 4xx is pi-web saying no to *this* session while it stays alive — spawning pi on top of
    // a JSONL pi-web may still open is the corruption the lock exists to prevent. A 5xx is
    // pi-web failing at its job, which is the same as it being absent — unless it names this
    // prompt as rejected, which means it is alive and knows the session.
    if (!res.ok) {
      const why = await res.json().catch(() => ({})) as { accepted?: unknown };
      return res.status >= 500 && why.accepted !== false ? null : "unclear";
    }
    // A refused prompt still comes back 200 with success:false (a 4xx carries
    // `accepted:false` instead); claiming delivery then is how a wake goes missing in silence.
    // Any other 2xx is pi-web taking it, even with an empty or non-JSON body — reading that as
    // "pi-web is gone" would put a second writer on the JSONL.
    const body = await res.json().catch(() => ({})) as { sessionId?: unknown; success?: unknown; accepted?: unknown };
    // `accepted:false` rides 4xx and 5xx, which the status check above already caught; checking it
    // here too is insurance, not something pi-web is known to send with a 200.
    if (body.success === false || body.accepted === false) return "unclear";
    if (sessionId !== null) return { sessionId };
    // /api/agent/new mints the id and answers `{ success, sessionId, data, ... }`. Without it the
    // card never learns its session and the next wake opens a second one.
    const minted = typeof body.sessionId === "string" ? body.sessionId : null;
    return minted === null ? "unclear" : { sessionId: minted };
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
  const entry = running.get(project.projectId);
  if (entry && (opts.now?.() ?? Date.now()) - entry.startedAt > WAKE_CHILD_TTL_MS
    && (entry.child.exitCode !== null || entry.child.killed)) {
    running.delete(project.projectId);
  }
  if (running.has(project.projectId) || waking.has(project.projectId)) return null;
  waking.add(project.projectId);
  try {
    return await startSession(db, project, card, opts);
  } finally {
    waking.delete(project.projectId);
  }
}

async function startSession(db: Db, project: Project, card: Card, opts: WakeOptions): Promise<WakeResult | null> {
  // A wake that claims nothing has to say why: the card sits in DOING and nothing retries it.
  const refuse = (why: string): null => {
    console.error(`[kanban wake ${project.slug}#${card.id}] ${why}`);
    return null;
  };
  // A wake can be queued before the card moves (or after it is closed). The board is the truth:
  // a stale snapshot or a finished card must not be run, or the card resurrects in DOING.
  const fresh = getCard(db, project.projectId, card.id) ?? card;
  if (getColumn(db, project.projectId, fresh.columnId)?.kind !== "doing") {
    return refuse(`card is not in a doing column (${fresh.columnId}), so nothing is woken`);
  }
  // An existing session is resumed (--session); a new one is minted (--session-id), and only a
  // new one gets a name — renaming a resumed session would overwrite the name its user gave it.
  const existing = card.sessionId ?? null;
  const prompt = buildCardPrompt(project, card);
  // pi-web goes first. It owns the sessions it started, and a card pointed at a live session has
  // to reach that session — asking the local gate first would call pi-web's own run a second
  // writer and drop the prompt. A new card has nothing to gate: pi-web mints its id.
  // Known gap: `waking`/`running` are per board, so two cards pointing at one session (on two
  // boards) each get the prompt. The JSONL is safe — pi-web serializes one session — but that
  // session gets two prompts.
  const viaPiWeb = await wakeInPiWeb(project, existing, prompt, opts);
  if (viaPiWeb === "unclear") {
    // pi-web may still start it; a pid we cannot see would be the second writer.
    return refuse("pi-web did not clearly take the session (timeout, 4xx or success:false)");
  }
  if (viaPiWeb !== null) {
    // Remember the id pi-web minted, or the next wake would start a second session.
    if (existing === null) {
      updateCard(db, project.projectId, card.id, { sessionId: viaPiWeb.sessionId }, { actor: "loop" });
    }
    return { sessionId: viaPiWeb.sessionId, pid: undefined, via: "pi-web" };
  }
  // pi-web is not there: we own the run, so the local gates decide and the lock is held until
  // `pi` exits.
  const sessionId = existing ?? randomUUID();
  const held = await acquireSessionLock(sessionId, sessionDirOf(project), { fetch: opts.fetch, url: opts.piwebUrl });
  if (held === null) return refuse(`session ${sessionId} already has a writer (live lock, a pi-web run, or a JSONL written in the last 120s)`);
  const args = existing === null
    ? ["-p", "--session-id", sessionId, "--name", `kanban #${card.id}`, prompt]
    : ["-p", "--session", sessionId, prompt];
  const spawnFn = opts.spawn ?? nodeSpawn;
  const child = spawnFn(opts.bin ?? "pi", args, { cwd: sessionCwd(project), stdio: ["ignore", "pipe", "pipe"], env: process.env });
  running.set(project.projectId, { child, startedAt: Date.now() });
  // `error` and `exit` both end the child, and they can both fire (error, then exit). A second
  // release would delete the lock a wake that started in between now owns.
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    held.release();
    if (running.get(project.projectId)?.child === child) running.delete(project.projectId);
  };
  child.on("exit", release);
  child.on("error", release);
  // shortcut: one stderr line per chunk, upgrade to a line buffer if output splits mid-line.
  child.stderr?.on("data", (chunk: Buffer | string) => {
    const line = String(chunk).trim().split("\n")[0];
    if (line !== "") console.error(`[kanban wake ${project.slug}] ${line}`);
  });
  child.stdout?.resume();
  // spawn() does not throw for a missing binary or cwd: the failure arrives as an async `error`
  // event and the pid stays undefined. Claiming the wake then leaves the card pointing at a
  // session nobody started.
  if (child.pid === undefined) {
    const why = await new Promise<string>((resolve) => {
      child.once("error", (err: Error) => resolve(err.message));
      child.once("exit", () => resolve("exited before it started"));
    });
    release();
    return refuse(`spawn failed: ${why}`);
  }
  // The child outlives us: the lock names the writer, not the process that spawned it.
  held.bind(child.pid);
  // Only a started session is worth remembering, or the next wake reuses a dead id.
  if (existing === null) updateCard(db, project.projectId, card.id, { sessionId }, { actor: "loop" });
  return { sessionId, pid: child.pid, via: "pi" };
}
