// Waking a card: prompt shape, session id persistence, spawn arguments, and one child per
// board. A memory DB plus a fake spawn — no real `pi` process is ever started here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import "./_load.mjs";

// The session lock writes under $HOME/.pi/kanban and asks pi-web what is running, so both are
// sandboxed here: a temp home, and a fetch that always fails ("no pi-web, spawn pi yourself").
process.env.HOME = mkdtempSync(path.join(tmpdir(), "kb-driver-"));
const noPiWeb = async () => { throw new Error("ECONNREFUSED"); };

const { openDb } = await import("../../src/persistence/db.ts");
const { migrate } = await import("../../src/persistence/migrations.ts");
const repos = await import("../../src/persistence/repos.ts");
const { createProject, createCard, getCard } = repos;
const { buildCardPrompt, sessionCwd, wakeCardSession } = await import("../../src/agent/driver.ts");

function memDb(t) {
  const db = openDb(":memory:", { wal: false });
  migrate(db);
  t.after(() => db.close());
  return db;
}

/** A card in a doing column: that is the only column a wake is allowed to run. */
function board(db, slug, settings) {
  const project = createProject(db, { slug, settings });
  const card = createCard(db, { projectId: project.projectId, columnId: "doing", title: "配線を直す", body: "右パネルが落ちる" });
  return { project, card };
}

/** Fake child: exposes the surface driver.ts touches, never exits on its own. */
function fakeSpawn(pid = 4242) {
  const calls = [];
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.killed = false;
  child.stdout = { resume() {} };
  child.stderr = new EventEmitter();
  return { calls, child, spawn: (bin, args, opts) => { calls.push({ bin, args, opts }); return child; } };
}

/** A child that never started: node leaves pid undefined and reports the failure asynchronously. */
function deadSpawn(message = "spawn pi ENOENT") {
  const child = new EventEmitter();
  child.pid = undefined;
  child.stdout = { resume() {} };
  child.stderr = new EventEmitter();
  const spawn = () => {
    process.nextTick(() => child.emit("error", Object.assign(new Error(message), { code: "ENOENT" })));
    return child;
  };
  return { child, spawn };
}

const locksDir = () => path.join(process.env.HOME, ".pi", "kanban", "locks");
const lockFileOf = (sessionId) => path.join(locksDir(), `${sessionId}.lock`);

/** A pi-web that answers the running list and the wake POST; records every request body. */
function fakePiWeb(runningIds = [], mintedId = null) {
  const calls = [];
  const fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : null });
    if (u.endsWith("/api/agent/running")) return { ok: true, status: 200, json: async () => ({ runningSessionIds: runningIds }) };
    return { ok: true, status: 200, json: async () => ({ success: true, sessionId: mintedId }) };
  };
  return { calls, fetch };
}

/** A pi-web holding one session in a given state: the probe answers it, the wake POST succeeds. */
function fakePiWebState(state) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : null });
    if (init?.method === "POST") return { ok: true, status: 200, json: async () => ({ success: true }) };
    return { ok: true, status: 200, json: async () => state };
  };
  return { calls, fetch };
}

/** The shape of `GET /api/agent/<id>?systemPrompt=0`. */
/**
 * The shape of `GET /api/agent/<id>?systemPrompt=0`, as measured: the top level carries only
 * `running` and `state`, and the counters (`pendingMessageCount`, `queuedMessages`) are inside
 * `state`. Putting them on the top level here would bake in a shape pi-web never sends.
 */
const agentState = (state, pendingMessageCount = 0) => ({
  running: true,
  state: { queuedMessages: { steering: [], followUp: [] }, ...state, pendingMessageCount },
});
const idleAgent = () => agentState({ isStreaming: false, isPromptRunning: false, isCompacting: false });
/** Every request the wake actually sent, i.e. not the probe. */
const posts = (calls) => calls.filter((c) => c.method === "POST");

/** A doing card already pointing at a session, the way a second wake finds it. */
function withSession(db, slug, sid) {
  const { project, card } = board(db, slug);
  repos.updateCard(db, project.projectId, card.id, { sessionId: sid }, { actor: "test" });
  return { project, card: getCard(db, project.projectId, card.id) };
}

test("buildCardPrompt names the board, the card, its title and the done step", (t) => {
  const db = memDb(t);
  const project = createProject(db, { slug: "prompt-board" });
  const card = createCard(db, {
    projectId: project.projectId, columnId: "todo", title: "配線を直す",
    body: "右パネルが落ちる\n- [ ] タブが切り替わる",
  });
  const prompt = buildCardPrompt(project, card);
  assert.ok(prompt.startsWith(`[kanban ${project.slug}#${card.id}]`), "the card's origin leads the message");
  for (const needle of [
    "prompt-board", "1", "配線を直す", "右パネルが落ちる", "タブが切り替わる", "done",
    // A queued prompt can outlive the card: the session has to check before it works.
    "doing に居るか確認", "TODO に戻してください",
  ]) {
    assert.ok(prompt.includes(needle), `prompt is missing "${needle}"`);
  }
  assert.ok(prompt.split("\n").length <= 20, "prompt stays short");
});

test("wakeCardSession mints a UUID session id and stores it on the card", async (t) => {
  const db = memDb(t);
  const { project, card } = board(db, "uuid-board");
  const { spawn } = fakeSpawn();
  const out = await wakeCardSession(db, project, card, { spawn, fetch: noPiWeb });
  assert.match(out.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(getCard(db, project.projectId, card.id).sessionId, out.sessionId);
});

test("spawn gets -p, the session id, a name and the board cwd", async (t) => {
  const db = memDb(t);
  const { project, card } = board(db, "args-board", { cwd: "/tmp/kb-args" });
  const { calls, spawn } = fakeSpawn();
  const out = await wakeCardSession(db, project, card, { spawn, fetch: noPiWeb });

  assert.equal(calls.length, 1);
  assert.equal(out.via, "pi");
  const { bin, args, opts } = calls[0];
  assert.equal(bin, "pi");
  assert.equal(args[0], "-p");
  assert.ok(args.includes("--session-id") && args.includes(out.sessionId), "--session-id <uuid>");
  assert.equal(args[args.indexOf("--name") + 1], "kanban #1");
  assert.equal(opts.cwd, "/tmp/kb-args");
  assert.deepEqual(opts.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(sessionCwd(project), "/tmp/kb-args");
  assert.equal(sessionCwd({ ...project, settings: {} }), process.cwd());
});

test("an existing card session is resumed with --session, not re-minted", async (t) => {
  const db = memDb(t);
  const { project, card } = board(db, "resume-board");
  const sid = "b7c1d2e3-1111-2222-3333-444455556666";
  const { updateCard } = repos;
  updateCard(db, project.projectId, card.id, { sessionId: sid }, { actor: "test" });
  const stored = getCard(db, project.projectId, card.id);
  const { calls, spawn } = fakeSpawn();
  const out = await wakeCardSession(db, project, stored, { spawn, fetch: noPiWeb });

  assert.equal(out.sessionId, sid, "the card's own session id is reused");
  const { args } = calls[0];
  assert.equal(args[args.indexOf("--session") + 1], sid);
  assert.equal(args.includes("--session-id"), false, "--session and --session-id cannot be combined");
  assert.equal(args.includes("--name"), false, "a resumed session keeps its existing name");
  assert.equal(getCard(db, project.projectId, card.id).sessionId, sid);
});

test("a second wake on the same board is refused while the child is alive", async (t) => {
  const db = memDb(t);
  const { project, card } = board(db, "busy-board");
  const { calls, spawn } = fakeSpawn();
  const first = await wakeCardSession(db, project, card, { spawn, fetch: noPiWeb });
  assert.equal(first.via, "pi");
  // in-flight is its own reason: the supervisor retries it like busy, not after WAKE_RETRY_MS.
  assert.deepEqual(await wakeCardSession(db, project, card, { spawn, fetch: noPiWeb }), { refused: "in-flight" });
  assert.equal(calls.length, 1, "no second process");
});

test("an existing card session is handed to pi-web and no process is spawned", async (t) => {
  const db = memDb(t);
  const { project, card } = board(db, "piweb-existing");
  const sid = "c1d2e3f4-1111-2222-3333-444455556666";
  repos.updateCard(db, project.projectId, card.id, { sessionId: sid }, { actor: "test" });
  const stored = getCard(db, project.projectId, card.id);
  const { calls: spawned, spawn } = fakeSpawn();
  const { calls, fetch } = fakePiWeb([], null);

  const out = await wakeCardSession(db, project, stored, { spawn, fetch });

  assert.equal(out.via, "pi-web");
  assert.equal(out.sessionId, sid, "pi-web resumed the card's own session");
  assert.equal(spawned.length, 0, "pi-web took it, so pi is not spawned");
  // pi-web forwards the body to the session as an RPC command: `prompt` is what starts a turn.
  const post = calls.find(c => c.url.endsWith(`/api/agent/${sid}`));
  assert.equal(post.body.type, "prompt");
  assert.equal(post.body.cwd, undefined, "an existing session keeps its own cwd");
  assert.ok(post.body.message.includes("カードを実装してください"));
  assert.ok(
    post.body.message.startsWith(`[kanban ${project.slug}#${card.id}]`),
    "pi-web receives the same tagged message the pi fallback gets",
  );
});

test("a session pi-web already runs still receives the prompt", async (t) => {
  const db = memDb(t);
  const { project, card } = board(db, "piweb-live");
  const sid = "d1e2f3a4-1111-2222-3333-444455556666";
  repos.updateCard(db, project.projectId, card.id, { sessionId: sid }, { actor: "test" });
  const stored = getCard(db, project.projectId, card.id);
  const { calls: spawned, spawn } = fakeSpawn();
  // The card points at a session pi-web is running right now (the user's own session).
  const { calls, fetch } = fakePiWeb([sid], null);

  const out = await wakeCardSession(db, project, stored, { spawn, fetch });

  assert.equal(out?.via, "pi-web", "a live session is woken, not mistaken for a second writer");
  assert.equal(out?.sessionId, sid);
  assert.equal(spawned.length, 0, "pi-web owns the run");
  const post = calls.find(c => c.url.endsWith(`/api/agent/${sid}`));
  assert.equal(post.body.type, "prompt", "the prompt reaches the live session");
});

test("a pi-web 404 is a refusal, not an absence: no process is spawned", async (t) => {
  const db = memDb(t);
  const { project, card } = board(db, "piweb-404");
  const sid = "aa11bb22-1111-2222-3333-444455556666";
  repos.updateCard(db, project.projectId, card.id, { sessionId: sid }, { actor: "test" });
  const stored = getCard(db, project.projectId, card.id);
  const { calls: spawned, spawn } = fakeSpawn();
  // pi-web is up and knows nothing of this session: spawning pi would open a JSONL pi-web is
  // about to refuse, so the wake claims nothing.
  const notFound = async () => ({ ok: false, status: 404, json: async () => ({ error: "Session not found" }) });

  const out = await wakeCardSession(db, project, stored, { spawn, fetch: notFound });

  assert.deepEqual(out, { refused: "unclear" });
  assert.equal(spawned.length, 0, "a 4xx is not a fallback");
});

test("a 200 with success:false is not delivery", async (t) => {
  const db = memDb(t);
  const { project, card } = board(db, "piweb-soft-no");
  const sid = "bb22cc33-1111-2222-3333-444455556666";
  repos.updateCard(db, project.projectId, card.id, { sessionId: sid }, { actor: "test" });
  const stored = getCard(db, project.projectId, card.id);
  const { calls: spawned, spawn } = fakeSpawn();
  const softNo = async () => ({ ok: true, status: 200, json: async () => ({ success: false, error: "busy" }) });

  const out = await wakeCardSession(db, project, stored, { spawn, fetch: softNo });

  assert.deepEqual(out, { refused: "unclear" }, "pi-web answered but rejected the prompt");
  assert.equal(spawned.length, 0, "and a second writer is not started");
});

test("a 200 with an unreadable body is still delivery", async (t) => {
  const db = memDb(t);
  const { project, card } = board(db, "piweb-opaque");
  const sid = "cc33dd44-1111-2222-3333-444455556666";
  repos.updateCard(db, project.projectId, card.id, { sessionId: sid }, { actor: "test" });
  const stored = getCard(db, project.projectId, card.id);
  const { calls: spawned, spawn } = fakeSpawn();
  // A proxy or a 204 answers 2xx without JSON. Reading that as "pi-web is gone" would put a
  // second writer on the session it just accepted.
  const opaque = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token O"); } });

  const out = await wakeCardSession(db, project, stored, { spawn, fetch: opaque });

  assert.equal(out?.via, "pi-web");
  assert.equal(spawned.length, 0, "2xx means taken, whatever the body looks like");
});

test("pi-web down and the session locked elsewhere: no process is spawned", async (t) => {
  const db = memDb(t);
  const { project, card } = board(db, "piweb-down-locked");
  const sid = "e1f2a3b4-1111-2222-3333-444455556666";
  repos.updateCard(db, project.projectId, card.id, { sessionId: sid }, { actor: "test" });
  const stored = getCard(db, project.projectId, card.id);
  // Another live process holds the lock: pi would append to a JSONL someone else is writing.
  const dir = path.join(process.env.HOME, ".pi", "kanban", "locks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${sid}.lock`), String(process.pid));
  const { calls: spawned, spawn } = fakeSpawn();

  const out = await wakeCardSession(db, project, stored, { spawn, fetch: noPiWeb });

  assert.deepEqual(out, { refused: "locked" }, "the lock still guards the pi path");
  assert.equal(spawned.length, 0);
});

test("a new card takes the session id pi-web minted and stores it", async (t) => {
  const db = memDb(t);
  const { project, card } = board(db, "piweb-new", { cwd: "/tmp/kb-piweb" });
  const { calls: spawned, spawn } = fakeSpawn();
  const minted = "9f8e7d6c-1111-2222-3333-444455556666";
  const { calls, fetch } = fakePiWeb([], minted);

  const out = await wakeCardSession(db, project, card, { spawn, fetch });

  assert.equal(out.via, "pi-web");
  assert.equal(out.sessionId, minted);
  assert.equal(spawned.length, 0);
  assert.equal(getCard(db, project.projectId, card.id).sessionId, minted, "the card remembers pi-web's id");
  const post = calls.find(c => c.url.endsWith("/api/agent/new"));
  assert.equal(post.body.type, "prompt");
  assert.equal(post.body.cwd, "/tmp/kb-piweb");
  assert.equal(post.body.sessionId, undefined, "pi-web mints the id; we do not pass one");
});

test("a new session answered without an id is not a wake", async (t) => {
  const db = memDb(t);
  const { project, card } = board(db, "piweb-no-id", { cwd: "/tmp/kb-piweb-no-id" });
  const { calls: spawned, spawn } = fakeSpawn();
  // Without the minted id the card never learns its session and the next tick opens a second one.
  const noId = async (url) => String(url).endsWith("/api/agent/running")
    ? { ok: true, status: 200, json: async () => ({ runningSessionIds: [] }) }
    : { ok: true, status: 200, json: async () => ({ success: true, data: null }) };

  const out = await wakeCardSession(db, project, card, { spawn, fetch: noId });

  assert.deepEqual(out, { refused: "unclear" });
  assert.equal(getCard(db, project.projectId, card.id).sessionId, null, "no id, nothing to point at");
  assert.equal(spawned.length, 0);
});

test("a 500 that names the prompt as rejected is a refusal, not an absence", async (t) => {
  const db = memDb(t);
  const { project, card } = board(db, "piweb-busy");
  const sid = "ff11aa22-1111-2222-3333-444455556666";
  repos.updateCard(db, project.projectId, card.id, { sessionId: sid }, { actor: "test" });
  const stored = getCard(db, project.projectId, card.id);
  const { calls: spawned, spawn } = fakeSpawn();
  // pi-web answers 500 while a turn is running: alive, knows the session, refused this prompt.
  const busy = async () => ({ ok: false, status: 500, json: async () => ({ error: "Agent is already processing.", code: "prompt_rejected", accepted: false }) });

  const out = await wakeCardSession(db, project, stored, { spawn, fetch: busy });

  assert.deepEqual(out, { refused: "unclear" });
  assert.equal(spawned.length, 0, "a refused prompt is not a reason to spawn a second writer");
});

// #26: a wake is injected only into a session that has stopped. Busy is a positive answer from
// `GET /api/agent/<id>?systemPrompt=0`; anything the probe cannot answer is `unknown`, and the POST
// itself is then the test — pi refuses a prompt on a running session, so a race is never queued.
test("streaming なセッションには POST を出さずに busy を返す", async (t) => {
  const db = memDb(t);
  const sid = "a1b2c3d4-1111-2222-3333-444455556666";
  const { project, card } = withSession(db, "probe-streaming", sid);
  const { calls, fetch } = fakePiWebState(agentState({ isStreaming: true, isPromptRunning: false, isCompacting: false }));

  const out = await wakeCardSession(db, project, card, { spawn: fakeSpawn().spawn, fetch });

  assert.deepEqual(out, { refused: "busy" });
  assert.equal(posts(calls).length, 0, "the turn is not queued behind");
  assert.ok(calls[0].url.includes(`/api/agent/${sid}?systemPrompt=0`), "the probe answers cheaply, before the POST");
});

test("busy はどのシグナルでも拾う: isCompacting / isPromptRunning / pendingMessageCount", async (t) => {  const db = memDb(t);
  const signals = {
    isCompacting: agentState({ isStreaming: false, isPromptRunning: false, isCompacting: true }),
    // isStreaming と isPromptRunning は実測で独立している: 片方だけ見ると busy を取りこぼす。
    isPromptRunning: agentState({ isStreaming: false, isPromptRunning: true, isCompacting: false }),
    // 積まれた分は必ず実行されるので、二重積みは同じカードの 2 回目の実行になる。
    pendingMessageCount: agentState({ isStreaming: false, isPromptRunning: false, isCompacting: false }, 2),
  };
  for (const [name, state] of Object.entries(signals)) {
    const { project, card } = withSession(db, `probe-${name}`, "b2c3d4e5-1111-2222-3333-444455556666");
    const { calls, fetch } = fakePiWebState(state);
    assert.deepEqual(await wakeCardSession(db, project, card, { spawn: fakeSpawn().spawn, fetch }), { refused: "busy" }, name);
    assert.equal(posts(calls).length, 0, `${name}: nothing is queued`);
  }
});

// The measured body of a session that already has a wake queued (nous#44): fed verbatim, so a
// probe that reads the counter off the top level is caught here instead of in production.
test("実測 body（state 内に pendingMessageCount）をそのまま食わせても busy", async (t) => {
  const db = memDb(t);
  const sid = "a2b3c4d5-1111-2222-3333-444455556666";
  const { project, card } = withSession(db, "probe-measured", sid);
  const measured = {
    running: true,
    state: {
      isStreaming: true, isPromptRunning: false, isCompacting: false, isBashRunning: false,
      pendingMessageCount: 5,
      queuedMessages: { steering: [], followUp: ["[kanban nous#44] …", "[kanban nous#44] …"] },
      messageCount: 0, thinkingLevel: "max",
    },
  };
  const { calls, fetch } = fakePiWebState(measured);

  assert.deepEqual(await wakeCardSession(db, project, card, { spawn: fakeSpawn().spawn, fetch }), { refused: "busy" });
  assert.equal(posts(calls).length, 0, "a queued wake is not stacked a second time");
});

test("判定できない probe は busy にしない: 不明 = POST を試す", async (t) => {
  const db = memDb(t);
  const probes = {
    "500": async () => ({ ok: false, status: 500, json: async () => ({}) }),
    "非 JSON": async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } }),
    ECONNREFUSED: async () => { throw new Error("ECONNREFUSED"); },
    timeout: async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); },
  };
  for (const [name, probe] of Object.entries(probes)) {
    const { project, card } = withSession(db, `probe-unknown-${name}`, "c3d4e5f6-1111-2222-3333-444455556666");
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url: String(url), method: init?.method ?? "GET" });
      if (init?.method !== "POST") return probe();
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    };
    const out = await wakeCardSession(db, project, card, { spawn: fakeSpawn().spawn, fetch });
    assert.equal(out?.via, "pi-web", `${name}: an unreadable probe still delivers`);
    assert.equal(posts(calls).length, 1, `${name}: the POST was tried`);
  }
});

test("idle なセッションへの POST に streamingBehavior は無い", async (t) => {
  const db = memDb(t);
  const sid = "d4e5f6a7-1111-2222-3333-444455556666";
  const { project, card } = withSession(db, "probe-idle", sid);
  const { calls, fetch } = fakePiWebState(idleAgent());

  const out = await wakeCardSession(db, project, card, { spawn: fakeSpawn().spawn, fetch });

  assert.equal(out?.via, "pi-web");
  const post = posts(calls).find(c => c.url.endsWith(`/api/agent/${sid}`));
  assert.equal(post.body.type, "prompt");
  assert.equal("streamingBehavior" in post.body, false, "followUp is what queued a wake behind a long turn");
});

test("pi-web で開いているだけの idle セッション（running:true / フラグ無し）には配送する", async (t) => {
  const db = memDb(t);
  const sid = "e5f6a7b8-1111-2222-3333-444455556666";
  const { project, card } = withSession(db, "probe-open-idle", sid);
  const { calls, fetch } = fakePiWebState(idleAgent());

  const out = await wakeCardSession(db, project, card, { spawn: fakeSpawn().spawn, fetch });

  assert.equal(out?.via, "pi-web", "running:true alone is not busy");
  assert.equal(posts(calls).length, 1);
});

test("新しいセッションは probe しない（問い合わせ先がまだ無い）", async (t) => {
  const db = memDb(t);
  const { project, card } = board(db, "probe-new", { cwd: "/tmp/kb-probe-new" });
  const { calls, fetch } = fakePiWeb([], "f6a7b8c9-1111-2222-3333-444455556666");

  const out = await wakeCardSession(db, project, card, { spawn: fakeSpawn().spawn, fetch });

  assert.equal(out?.via, "pi-web");
  assert.equal(calls.filter(c => c.url.includes("systemPrompt=0")).length, 0, "nothing to ask about yet");
});

test("two concurrent wakes start one session, not two", async (t) => {
  const db = memDb(t);
  const { project, card } = board(db, "race-board");
  const { spawn } = fakeSpawn();
  const { calls, fetch } = fakePiWeb([], "piweb-race");

  const both = await Promise.all([
    wakeCardSession(db, project, card, { spawn, fetch }),
    wakeCardSession(db, project, card, { spawn, fetch }),
  ]);

  assert.equal(both.filter(x => x?.refused === undefined).length, 1, "one caller wins, the other is refused");
  assert.equal(calls.filter(c => c.url.endsWith("/api/agent/new")).length, 1, "one session requested");
});

test("a pi-web timeout is not a refusal: pi is not spawned on top of it", async (t) => {
  const db = memDb(t);
  const { project, card } = board(db, "piweb-slow");
  const { calls: spawned, spawn } = fakeSpawn();
  // undici rejects a timed-out fetch with a DOMException named TimeoutError.
  const slow = async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); };

  const out = await wakeCardSession(db, project, card, { spawn, fetch: slow });

  assert.deepEqual(out, { refused: "unclear" }, "we do not know whether pi-web started it, so we claim nothing");
  assert.equal(spawned.length, 0, "a second writer would corrupt the JSONL");
});

test("a refused pi-web connection falls back to spawning pi", async (t) => {
  const db = memDb(t);
  const { project, card } = board(db, "piweb-down");
  const { calls: spawned, spawn } = fakeSpawn();

  const out = await wakeCardSession(db, project, card, { spawn, fetch: noPiWeb });

  assert.equal(out.via, "pi");
  assert.equal(spawned.length, 1, "nobody else is writing: pi takes it");
});

test("a spawn that fails with ENOENT wakes nothing and writes no session id", async (t) => {
  const db = memDb(t);
  const { project, card } = board(db, "spawn-enoent");
  const { spawn } = deadSpawn();
  const locksBefore = existsSync(locksDir()) ? readdirSync(locksDir()).sort() : [];

  const out = await wakeCardSession(db, project, card, { spawn, fetch: noPiWeb });

  assert.deepEqual(out, { refused: "spawn-failed" }, "a process that never started is not a wake");
  assert.equal(getCard(db, project.projectId, card.id).sessionId, null,
    "the card must not point at a session nobody started");
  assert.deepEqual(existsSync(locksDir()) ? readdirSync(locksDir()).sort() : [], locksBefore,
    "the lock is released, not left as debris");
});

test("error の後に exit が来ても release は1回だけ（他人のロックを消さない）", async (t) => {
  const db = memDb(t);
  const { project, card } = board(db, "double-release");
  const { child, spawn } = fakeSpawn();
  const out = await wakeCardSession(db, project, card, { spawn, fetch: noPiWeb });
  assert.ok(out);
  const lockFile = lockFileOf(out.sessionId);
  assert.equal(existsSync(lockFile), true, "the pi path holds the lock");

  child.emit("error", new Error("boom"));
  assert.equal(existsSync(lockFile), false, "the error event releases it");
  // A later wake claimed the lock between the two events.
  writeFileSync(lockFile, String(process.pid));
  child.emit("exit", 1, null);

  assert.equal(readFileSync(lockFile, "utf8"), String(process.pid), "a second release must not delete a lock that is not ours");
});

test("a stale running entry does not block the board forever", async (t) => {
  const db = memDb(t);
  const { project, card } = board(db, "ttl-board");
  const { calls, child, spawn } = fakeSpawn(process.pid + 900000); // a pid nobody has
  const later = () => Date.now() + 61 * 60 * 1000;
  assert.notEqual(await wakeCardSession(db, project, card, { spawn, fetch: noPiWeb }), null);

  assert.deepEqual(await wakeCardSession(db, project, card, { spawn, fetch: noPiWeb, now: Date.now }), { refused: "in-flight" },
    "a child we believe is alive still owns the board");
  assert.deepEqual(await wakeCardSession(db, project, card, { spawn, fetch: noPiWeb, now: later }), { refused: "in-flight" },
    "an hour old but alive is never dropped (no turn is killed)");
  assert.equal(calls.length, 1);

  child.exitCode = 1; // the exit event was lost; the entry is a leftover
  assert.notEqual(await wakeCardSession(db, project, card, { spawn, fetch: noPiWeb, now: later }), null,
    "a stale dead entry is swept, so the board can wake again");
  assert.equal(calls.length, 2);
});

test("a card outside a doing column is not woken", async (t) => {
  const db = memDb(t);
  const project = createProject(db, { slug: "gate-board" });
  const todoCard = createCard(db, { projectId: project.projectId, columnId: "todo", title: "まだやらない" });
  const doneCard = createCard(db, { projectId: project.projectId, columnId: "done", title: "もう終わった" });
  const { calls, spawn } = fakeSpawn();

  assert.deepEqual(await wakeCardSession(db, project, todoCard, { spawn, fetch: noPiWeb }), { refused: "not-doing" });
  assert.deepEqual(await wakeCardSession(db, project, doneCard, { spawn, fetch: noPiWeb }), { refused: "not-doing" });
  assert.equal(calls.length, 0, "no process for a card nobody asked to run");
});

test("a snapshot that says doing is refused once the card is done", async (t) => {
  const db = memDb(t);
  const { project, card } = board(db, "gate-moved");
  const { calls, spawn } = fakeSpawn();
  // The queue holds an old copy of the card; the board is what counts.
  repos.moveCard(db, project.projectId, card.id, "done", { actor: "test" });

  assert.deepEqual(await wakeCardSession(db, project, card, { spawn, fetch: noPiWeb }), { refused: "not-doing" },
    "a stale snapshot is not a licence to run a closed card");
  assert.equal(calls.length, 0);
});

test("forgetCard frees the board once its card is gone", async (t) => {
  const db = memDb(t);
  const project = createProject(db, { slug: "forget-board" });
  const first = createCard(db, { projectId: project.projectId, columnId: "doing", title: "消える" });
  const { calls, child, spawn } = fakeSpawn(process.pid + 800001);
  const out = await wakeCardSession(db, project, first, { spawn, fetch: noPiWeb });
  assert.ok(out);
  const { runningWakes, forgetCard } = await import("../../src/agent/driver.ts");
  // The map is process-wide and earlier tests in this file leave their fake children in it.
  const mine = () => runningWakes().filter((e) => e.projectId === project.projectId);
  assert.deepEqual(mine().map((e) => [e.cardId, e.pid]), [[first.id, child.pid]],
    "the process says which card it believes it is running");

  // DOING takes one card, so the next one can only arrive after the first has left it.
  repos.moveCard(db, project.projectId, first.id, "done", { actor: "test" });
  const second = createCard(db, { projectId: project.projectId, columnId: "doing", title: "次" });
  assert.deepEqual(await wakeCardSession(db, project, second, { spawn, fetch: noPiWeb }), { refused: "in-flight" },
    "the board still believes the first child owns it");
  forgetCard(project.projectId, first.id + 999);
  assert.deepEqual(await wakeCardSession(db, project, second, { spawn, fetch: noPiWeb }), { refused: "in-flight" },
    "forgetting a different card changes nothing");
  assert.equal(calls.length, 1, "no second process yet");

  forgetCard(project.projectId, first.id);
  assert.deepEqual(mine(), [], "the forgotten card is no longer claimed");
  const woken = await wakeCardSession(db, project, second, { spawn, fetch: noPiWeb });
  assert.equal(woken?.via, "pi", "once the stale entry is gone the next card runs");
  assert.equal(calls.length, 2);
});

test("forgetProject frees the board without a card to match", async (t) => {
  const db = memDb(t);
  const project = createProject(db, { slug: "forget-project" });
  const card = createCard(db, { projectId: project.projectId, columnId: "doing", title: "消える板" });
  const { spawn } = fakeSpawn(process.pid + 800002);
  assert.ok(await wakeCardSession(db, project, card, { spawn, fetch: noPiWeb }));
  const { runningWakes, forgetProject } = await import("../../src/agent/driver.ts");
  const mine = () => runningWakes().filter((e) => e.projectId === project.projectId);
  assert.equal(mine().length, 1, "the board owns the wake");

  forgetProject("some-other-board");
  assert.equal(mine().length, 1, "another board's entry is not touched");

  // The board and its cards are gone together, so nothing about the card id can matter here.
  forgetProject(project.projectId);
  assert.deepEqual(mine(), []);

  // The slug may come back as a fresh board; a leftover entry would still refuse its wakes.
  repos.deleteProject(db, project.projectId, "test");
  const again = createProject(db, { slug: "forget-project" });
  const fresh = createCard(db, { projectId: again.projectId, columnId: "doing", title: "新世代" });
  const woken = await wakeCardSession(db, again, fresh, { spawn, fetch: noPiWeb });
  assert.equal(woken?.via, "pi", "the recreated board wakes its own card");
});
