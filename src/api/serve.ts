// CLI entry: `node src/api/serve.ts` (Node >= 22.5, no build step). Starts on
// KANBAN_PORT/PORT_DEFAULT, binds HOST_DEFAULT, and honours KANBAN_HOME for an alternate
// home (handy for a throwaway instance; it is never initialized automatically).
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

// Node strips types but does not rewrite NodeNext's `./x.js` specifiers onto the sibling
// `./x.ts`, so the CLI registers the same bridge the v2 tests use before importing src/.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js") && context.parentURL) {
      const url = new URL(specifier, context.parentURL);
      const asJs = fileURLToPath(url);
      const asTs = `${asJs.slice(0, -3)}.ts`;
      if (!existsSync(asJs) && existsSync(asTs)) {
        return { url: pathToFileURL(asTs).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

const { startServer } = await import("./start.js");
// The production wake: pi-web first, else a `pi -p` of our own. Tests inject a no-op instead.
const { wakeCardSession } = await import("../agent/driver.js");

const home = process.env.KANBAN_HOME;
// Cross-board loop heartbeat. Empty or 0 disables it; any other number is the interval in ms.
const rawLoop = (process.env.KANBAN_LOOP_MS ?? "").trim();
const loopMs = rawLoop === "" ? 15000 : Number(rawLoop);
const run = await startServer({
  ...(home ? { home } : {}),
  loop: Number.isFinite(loopMs) && loopMs > 0 ? { intervalMs: loopMs } : false,
  wake: wakeCardSession,
});

console.log(`kanban v2 listening on ${run.url}`);
console.log(`  home   ${run.home} (${run.state.status}${run.state.initialized ? "" : " — not initialized, writes will refuse"})`);
console.log(`  build  ${run.buildHash} · web ${run.webRoot}`);
console.log(`  loop   ${run.supervisor ? `supervisor every ${run.supervisor.intervalMs}ms` : "off (KANBAN_LOOP_MS=0)"}`);
if (!run.token) {
  console.warn(`  warn   no token file at ${run.home}/token — every request answers 401 until init runs`);
}

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  void run.close().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

// Spawned by a session: a Node child outlives its parent, so watch the PID we were given and
// leave with it. Without this a pi restart would leave an orphan holding the port forever.
const parentPid = Number(process.env.KANBAN_PARENT_PID ?? 0);
if (Number.isInteger(parentPid) && parentPid > 0) {
  const watch = setInterval(() => {
    try { process.kill(parentPid, 0); } catch { stop(); }
  }, 5000);
  watch.unref();
}
