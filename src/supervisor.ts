// Cross-board doing-loop supervisor.
//
// Each board's loop is its own row, so a board that drains (halts) must not stop the others:
// this walks every project and ticks only the ones that are running. Each tick moves the
// board's next TODO into DOING (WIP=1) — it does not wake a model. A reader (the UI, or a
// supervisor agent) sees the per-board heartbeat and the next card each board named.
import type { Db } from "./persistence/db.js";
import type { EntityId } from "./shared/ids.js";
import { listProjects } from "./persistence/repos.js";
import { tickProject } from "./loop-runner.js";
import { wakeCardSession } from "./agent/driver.js";

export const SUPERVISOR_INTERVAL_MS = 15_000;

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

/** One pass over every board. Moves loop_state, the timeline and (via wake) one session. */
export function tickAllLoops(db: Db, now: string = new Date().toISOString(), wake: Wake = wakeCardSession): LoopTickReport[] {
  const out: LoopTickReport[] = [];
  for (const project of listProjects(db)) {
    // One board throwing (SQLITE_BUSY, a row that will not parse) must not eat the other
    // boards' tick in this pass. Its row stays `running`, so the next pass just retries it.
    try {
      const result = tickProject(db, project.projectId, now, "supervisor");
      if (!result) continue; // not running, or the project vanished between the two reads
      if (result.moved) {
        // A board that cannot spawn (no pi on PATH, no cwd) still reports its tick.
        try { wake(db, project, result.moved); } catch { /* retried next pass */ }
      }
      out.push({
        projectId: project.projectId, slug: project.slug, status: result.loop.status,
        nextCardId: result.nextCardId, ticks: result.loop.ticks, haltReason: result.loop.haltReason,
      });
    } catch {
      // Retried next pass. The loop row is left as it was, which is the truth: we do not know.
    }
  }
  return out;
}

export interface Supervisor {
  /** Tick every running loop once, right now. */
  tickOnce: (now?: string) => LoopTickReport[];
  stop: () => void;
  intervalMs: number;
}

export interface SupervisorOptions {
  intervalMs?: number;
  /** Test seam: replaced by startServer callers only. */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
  tickOnce?: (now?: string) => LoopTickReport[];
  /** Test seam: the heartbeat must not launch a real pi process in tests. */
  wake?: Wake;
}

/**
 * A timer over tickAllLoops. Errors are swallowed per pass: one bad board must not kill the
 * heartbeat, and a supervisor that throws inside setInterval would take the process with it.
 */
export function startSupervisor(db: Db, opts: SupervisorOptions = {}): Supervisor {
  const intervalMs = opts.intervalMs ?? SUPERVISOR_INTERVAL_MS;
  const tickOnce = opts.tickOnce ?? ((now?: string) => tickAllLoops(db, now, opts.wake));
  const set = opts.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clear = opts.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  const safeTick = (now?: string): LoopTickReport[] => {
    try { return tickOnce(now); } catch { return []; }
  };
  const handle = set(() => { safeTick(); }, intervalMs);
  // A supervisor must never hold the process open by itself (tests close the DB first).
  (handle as { unref?: () => void }).unref?.();
  return { tickOnce: safeTick, stop: () => clear(handle), intervalMs };
}
