// E2E harness: temp home/DB, real HTTP server on port 0. No ~/.pi/kanban touched.
import "../integration/_ts-hooks.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const { executeInit, planInit, detectState } = await import("../../src/persistence/init.ts");
const { startServer } = await import("../../src/api/start.ts");

export async function tempHome(prefix = "kb-e2e-") {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  return path.join(dir, ".pi", "kanban");
}

export async function setupServer(t, { init = true } = {}) {
  const home = await tempHome();
  if (init) await executeInit(planInit(new Date(), home), { confirmed: true });
  const srv = await startServer({ home, host: "127.0.0.1", port: 0, auth: true });
  const base = `http://127.0.0.1:${srv.port}`;
  const token = srv.token;
  t.after(async () => { try { await srv.close(); } catch {} try { await rm(path.dirname(path.dirname(home)), { recursive: true, force: true }); } catch {} });
  async function req(method, p, body, { auth = token, raw = false } = {}) {
    const headers = { ...(body !== undefined ? {"content-type":"application/json"} : {}), ...(auth ? {authorization: `Bearer ${auth}`} : {}) };
    const res = await fetch(base + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return raw ? res : { status: res.status, headers: res.headers, json, text };
  }
  return { home, srv, base, token, req };
}

export { detectState, planInit, executeInit };
