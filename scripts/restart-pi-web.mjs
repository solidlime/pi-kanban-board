// Restart pi-web so it reloads the kanban extension. The swap is the same dance as
// scripts/deploy-v2.mjs: stop, wait for the port to actually free, start detached with the
// flags the startup bat sets (that bat ends in `pause`, so it is not usable from a script).
import { readFileSync, openSync, writeSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const port = Number(process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? 30141);
const logPath = join(homedir(), ".pi", "kanban-deploy.log");
const fd = openSync(logPath, "a");
const log = (m) => { try { writeSync(fd, `[${new Date().toISOString()}] [restart] ${m}\n`); } catch { /* best effort */ } };
const busy = () => new Promise((res) => {
  const s = createServer();
  s.once("error", (e) => res(e.code === "EADDRINUSE"));
  s.listen(port, "0.0.0.0", () => s.close(() => res(false)));
});

const verDir = join(homedir(), ".pi", "pi-web");
const piWeb = join(verDir, readFileSync(join(verDir, "current.txt"), "utf8").trim(), "node_modules", "@agegr", "pi-web", "bin", "pi-web.js");

log(`stopping on :${port}`);
try { execFileSync(process.execPath, [piWeb, "stop", "--port", String(port)], { stdio: "pipe" }); }
catch (e) { log("stop said: " + (e instanceof Error ? e.message : String(e))); }
let free = false;
for (let i = 0; i < 60 && !free; i++) { free = !(await busy()); if (!free) await new Promise((r) => setTimeout(r, 500)); }
if (!free) { log(`FAILED: :${port} never freed — not starting a second server`); process.exit(1); }

const child = spawn(process.execPath, [piWeb, "-H", "0.0.0.0", "-p", String(port)], {
  detached: true,
  stdio: "ignore",
  windowsHide: true,
  env: { ...process.env, PI_WEB_ALLOWED_HOSTS: "nas,nas.local,7950x", PI_WEB_NO_OPEN: "1" },
});
child.unref();
log(`started pid=${child.pid ?? "?"} on :${port}`);

// Prove the reload landed: the board must now accept a request that carries BOTH a stale cookie
// and a good ?token= (before the fix the stale cookie won and answered 401).
const token = readFileSync(join(homedir(), ".pi", "kanban", "token"), "utf8").trim();
let verified = "not answered yet";
for (let i = 0; i < 40; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:8789/?token=${token}`, { headers: { cookie: "kb_auth=stale-cookie-selftest" } });
    const replaced = (res.headers.get("set-cookie") ?? "").includes(`kb_auth=${token}`);
    verified = res.status === 200 && replaced ? "ok (stale cookie no longer shadows the token)" : `FAILED status=${res.status} cookieReplaced=${replaced}`;
    break;
  } catch { await new Promise((r) => setTimeout(r, 500)); }
}
log("selftest: " + verified);
