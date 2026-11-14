// Real v2 server on port 0 against a throwaway home: ~/.pi/kanban is never touched.
// Import the caller's `_ts-hooks.mjs` first, then import this module (its top-level
// imports of src/*.ts need the .js → .ts hook already registered).
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function startTestServer(t, prefix = "kb-") {
  const { executeInit, planInit } = await import("../../src/persistence/init.ts");
  const { startServer } = await import("../../src/api/start.ts");
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  const home = path.join(dir, ".pi", "kanban");
  await executeInit(planInit(new Date(), home), { confirmed: true });
  const run = await startServer({ home, port: 0 });
  t.after(() => run.close());
  const base = run.url.replace(/\/$/, "");
  const auth = { authorization: `Bearer ${run.token}` };

  const call = async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...auth },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, data: json?.data, headers: res.headers };
  };

  return { run, home, base, call };
}
