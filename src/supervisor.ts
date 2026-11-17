// Cross-board doing-loop supervisor.
//
// Each board's loop is its own row, so a board that drains (halts) must not stop the others:
// this walks every project and ticks only the ones that are running. Each tick moves the
// board's next TODO into DOING (WIP=1) and then wakes the card that is in DOING — level, not
// edge: a card left in DOING with no writer (a refused wake, a dead process, a restart) is
// retried on a later pass instead of sitting there until a human notices.
import type { Db } from "./persistence/db.js";
import type { EntityId } from "./shared/ids.js";
import { listProjects } from "./persistence/repos.js";
import { tickProject } from "./loop-runner.js";
import { wakeCardSession } from "./agent/driver.js";

export const SUPERVISOR_INTERVAL_MS = 15_000;

/** How long a DOING card with no writer waits before the supervisor wakes it again. */
export const WAKE_RETRY_MS = 5 * 60_000;

export interface LoopTickReport {
  projectId: string;
  slug: string;
  status: "running" | "halted" | "idle";
  nextCardId: EntityId | null;
  ticks: number;
  haltReason: string | null;
}

/** Injection point: tests pass a no-op so a tick never launches a real pi process. */
export type Wake = typeof wakeCardSession;

type WakeLog = Map<string, { cardId: EntityId; at: number }>;

/** One pass over every board. Moves loop_state, the timeline and (via wake) one session. */
export async function tickAllLoops(
  db: Db,
  now: string = new Date().toISOString(),
  wake: Wake = wakeCardSession,
  log: WakeLog = new Map(),
): Promise<LoopTickReport[]> {
  const out: LoopTickReport[] = [];
  const clock = Date.parse(now) || Date.now();
  const pending: Promise<void>[] = [];
  for (const project of listProjects(db)) {
    // One board throwing (SQLITE_BUSY, a row that will not parse) must not eat the other
    // boards' tick in this pass. Its row stays `running`, so the next pass just retries it.
    try {
      const result = tickProject(db, project.projectId, now, "supervisor");
      if (!result) continue; // not running, or the project vanished between the two reads
      const cardId = result.moved?.id ?? result.doingCardId;
      if (cardId !== null) {
        // A card this tick just moved is woken at once. One that was already here is woken
        // again only after WAKE_RETRY_MS, or every pass would refill pi-web's prompt queue.
        const seen = log.get(project.projectId);
        const fresh = result.moved !== null || seen === undefined || seen.cardId !== cardId || clock - seen.at >= WAKE_RETRY_MS;
        if (fresh) {
          log.set(project.projectId, { cardId, at: clock });
          // Wake in parallel: pi-web takes up to 30s, and boards must not queue behind each other.
          const card = result.moved ?? { id: cardId };
          pending.push((async () => {
            // A board that cannot spawn (no pi on PATH, no cwd) still reports its tick.
            try { await wake(db, project, card as Parameters<Wake>[2]); } catch { /* retried next pass */ }
          })());
        }
      }
      out.push({
        projectId: project.projectId, slug: project.slug, status: result.loop.status,
        nextCardId: result.nextCardId, ticks: result.loop.ticks, haltReason: result.loop.haltReason,
      });
    } catch {
      // Retried next pass. The loop row is left as it was, which is the truth: we do not know.
    }
  }
  await Promise.allSettled(pending);
  return out;
}

export interface Supervisor {
  /** Tick every running loop once, right now. */
  tickOnce: (now?: string) => Promise<LoopTickReport[]>;
  /** Re-arm the timer, e.g. after the saved interval changes. */
  restart: (ms: number) => void;
  stop: () => void;
  intervalMs: number;
}

export interface SupervisorOptions {
  intervalMs?: number;
  /** Test seam: replaced by startServer callers only. */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
  tickOnce?: (now?: string) => Promise<LoopTickReport[]>;
  /** Test seam: the heartbeat must not launch a real pi process in tests. */
  wake?: Wake;
}

/**
 * A timer over tickAllLoops. Errors are swallowed per pass: one bad board must not kill the
 * heartbeat, and a supervisor that throws inside setInterval would take the process with it.
 * A pass that runs longer than the interval is not started twice: `inFlight` drops the overlap.
 */
export function startSupervisor(db: Db, opts: SupervisorOptions = {}): Supervisor {
  const set = opts.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clear = opts.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  const log: WakeLog = new Map();
  const tickOnce = opts.tickOnce ?? ((now?: string) => tickAllLoops(db, now, opts.wake, log));
  let inFlight = false;
  let handle: unknown;
  let intervalMs = 0;
  const safeTick = async (now?: string): Promise<LoopTickReport[]> => {
    if (inFlight) return [];
    inFlight = true;
    try { return await tickOnce(now); } catch { return []; } finally { inFlight = false; }
  };
  const arm = (ms: number): void => {
    if (handle !== undefined) clear(handle);
    intervalMs = ms;
    handle = set(() => { void safeTick(); }, ms);
    // A supervisor must never hold the process open by itself (tests close the DB first).
    (handle as { unref?: () => void }).unref?.();
  };
  arm(opts.intervalMs ?? SUPERVISOR_INTERVAL_MS);
  return {
    tickOnce: safeTick,
    restart: (ms: number): void => { arm(ms); },
    stop: (): void => { if (handle !== undefined) clear(handle); },
    get intervalMs(): number { return intervalMs; },
  };
}
