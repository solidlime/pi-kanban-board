// Swap the live board over to v2: stop pi-web, move the v1 home aside, create a
// fresh v2 home, start pi-web again. Destructive by design and --yes gated; the v1
// home is MOVED (never deleted) so `mv` back is always a valid rollback.
//
//   node scripts/deploy-v2.mjs --yes [--home=<kanban home>] [--port=30141]
//                               [--pi-web=<bin/pi-web.js>] [--delay=20] [--no-restart]
import { registerHooks } from "node:module";
import { existsSync, openSync, writeSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

// src/**/*.ts is NodeNext ('./x.js'), which Node does not rewrite onto the sibling .ts.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js") && context.parentURL) {
      const url = new URL(specifier, context.parentURL);
      const asJs = fileURLToPath(url);
      const asTs = `${asJs.slice(0, -3)}.ts`;
      if (!existsSync(asJs) && existsSync(asTs)) return { url: pathToFileURL(asTs).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const yes = process.argv.includes("--yes");
const noRestart = process.argv.includes("--no-restart");
const home = arg("home", join(homedir(), ".pi", "kanban"));
const port = Number(arg("port", "30141"));
const delayMs = Number(arg("delay", "20")) * 1000;
const logPath = join(homedir(), ".pi", "kanban-deploy.log");
const piWeb = arg("pi-web", join(homedir(), ".pi", "pi-web", (await import("node:fs")).readFileSync(join(homedir(), ".pi", "pi-web", "current.txt"), "utf8").trim(), "node_modules", "@agegr", "pi-web", "bin", "pi-web.js"));
const startupBat = join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "pi-web.bat");

const fd = openSync(logPath, "a");
const log = (m) => { const line = `[${new Date().toISOString()}] ${m}\n`; try { writeSync(fd, line); } catch { /* log is best effort */ } console.log(m.trimEnd()); };

const portBusy = (p) => new Promise((res) => {
  const s = createServer();
  s.once("error", (e) => res(e.code === "EADDRINUSE"));
  s.listen(p, "0.0.0.0", () => s.close(() => res(false)));
});

if (!yes) {
  console.error("deploy-v2: pass --yes. This MOVES " + home + " aside and starts an empty v2 home.");
  process.exit(2);
}

log(`=== deploy v2 start (home=${home} port=${port} delay=${delayMs / 1000}s)`);
if (delayMs > 0) { log(`waiting ${delayMs / 1000}s so the caller can finish its turn`); await new Promise((r) => setTimeout(r, delayMs)); }

try {
  if (!noRestart) {
    log(`stopping pi-web on :${port}`);
    try { execFileSync(process.execPath, [piWeb, "stop", "--port", String(port)], { stdio: "pipe" }); }
    catch (e) { log("stop returned non-zero (already down?): " + (e instanceof Error ? e.message : String(e))); }
    for (let i = 0; i < 40; i++) {
      if (!(await portBusy(8789))) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (await portBusy(8789)) log("WARNING: :8789 is still busy; the v1 home move will likely fail");
  }

  const { planInit, executeInit } = await import("../src/persistence/init.ts");
  const plan = planInit(new Date(), home);
  log(`init: mode=backup backupDir=${plan.backupDir}`);
  const res = executeInit(plan, { confirmed: true, mode: "backup" });
  log(`init: moved=${JSON.stringify(res.moved)} created=${res.created.length} schema=${res.schemaVersion}`);
} catch (e) {
  log("FAILED: " + (e instanceof Error ? e.message : String(e)));
  log("rollback: mv '" + join(home, "..", "kanban.v1.bak-*") + "' back to " + home);
} finally {
  if (!noRestart) {
    log(`starting pi-web via ${startupBat}`);
    try { spawn("cmd.exe", ["/c", "start", "", startupBat], { detached: true, stdio: "ignore", windowsHide: true }).unref(); }
    catch (e) { log("start failed: " + (e instanceof Error ? e.message : String(e)) + " — run the startup bat by hand"); }
  }
  log("=== deploy v2 done; token: " + join(home, "token"));
  process.exit(0);
}
