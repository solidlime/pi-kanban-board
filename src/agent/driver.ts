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
import type { EntityId, ProjectId } from "../shared/ids.js";
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
/** A card body is user input: 200,000 characters in a prompt is a paper cut, not a spec. */
const MAX_PROMPT_BODY = 4000;

function clipForPrompt(body: string | null | undefined): string {
  const text = body?.trim() ?? "";
  if (text === "") return "（なし）";
  if (text.length <= MAX_PROMPT_BODY) return text;
  return `${text.slice(0, MAX_PROMPT_BODY)}\n…（残り ${text.length - MAX_PROMPT_BODY} 文字は card get で読むこと）`;
}

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
    `body: ${clipForPrompt(card.body)}`,
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
const running = new Map<ProjectId, { child: ChildProcess; startedAt: number; cardId: EntityId }>();

/**
 * The card is gone (deleted, or moved off the board): drop its watcher entry so the next wake
 * is not refused on behalf of a card nobody can see. The process is left alone — killing a
 * turn loses whatever it was writing, and its own kanban call now fails with NOT_FOUND.
 */
export function forgetCard(projectId: ProjectId, cardId: EntityId): void {
  if (running.get(projectId)?.cardId === cardId) running.delete(projectId);
}

/**
 * The whole board went away, and the watcher entry points at no card that can ever come back.
 * The process is left alone for the same reason as forgetCard.
 */
export function forgetProject(projectId: ProjectId): void {
  running.delete(projectId);
}

/** Diagnostics for GET /api/loop: who this process believes it is running, and since when. */
export function runningWakes(): Array<{ projectId: string; cardId: EntityId; pid: number | undefined; startedAt: number }> {
  return [...running.entries()].map(([projectId, e]) => ({ projectId, cardId: e.cardId, pid: e.child.pid, startedAt: e.startedAt }));
}
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
  /** Which runner took the card: a prompt handed to pi-web, or a `pi -p` we spawned ourselves. */
  via: "pi-web" | "pi";
}

/** Why a wake delivered nothing. The caller decides what to retry from the reason alone. */
export type WakeRefusal = { refused: "busy" | "in-flight" | "unclear" | "not-doing" | "locked" | "spawn-failed" };

type BusyProbe = "busy" | "idle" | "unknown";

const BUSY_PROBE_TIMEOUT_MS = 1000;

/**
 * Is the session mid-turn? Only a positive answer counts. A probe that cannot answer (non-2xx,
 * unreadable body, timeout, refused connection) is `unknown`, and the POST then is the test: pi
 * refuses a prompt on a running session. Reading unknown as busy leaves a card in DOING forever;
 * the opposite costs one refusal. The two are not symmetric.
 */
async function probeSession(base: string, sessionId: string, doFetch: typeof fetch): Promise<BusyProbe> {
  try {
    // `?systemPrompt=0` drops the system prompt from the answer (5.8KB -> 1.1KB).
    const res = await doFetch(`${base}/api/agent/${sessionId}?systemPrompt=0`, {
      signal: AbortSignal.timeout(BUSY_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return "unknown";
    // The counters live inside `state`; the top level carries only `running` and `state`
    // (measured: top-level pendingMessageCount is absent, state.pendingMessageCount is the count).
    const body = await res.json() as {
      running?: unknown;
      state?: { isPromptRunning?: unknown; isStreaming?: unknown; isCompacting?: unknown; pendingMessageCount?: unknown };
    };
    // `running:false` is pi-web holding no agent at all: nothing can be running.
    if (body.running === false) return "idle";
    const s = body.state ?? {};
    // `isStreaming` and `isPromptRunning` are independent: one alone misses a busy session.
    if (s.isPromptRunning === true || s.isStreaming === true || s.isCompacting === true) return "busy";
    // Already queued prompts are delivered for sure, so a second one is only a duplicate run.
    if (typeof s.pendingMessageCount === "number" && s.pendingMessageCount > 0) return "busy";
    return "idle";
  } catch {
    return "unknown";
  }
}

/** Where pi keeps the JSONL of this board's sessions (the folder the picker reads). */
export function sessionDirOf(project: Project): string {
  return join(homedir(), ".pi", "agent", "sessions", sessionDirName(sessionCwd(project)));
}

const PIWEB_WAKE_TIMEOUT_MS = 30000;

/**
 * pi-web takes the session: a new card goes to `/api/agent/new` (pi-web mints the id and
 * answers with it), an existing one to `/api/agent/<id>`, which resumes the JSONL when the
 * session is not live. null = pi-web is not there, so the caller may spawn pi itself; a refusal
 * says why nothing was delivered (pi-web may be on it, it is busy, ...).
 */
async function wakeInPiWeb(project: Project, sessionId: string | null, prompt: string, opts: WakeOptions): Promise<{ sessionId: string } | WakeRefusal | null> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const base = piWebUrl(opts.piwebUrl);
  // A queued prompt outlives the turn it waits for and lands on a card that may be done by then.
  // Ask first; only a positive answer refuses, and a new session has nothing to ask about.
  if (sessionId !== null && await probeSession(base, sessionId, doFetch) === "busy") {
    return { refused: "busy" };
  }
  try {
    const res = await doFetch(sessionId === null ? `${base}/api/agent/new` : `${base}/api/agent/${sessionId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // pi's own RPC body: pi-web forwards it to the session untouched, and only a `prompt`
      // command starts a turn. No `streamingBehavior`: a followUp hides the race as "an old
      // prompt arrives later", and pi answering an error to a busy session is the atomic test.
      body: JSON.stringify(sessionId === null
        ? { cwd: sessionCwd(project), type: "prompt", message: prompt }
        : { type: "prompt", message: prompt }),
      signal: AbortSignal.timeout(PIWEB_WAKE_TIMEOUT_MS),
    });
    // A 4xx is pi-web saying no to *this* session while it stays alive — spawning pi on top of
    // a JSONL pi-web may still open is the corruption the lock exists to prevent. A 5xx is
    // pi-web failing at its job, which is the same as it being absent — unless it names this
    // prompt as rejected, which means it is alive and knows the session.
    if (!res.ok) {
      const why = await res.json().catch(() => ({})) as { accepted?: unknown };
      return res.status >= 500 && why.accepted !== false ? null : { refused: "unclear" };
    }
    // A refused prompt still comes back 200 with success:false (a 4xx carries
    // `accepted:false` instead); claiming delivery then is how a wake goes missing in silence.
    // Any other 2xx is pi-web taking it, even with an empty or non-JSON body — reading that as
    // "pi-web is gone" would put a second writer on the JSONL.
    const body = await res.json().catch(() => ({})) as { sessionId?: unknown; success?: unknown; accepted?: unknown };
    // `accepted:false` rides 4xx and 5xx, which the status check above already caught; checking it
    // here too is insurance, not something pi-web is known to send with a 200.
    if (body.success === false || body.accepted === false) return { refused: "unclear" };
    if (sessionId !== null) return { sessionId };
    // /api/agent/new mints the id and answers `{ success, sessionId, data, ... }`. Without it the
    // card never learns its session and the next wake opens a second one.
    const minted = typeof body.sessionId === "string" ? body.sessionId : null;
    return minted === null ? { refused: "unclear" } : { sessionId: minted };
  } catch (err) {
    // A timeout is not "pi-web is down": it may still be starting the session, and spawning a
    // second writer on top of that corrupts the JSONL. Only a refused connection means down.
    const name = (err as { name?: string } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") return { refused: "unclear" };
    return null; // connection refused / DNS: pi-web is not there, spawn pi ourselves
  }
}

/**
 * Start a session for a card: pi-web when it is up (it owns the spawn queue and knows which
 * sessions are live), else a `pi -p` of our own. Refuses when the session already has a
 * writer — pi appends, so two writers corrupt the JSONL. stdout is dropped: the conversation
 * belongs to the session file, which pi-web reads.
 */
export async function wakeCardSession(db: Db, project: Project, card: Card, opts: WakeOptions = {}): Promise<WakeResult | WakeRefusal> {
  const entry = running.get(project.projectId);
  if (entry && (opts.now?.() ?? Date.now()) - entry.startedAt > WAKE_CHILD_TTL_MS
    && (entry.child.exitCode !== null || entry.child.killed)) {
    running.delete(project.projectId);
  }
  if (running.has(project.projectId) || waking.has(project.projectId)) return { refused: "in-flight" };
  waking.add(project.projectId);
  try {
    return await startSession(db, project, card, opts);
  } finally {
    waking.delete(project.projectId);
  }
}

async function startSession(db: Db, project: Project, card: Card, opts: WakeOptions): Promise<WakeResult | WakeRefusal> {
  // A wake that claims nothing has to say why: the card sits in DOING and nothing retries it.
  // `busy` is an expected answer, not an error — the supervisor logs the first of a streak.
  const refuse = (why: string, code: WakeRefusal["refused"]): WakeRefusal => {
    if (code !== "busy") console.error(`[kanban wake ${project.slug}#${card.id}] ${why}`);
    return { refused: code };
  };
  // A wake can be queued before the card moves (or after it is closed). The board is the truth:
  // a stale snapshot or a finished card must not be run, or the card resurrects in DOING.
  const fresh = getCard(db, project.projectId, card.id) ?? card;
  if (getColumn(db, project.projectId, fresh.columnId)?.kind !== "doing") {
    return refuse(`card is not in a doing column (${fresh.columnId}), so nothing is woken`, "not-doing");
  }
  // An existing session is resumed (--session); a new one is minted (--session-id), and only a
  // new one gets a name — renaming a resumed session would overwrite the name its user gave it.
  // A stale snapshot would resume a session the board no longer answers to, and rows wake from
  // queued prompts long after the card moved: read both the column and the session from fresh.
  const existing = fresh.sessionId ?? card.sessionId ?? null;
  const prompt = buildCardPrompt(project, fresh);
  // pi-web goes first. It owns the sessions it started, and a card pointed at a live session has
  // to reach that session — asking the local gate first would call pi-web's own run a second
  // writer and drop the prompt. A new card has nothing to gate: pi-web mints its id.
  // Known gap: `waking`/`running` are per board, so two cards pointing at one session (on two
  // boards) each get the prompt. The JSONL is safe — pi-web serializes one session — but that
  // session gets two prompts.
  const viaPiWeb = await wakeInPiWeb(project, existing, prompt, opts);
  if (viaPiWeb !== null && "refused" in viaPiWeb) {
    // busy: the turn will end and the supervisor retries. unclear: pi-web may still start it, and
    // a pid we cannot see would be the second writer.
    return viaPiWeb;
  }
  if (viaPiWeb !== null) {
    // Remember the id pi-web minted, or the next wake would start a second session.
    if (existing === null) {
      updateCard(db, project.projectId, card.id, { sessionId: viaPiWeb.sessionId }, { actor: "loop", touch: false });
    }
    return { sessionId: viaPiWeb.sessionId, pid: undefined, via: "pi-web" };
  }
  // pi-web is not there: we own the run, so the local gates decide and the lock is held until
  // `pi` exits.
  const sessionId = existing ?? randomUUID();
  const held = await acquireSessionLock(sessionId, sessionDirOf(project), { fetch: opts.fetch, url: opts.piwebUrl });
  if (held === null) return refuse(`session ${sessionId} already has a writer (live lock, a pi-web run, or a JSONL written in the last 120s)`, "locked");
  const args = existing === null
    ? ["-p", "--session-id", sessionId, "--name", `kanban #${card.id}`, prompt]
    : ["-p", "--session", sessionId, prompt];
  const spawnFn = opts.spawn ?? nodeSpawn;
  const child = spawnFn(opts.bin ?? "pi", args, { cwd: sessionCwd(project), stdio: ["ignore", "pipe", "pipe"], env: process.env });
  running.set(project.projectId, { child, startedAt: Date.now(), cardId: card.id });
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
    return refuse(`spawn failed: ${why}`, "spawn-failed");
  }
  // The child outlives us: the lock names the writer, not the process that spawned it.
  held.bind(child.pid);
  // Only a started session is worth remembering, or the next wake reuses a dead id.
  if (existing === null) updateCard(db, project.projectId, card.id, { sessionId }, { actor: "loop", touch: false });
  return { sessionId, pid: child.pid, via: "pi" };
}
