// WIP is enforced at the DB door (repos.createCard / repos.moveCard), not in the routes, so
// every writer — HTTP, templates, the agent adapter — is held to it. Temp home; ~/.pi/kanban
// is never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import "./_ts-hooks.mjs";

const { executeInit, planInit } = await import("../../src/persistence/init.ts");
const { startServer } = await import("../../src/api/start.ts");

async function boot(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "kb-wip-"));
  const home = path.join(dir, ".pi", "kanban");
  await executeInit(planInit(new Date(), home), { confirmed: true });
  const run = await startServer({ home, port: 0 });
  t.after(() => run.close());
  const base = run.url.replace(/\/$/, "");
  const call = async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), authorization: `Bearer ${run.token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = JSON.parse(await res.text());
    return { status: res.status, data: json.data, error: json.error };
  };
  return { call };
}

test("a full column refuses a card from a template, not just from POST /api/cards", async (t) => {
  const { call } = await boot(t);
  await call("POST", "/api/projects", { slug: "tpl" });
  await call("PATCH", "/api/columns/tpl/doing", { wipLimit: 1 });

  const tpl = await call("POST", "/api/templates", { project: "tpl", name: "from tpl", title: "from tpl", columnId: "doing" });
  assert.equal(tpl.status, 201, JSON.stringify(tpl.error));

  const first = await call("POST", `/api/templates/tpl/${tpl.data.template.id}`);
  assert.equal(first.status, 201, "the first one fits the limit");
  assert.equal(first.data.card.columnId, "doing");

  const second = await call("POST", `/api/templates/tpl/${tpl.data.template.id}`);
  assert.equal(second.status, 409, "the second must hit the same WIP door");
  assert.equal(second.error.code, "WIP_LIMIT");
});

test("moving a card onto the column it already occupies is not a conflict", async (t) => {
  const { call } = await boot(t);
  await call("POST", "/api/projects", { slug: "noop" });
  const card = (await call("POST", "/api/cards", { project: "noop", title: "stay" })).data.card;

  const same = await call("POST", `/api/cards/noop/${card.id}/move`, { columnId: "todo", version: card.version });
  assert.equal(same.status, 200);
  assert.equal(same.data.card.version, card.version, "a no-op move must not bump the version");
  assert.equal(same.data.card.movedAt, card.movedAt, "and must not rewrite movedAt");

  // The stale version from the drag that started before is still valid, so the real move lands.
  const real = await call("POST", `/api/cards/noop/${card.id}/move`, { columnId: "doing", version: card.version });
  assert.equal(real.status, 200);
  assert.equal(real.data.card.columnId, "doing");
  assert.equal(real.data.card.version, card.version + 1);
});

test("a full column still refuses an ordinary create", async (t) => {
  const { call } = await boot(t);
  await call("POST", "/api/projects", { slug: "plain" });
  await call("PATCH", "/api/columns/plain/doing", { wipLimit: 0 });
  const res = await call("POST", "/api/cards", { project: "plain", title: "nope", columnId: "doing" });
  assert.equal(res.status, 409);
  assert.equal(res.error.code, "WIP_LIMIT");
});
