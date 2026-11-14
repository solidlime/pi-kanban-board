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

const home = process.env.KANBAN_HOME;
// Cross-board loop heartbeat. 0 disables it; any other number is the interval in ms.
const loopMs = Number(process.env.KANBAN_LOOP_MS ?? 15000);
const run = await startServer({ ...(home ? { home } : {}), loop: Number.isFinite(loopMs) && loopMs > 0 ? { intervalMs: loopMs } : false });

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
