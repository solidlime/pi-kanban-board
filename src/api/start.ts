// DB lifecycle + server start. This is the only place that opens the home DB: it opens
// once, migrates pending steps, and hands the handle to the server and to tests.
// It NEVER initializes or destroys ~/.pi/kanban — an uninitialized home still serves
// meta/selftest (so the UI can say "run init") and refuses writes.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { HOST_DEFAULT, PORT_DEFAULT } from "../shared/constants.js";
import { closeDb, type Db } from "../persistence/db.js";
import { detectState, kanbanHome, openHomeDatabase, readToken, type HomeState } from "../persistence/init.js";
import { createServer, type ServerDeps } from "./server.js";
import { startSupervisor, type Supervisor } from "../supervisor.js";
import type http from "node:http";

const repoRoot = path.resolve(import.meta.dirname, "../..");

export interface StartOptions {
  /** Defaults to kanbanHome(); KANBAN_HOME is honoured by the CLI only. */
  home?: string;
  port?: number;
  host?: string;
  webRoot?: string;
  version?: string;
  /** Cross-board doing-loop heartbeat. Absent/0 = off (tests, and anyone who wants quiet). */
  loop?: { intervalMs?: number } | number | false;
  /** Token gate for the HTTP surface. Default: KANBAN_AUTH=on, else off. */
  auth?: boolean;
}

export interface RunningServer {
  server: http.Server;
  db: Db | null;
  home: string;
  state: HomeState;
  token: string | null;
  buildHash: string;
  webRoot: string;
  host: string;
  port: number;
  url: string;
  /** Present only when StartOptions.loop asked for it. */
  supervisor: Supervisor | null;
  close: () => Promise<void>;
}

/** web/dist/meta.json is the truth; without a build, hash the version + deps instead. */
export async function readBuildHash(webRoot: string): Promise<string> {
  try {
    const meta = JSON.parse(await readFile(path.join(webRoot, "meta.json"), "utf8")) as { buildHash?: string };
    if (meta.buildHash) return meta.buildHash;
  } catch { /* build not run yet */ }
  try {
    const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
      version?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>;
    };
    const deps = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}@${v}`)
      .join(",");
    return createHash("sha256").update(`${pkg.version ?? "0"}|${deps}`).digest("hex").slice(0, 12);
  } catch {
    return "dev";
  }
}

export async function startServer(opts: StartOptions = {}): Promise<RunningServer> {
  const home = opts.home ?? kanbanHome();
  const webRoot = opts.webRoot ?? path.join(repoRoot, "web/dist");
  const state = detectState(home);
  // Open once. openHomeDatabase migrates pending steps and throws if the home is not v2,
  // which is exactly why detectState gates it.
  const db: Db | null = state.initialized ? openHomeDatabase(home).db : null;
  const token = readToken(home);
  const buildHash = await readBuildHash(webRoot);
  const auth = opts.auth ?? process.env.KANBAN_AUTH === "on";
  const deps: ServerDeps = { db, home, state, token, auth, webRoot, buildHash, version: opts.version };

  const server = createServer(deps);
  const host = opts.host ?? HOST_DEFAULT;
  const port = opts.port ?? Number(process.env.KANBAN_PORT ?? PORT_DEFAULT);
  await new Promise<void>((resolve, reject) => {
    const onError = (err: unknown): void => reject(err);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  const shown = addr.address === "0.0.0.0" || addr.address === "::" ? "127.0.0.1" : addr.address;
  // No DB, no loop: an uninitialized home has nowhere to record a tick.
  const loopOpt = opts.loop;
  const loopMs = typeof loopOpt === "number" ? loopOpt : loopOpt === false || loopOpt === undefined ? 0 : loopOpt.intervalMs ?? 0;
  const supervisor = db && loopMs > 0 ? startSupervisor(db, { intervalMs: loopMs }) : null;
  return {
    server, db, home, state, token, buildHash, webRoot,
    host: addr.address,
    port: addr.port,
    url: `http://${shown}:${addr.port}/`,
    supervisor,
    close: () => new Promise<void>((resolve) => {
      supervisor?.stop();
      server.close(() => {
        if (db) closeDb(db);
        resolve();
      });
      // Keep-alive sockets would otherwise hold close() open.
      server.closeAllConnections();
    }),
  };
}
