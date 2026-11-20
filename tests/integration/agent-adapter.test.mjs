// W3F: the v2 sgent sdspter (extensions/ksnban-v2.ts + src/agent/adapter.ts).
// Temp home only — ~/.pi/kanban is never touched.
import "./_ts-hooks.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const { executeInit, planInit } = await import("../../src/persistence/init.ts");

const root = await mkdtemp(path.join(tmpdir(), "kb-adapter-"));
const home = path.join(root, ".pi", "kanban");
await executeInit(planInit(new Date(), home), { confirmed: true });
process.env.KANBAN_HOME = home;
// A real free port: the server now runs as its own process, so a KANBAN_PORT of 0 would make
// the URL we poll (`:0`) unreachable. Same dance as tests/kanban-auto-tick.test.mjs.
process.env.KANBAN_PORT = String(
  await new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  }),
);

const A = await import("../../src/agent/adapter.ts");

// A cwd that is not a git repo: the project is its own basename.
const cwd = path.join(root, "demo-repo");
await mkdtemp(cwd + "-"); // creates tmp dir only; make the real one below
await (await import("node:fs/promises")).mkdir(cwd, { recursive: true });
const env = { cwd, actor: "test" };
const slug = A.projectSlugOf(cwd);
// A real 1x1 PNG: the media store sniffs magic bytes, so a fake extension is not enough.
const pngPathForTest = path.join(root, "assets", "deliverable.png");
await (await import("node:fs/promises")).mkdir(path.join(root, "assets"), { recursive: true });
await (await import("node:fs/promises")).writeFile(pngPathForTest, Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"));

after(async () => {
  await A.closeRuntime();
  await rm(root, { recursive: true, force: true });
});

test("slug: a directory name normalizes, an empty one falls back", () => {
  assert.equal(A.normalizeSlug("My App/Ünïcode!"), "my-app-u-ni-code");
  assert.equal(A.normalizeSlug("__"), ""); // an unusable name normalizes to nothing...
  assert.equal(A.projectSlugOf(path.join(root, "__")), "inbox"); // ...and the board falls back
  assert.equal(A.projectSlugOf(cwd), "demo-repo");
});

test("kanban add: #slug retargets the board and seeds nextId from it", async () => {
  const add = await A.executeKanban({ action: "add", text: "#side !3 due:2026-03-04 横断" }, env);
  assert.equal(add.ok, true, add.text);
  assert.match(add.text, /project side/);
  const card = add.details.cards.find((c) => c.title === "横断");
  assert.equal(card.projectId, "side");
  assert.equal(card.estimate, 3);
  assert.equal(card.due, "2026-03-04");
  assert.equal(add.details.nextId, 2); // the target board's next id, not the caller's
  // A second add that names an existing board does not create it twice.
  assert.equal((await A.executeKanban({ action: "add", text: "#side 二枚目" }, env)).ok, true);
  const listed = await A.executeKanban({ action: "list", project: "side" }, env);
  assert.match(listed.text, /#2 二枚目/);
  assert.equal((await A.executeKanban({ action: "add", text: "#Bad_Slug x" }, env)).ok, false);});

test("kanban: a first write creates the board, add -> list -> move -> edit", async () => {
  const add = await A.executeKanban({ action: "add", text: "first card" }, env);
  assert.equal(add.ok, true, add.text);
  assert.match(add.text, /added #1/);
  assert.equal(add.details.nextId, 2);

  const list = await A.executeKanban({ action: "list" }, env);
  assert.match(list.text, new RegExp(`\\[project ${slug}\\]`));
  assert.match(list.text, /#1 first card/);

  assert.equal((await A.executeKanban({ action: "move", id: 1, col: "doing" }, env)).ok, true);
  assert.match((await A.executeKanban({ action: "list" }, env)).text, /DOING #1 first card/);

  const edit = await A.executeKanban(
    { action: "edit", id: 1, text: "renamed", priority: 5, labels: "a, b", blocked: "waiting", session: "s-1", commit: "ABC1234" },
    env,
  );
  assert.equal(edit.ok, true, edit.text);
  const card = edit.details.cards.find((c) => c.id === 1);
  assert.equal(card.title, "renamed");
  assert.equal(card.priority, 5);
  assert.deepEqual(card.labels, ["a", "b"]);
  assert.equal(card.blockedReason, "waiting");
  assert.equal(card.sessionId, "s-1");
  assert.equal(card.commit, "abc1234");

  // blocked:false clears it
  const unblocked = await A.executeKanban({ action: "edit", id: 1, blocked: false }, env);
  assert.equal(unblocked.details.cards.find((c) => c.id === 1).blockedReason, null);
});

test("kanban: a card added from a pi session links to it, and an edit leaves it alone", async () => {
  const linked = { ...env, sessionId: "0a1b2c3d-0000-4000-8000-000000000000" };
  const added = await A.executeKanban({ action: "add", text: "wake me from here" }, linked);
  assert.equal(added.ok, true, added.text);
  const id = added.details.nextId - 1;
  assert.equal(added.details.cards.find((c) => c.id === id).sessionId, linked.sessionId, "env session id names the card's session");

  // The cwd alone carries no session: an add there stays unlinked.
  const plain = await A.executeKanban({ action: "add", text: "no session here" }, env);
  assert.equal(plain.details.cards.find((c) => c.id === plain.details.nextId - 1).sessionId, null);

  // edit without `session` must not overwrite the id the card already has.
  const edited = await A.executeKanban({ action: "edit", id, text: "renamed again" }, linked);
  assert.equal(edited.details.cards.find((c) => c.id === id).sessionId, linked.sessionId);
  const relinked = await A.executeKanban({ action: "edit", id, session: "s-explicit" }, linked);
  assert.equal(relinked.details.cards.find((c) => c.id === id).sessionId, "s-explicit");
});

test("kanban: a long text keeps everything (head -> title, whole text -> body)", async () => {
  const long = `${"x".repeat(600)} tail`;
  const out = await A.executeKanban({ action: "add", text: long }, env);
  const card = out.details.cards.find((c) => c.id === out.details.nextId - 1);
  assert.equal(card.title.length, 500);
  assert.equal(card.body, long);
});

test("kanban: nextFireAt becomes the due DATE; +1d is tomorrow", async () => {
  const out = await A.executeKanban({ action: "add", text: "scheduled", nextFireAt: "+1d" }, env);
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const card = out.details.cards.find((c) => c.text?.includes("scheduled") || c.title === "scheduled");
  assert.equal(card.due, tomorrow);
  await assert.rejects(
    () => A.executeKanban({ action: "add", text: "bad date", nextFireAt: "not a date" }, env),
    /nextFireAt/,
  );
});

test("kanban: project=<slug> never falls back to a leading match", async () => {
  const other = await A.executeKanban({ action: "add", project: "alpha-proj", text: "in alpha" }, env);
  assert.equal(other.ok, true, other.text);
  // "alpha" is not a board: a prefix of "alpha-proj" must NOT be matched, and a read names
  // the (empty) board it resolved to instead of silently listing another project's cards.
  const list = await A.executeKanban({ action: "list", project: "alpha" }, env);
  assert.match(list.text, /\[project alpha\]/);
  assert.doesNotMatch(list.text, /in alpha/);
  // an explicit slug keeps the default board untouched
  assert.match((await A.executeKanban({ action: "list" }, env)).text, new RegExp(`\\[project ${slug}\\]`));

  const written = await A.executeKanban({ action: "add", project: "alpha", text: "own board" }, env);
  assert.equal(written.ok, true);
  assert.match((await A.executeKanban({ action: "list", project: "alpha-proj" }, env)).text, /in alpha/);
});

test("kanban: global is a read-only aggregate", async () => {
  const g = await A.executeKanban({ action: "list", scope: "global" }, env);
  assert.equal(g.ok, true);
  assert.match(g.text, /\[global\]/);
  assert.match(g.text, /alpha-proj\/#1 in alpha/);

  const refused = await A.executeKanban({ action: "add", scope: "global", text: "nope" }, { cwd, actor: "test" });
  assert.equal(refused.ok, false);
  assert.match(refused.text, /read-only/);
  const removed = await A.executeKanban({ action: "remove", scope: "global", id: 1 }, env);
  assert.equal(removed.ok, false);
  // the card is still there - a refusal must not be a soft delete
  assert.match((await A.executeKanban({ action: "list", scope: "global" }, env)).text, /alpha-proj\/#1/);
});

test("kanban: ids are per board, so a missing id fails loudly instead of hitting another board", async () => {
  await assert.rejects(
    () => A.executeKanban({ action: "move", id: 9999, col: "done" }, env),
    (err) => /9999/.test(err.message),
  );
  assert.equal((await A.executeKanban({ action: "move", id: 1 }, env)).ok, false); // col omitted
  assert.equal((await A.executeKanban({ action: "add", text: "  " }, env)).ok, false);
  assert.equal((await A.executeKanban({ action: "edit", id: 1 }, env)).ok, false);
});

test("kanban: img stores a real image and attaches it, ref records the path", async () => {
  // The upload path sniffs magic bytes, so the fixture has to be a real PNG.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64");
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(path.join(root, "assets"), { recursive: true });
  const pngPath = path.join(root, "assets", "shot.png");
  await writeFile(pngPath, png);
  const txtPath = path.join(root, "assets", "notes.txt");
  await writeFile(txtPath, "not an image");
  const htmlPath = path.join(root, "assets", "page.html");
  await writeFile(htmlPath, "<script>alert(1)</script>");

  const missing = await A.executeKanban({ action: "img", id: 1, image: "/tmp/nope.png" }, env);
  assert.equal(missing.ok, false);
  assert.match(missing.text, /cannot read/);

  // Text passes; a page that would run as our own origin does not.
  const text = await A.executeKanban({ action: "img", id: 1, image: txtPath }, env);
  assert.equal(text.ok, true, text.text);
  assert.match(text.text, /text\/plain/);
  const notAllowed = await A.executeKanban({ action: "img", id: 1, image: htmlPath }, env);
  assert.equal(notAllowed.ok, false);
  assert.match(notAllowed.text, /not an image, pdf, media, zip or plain-text file/);

  const ok = await A.executeKanban({ action: "img", id: 1, image: pngPath }, env);
  assert.equal(ok.ok, true, ok.text);
  assert.match(ok.text, /attached #\d+ to card #1 \(image\/png/);

  const ref = await A.executeKanban({ action: "ref", id: 1, image: "/tmp/report.html" }, env);
  assert.equal(ref.ok, true, ref.text);
  assert.match(ref.text, /referenced \/tmp\/report\.html on card #1/);
  assert.equal(ref.details.cards.find((c) => c.id === 1).ref, "/tmp/report.html");

  // A relative path is resolved against the cwd, not the process cwd.
  const relative = await A.executeKanban({ action: "img", id: 1, image: path.relative(env.cwd, pngPath) }, env);
  assert.equal(relative.ok, true, relative.text);
});

test("kanban: resume starts the doing-loop; check self-tests; url carries the token", async () => {
  const resume = await A.executeKanban({ action: "resume" }, env);
  assert.equal(resume.ok, true, resume.text);
  assert.match(resume.text, new RegExp(`loop running for ${slug}`));

  const check = await A.executeKanban({ action: "check" }, env);
  assert.equal(check.ok, true, check.text);
  const report = JSON.parse(check.text);
  assert.equal(report.db.ok, true);
  assert.ok(report.schemaVersion >= 2);
  assert.ok(report.counts.cards >= 1);

  const url = await A.executeKanban({ action: "url" }, env);
  assert.equal(url.ok, true, url.text);
  assert.match(url.text, /^http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]+$/);
  assert.equal(url.details.url, url.text);
});

test("deliverable: its own id space, and the card space is untouched", async () => {
  const add = await A.executeDeliverable({ action: "add", text: "shot.png", ref: pngPathForTest }, env);
  assert.equal(add.ok, true, add.text);
  assert.match(add.text, /added deliverable #1/); // card #1 exists on this board too

  const list = await A.executeDeliverable({ action: "list" }, env);
  assert.match(list.text, /#1 shot\.png/);
  assert.match(list.text, new RegExp(`ref:${pngPathForTest.replaceAll("/", "\\/")}`));

  const ref = await A.executeDeliverable({ action: "ref", id: 1, ref: pngPathForTest }, env);
  assert.equal(ref.ok, true, ref);
  assert.match(ref.text, /deliverable\.png/);

  assert.equal((await A.executeDeliverable({ action: "edit", id: 1, text: "shot v2" }, env)).ok, true);
  assert.match((await A.executeDeliverable({ action: "list" }, env)).text, /shot v2/);

  const img = await A.executeDeliverable({ action: "img", id: 1, image: pngPathForTest }, env);
  assert.equal(img.ok, true, img.text);
  assert.match(img.text, /attached image #\d+ to deliverable #1/);
  assert.equal((await A.executeDeliverable({ action: "img", id: 99, image: pngPathForTest }, env)).ok, false);

  assert.equal((await A.executeDeliverable({ action: "remove", id: 1 }, env)).ok, true);
  assert.match((await A.executeDeliverable({ action: "list" }, env)).text, /no deliverables/);

  const global = await A.executeDeliverable({ action: "list", scope: "global" }, env);
  assert.equal(global.ok, true);
  assert.match(global.text, /no deliverables|\[global\]/);
  assert.equal((await A.executeDeliverable({ action: "add", scope: "global", text: "x" }, env)).ok, false);});

test("deliverable ref: a relative path lands in the db absolute, a missing file is refused on the spot, and a directory is not a file", async () => {
  // #27: nous passed cwd-relative refs; the server read them against the kanban home and 404'd.
  // `..` included on purpose: resolve normalizes it, so the stored path stays absolute and clean.
  const add = await A.executeDeliverable({ action: "add", text: "chat flow", ref: "../assets/deliverable.png" }, env);
  assert.equal(add.ok, true, add.text);
  const stored = (await A.executeDeliverable({ action: "list" }, env)).details.deliverables?.find((d) => d.title === "chat flow");
  assert.equal(stored?.ref, pngPathForTest);

  // a ref-less add is legitimate (text-only deliverable): the empty branch must stay ok
  const bare = await A.executeDeliverable({ action: "add", text: "note only" }, env);
  assert.equal(bare.ok, true, bare.text);
  const bareRow = bare.details.deliverables?.find((d) => d.title === "note only");
  assert.ok(bareRow, "the ref-less add must have landed");
  assert.ok(!bareRow.ref, "an empty ref must store empty, not be rejected");
  assert.equal((await A.executeDeliverable({ action: "remove", id: bareRow.id }, env)).ok, true);

  const missing = await A.executeDeliverable({ action: "add", text: "ghost", ref: "assets/no-such.png" }, env);
  assert.equal(missing.ok, false);
  assert.match(missing.text, /ref is not an existing file/);

  // existsSync alone would pass a directory — the server's statSync().isFile() would 404 later
  const before = (await A.executeDeliverable({ action: "list" }, env)).details.deliverables?.length ?? 0;
  const dir = await A.executeDeliverable({ action: "add", text: "dir", ref: "." }, env);
  assert.equal(dir.ok, false);
  assert.match(dir.text, /ref is not an existing file/);
  const after = (await A.executeDeliverable({ action: "list" }, env)).details.deliverables?.length ?? 0;
  assert.equal(after, before, "a refused add must not leave a row behind");

  const repoint = await A.executeDeliverable({ action: "ref", id: stored.id, ref: "assets/no-such.png" }, env);
  assert.equal(repoint.ok, false);
  assert.match(repoint.text, /ref is not an existing file/);

  assert.equal((await A.executeDeliverable({ action: "remove", id: stored.id }, env)).ok, true);
});

test("injection: bounded, board-scoped, and it never carries the token", async () => {
  await A.refreshInjection(cwd);
  const text = A.injectionTextSync();
  assert.ok(text !== null);
  assert.match(text, new RegExp(`=== KANBAN \\(this project: ${slug}\\) ===`));
  assert.match(text, /TOKEN: \/kanban url/);
  const token = (await A.executeKanban({ action: "url" }, env)).text.split("token=")[1];
  assert.ok(!text.includes(token), "the token must not enter the prompt");
  assert.ok(text.length <= 2000);

  // an empty board injects nothing (no header-only noise in every prompt)
  await A.refreshInjection(path.join(root, "empty-project"));
  assert.equal(A.injectionTextSync(), null);
});

test("a home that does not exist yet is initialized on first use", async () => {
  const fresh = path.join(root, "fresh", ".pi", "kanban");
  const previous = process.env.KANBAN_HOME;
  await A.closeRuntime();
  process.env.KANBAN_HOME = fresh;
  try {
    const added = await A.executeKanban({ action: "add", text: "x" }, env);
    assert.equal(added.ok, true, "no init ceremony: the write just works on a new machine");
    assert.equal((await stat(path.join(fresh, "state.sqlite"))).isFile(), true);
    const check = await A.executeKanban({ action: "check" }, env);
    assert.equal(JSON.parse(check.text).db.ok, true);
  } finally {
    process.env.KANBAN_HOME = previous;
    await A.closeRuntime();
  }
});

test("extension: tools register `kanban` then `deliverable`, plus the /kanban command", async () => {
  process.env.KANBAN_HOME = home; // the extension warms a runtime on load
  const ext = (await import("../../extensions/kanban-v2.ts")).default;
  const tools = [];
  const commands = [];
  const events = new Map();
  ext({
    registerTool: (t) => tools.push(t),
    registerCommand: (name, def) => commands.push([name, def]),
    on: (name, cb) => events.set(name, cb),
  });
  assert.deepEqual(tools.map((t) => t.name), ["kanban", "deliverable"]);
  assert.deepEqual(commands.map(([name]) => name), ["kanban"]);
  assert.ok(events.has("before_agent_start"));

  // the v1 parameter surface survives
  const kanbanProps = Object.keys(tools[0].parameters.properties).sort();
  assert.deepEqual(kanbanProps, ["action", "blocked", "col", "commit", "id", "image", "labels", "nextFireAt", "priority", "project", "scope", "session", "text"]);
  const delivProps = Object.keys(tools[1].parameters.properties).sort();
  assert.deepEqual(delivProps, ["action", "cardId", "id", "image", "project", "ref", "scope", "text", "title"]);

  // the schema's action/scope/col values must be the ones src/agent/compat.ts declares
  const compat = await import("../../src/agent/compat.ts");
  const constsOf = (schema) => schema.anyOf.map((t) => t.const).sort();
  assert.deepEqual(constsOf(tools[0].parameters.properties.action), [...compat.KANBAN_ACTIONS].sort());
  assert.deepEqual(constsOf(tools[1].parameters.properties.action), [...compat.DELIVERABLE_ACTIONS].sort());
  assert.deepEqual(constsOf(tools[0].parameters.properties.scope), [...compat.SCOPES].sort());
  assert.deepEqual(constsOf(tools[0].parameters.properties.col), [...compat.COLS].sort());

  // /kanban on a v1-only subcommand must answer, not create a card named "take"
  const notices = [];
  await commands[0][1].handler("take", { ui: { notify: (t) => notices.push(t) }, sessionManager: { getCwd: () => cwd } });
  assert.match(notices[0], /未実装/);

  // before_agent_start returns a request-only trailing message (or nothing when the board
  // is empty for the calling cwd) - it never edits the system prompt
  const hookResult = events.get("before_agent_start")({});
  if (hookResult === undefined) {
    assert.equal(A.injectionTextSync(), null);
  } else {
    assert.equal(hookResult.message.customType, "kanban-board");
    assert.equal(hookResult.message.display, false);
    assert.match(hookResult.message.content, /=== KANBAN/);
  }

  // the tool call path works end to end through the extension's own execute
  const res = await tools[0].execute("call-1", { action: "add", text: "from the extension" }, null, null, {});
  assert.equal(res.isError, undefined, res.content[0].text);
  assert.match(res.content[0].text, /added #\d+/);

  await A.closeRuntime();
});

test("footer: two sessions in one cwd each get their own widget", async () => {
  process.env.KANBAN_HOME = home;
  const ext = (await import("../../extensions/kanban-v2.ts")).default;
  const tools = [];
  const events = new Map();
  ext({
    registerTool: (t) => tools.push(t),
    registerCommand: () => {},
    on: (name, cb) => events.set(name, cb),
  });

  // An empty board keeps the footer quiet on purpose, so make sure this one has a card.
  const added = await tools[0].execute("call-2", { action: "add", text: "footer card" }, null, null, {
    sessionManager: { getCwd: () => cwd },
  });
  assert.equal(added.isError, undefined, added.content[0].text);

  const widgets = new Map();
  const ctxFor = (sid) => ({
    hasUI: true,
    ui: { notify: () => {}, setWidget: (_key, value) => widgets.set(sid, value) },
    sessionManager: { getCwd: () => cwd, getSessionId: () => sid },
  });
  const ctxA = ctxFor("A");
  const ctxB = ctxFor("B");
  try {
    events.get("session_start")({}, ctxA);
    events.get("session_start")({}, ctxB);
    for (let i = 0; i < 100 && !(widgets.get("A") && widgets.get("B")); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.match(String(widgets.get("A")), /^PROJECT: /, "session A must get a footer");
    assert.match(String(widgets.get("B")), /^PROJECT: /, "session B must get a footer too");

    events.get("session_shutdown")({}, ctxA);
    assert.ok(widgets.get("B"), "closing session A must not clear session B's footer");
    assert.equal(widgets.get("A"), undefined, "session A's own footer is cleared on shutdown");
  } finally {
    // B's interval is unref()ed, but leaving it running leaks into the next test.
    events.get("session_shutdown")({}, ctxB);
    await A.closeRuntime();
  }
});

/** A pi-web holding one session in a given state: only the probe is answered here. */
function fakeProbe(state) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => state };
  };
  return { calls, fetch };
}
const idlePiWeb = () => fakeProbe({ running: false });
const busyPiWeb = () => fakeProbe({ running: true, state: { isPromptRunning: true } });

test("kanban: add session:self links the card to the host's own session", async () => {
  const own = { ...env, sessionId: "self-0001" };
  const out = await A.executeKanban({ action: "add", text: "self-add", session: "self" }, own);
  assert.equal(out.ok, true, out.text);
  const id = out.details.nextId - 1;
  assert.equal(out.details.cards.find((c) => c.id === id).sessionId, "self-0001");
});

test("kanban: add session:self without a host session id fails and creates no card", async () => {
  const before = (await A.executeKanban({ action: "list" }, env)).details.cards.length;
  const out = await A.executeKanban({ action: "add", text: "self-add-none", session: "self" }, env);
  assert.equal(out.ok, false, out.text);
  assert.match(out.text, /self needs the host's session id/);
  const after = (await A.executeKanban({ action: "list" }, env)).details.cards;
  assert.equal(after.length, before, "a refused add must not touch the board");
  assert.equal(after.some((c) => c.title === "self-add-none"), false);
});

test("kanban: a host session id sessionOf would reject is a refusal, not a throw", async () => {
  // self names whatever the host told us; if that is not a usable tag the caller gets the
  // same {ok:false} shape as "no id at all", because executeKanban never throws at a tool.
  const bad = { ...env, sessionId: "not a tag!" };
  const before = (await A.executeKanban({ action: "list" }, env)).details.cards.length;
  const out = await A.executeKanban({ action: "add", text: "self-add-bad", session: "self" }, bad);
  assert.equal(out.ok, false, out.text);
  assert.match(out.text, /not a usable tag/);
  assert.equal((await A.executeKanban({ action: "list" }, env)).details.cards.length, before);
});

test("kanban: edit session:self fills an unclaimed card with the host's id", async () => {
  const added = await A.executeKanban({ action: "add", text: "unclaimed" }, env);
  const id = added.details.nextId - 1;
  assert.equal(added.details.cards.find((c) => c.id === id).sessionId, null);
  const own = { ...env, sessionId: "self-0002" };
  const out = await A.executeKanban({ action: "edit", id, session: "self" }, own);
  assert.equal(out.ok, true, out.text);
  assert.equal(out.details.cards.find((c) => c.id === id).sessionId, "self-0002");
  assert.match(out.text, /edited #/);
  assert.doesNotMatch(out.text, /claimed anyway/);
});

test("kanban: edit session:self on a card we already own probes nothing", async () => {
  // The every-turn case: an agent re-stamping its own card must not depend on pi-web at all.
  // A busy fetch is passed so that a stray probe would be refused, not merely counted.
  const own = { ...env, sessionId: "self-0005" };
  const added = await A.executeKanban({ action: "add", text: "mine", session: "self" }, own);
  const id = added.details.nextId - 1;
  const piweb = busyPiWeb();
  const out = await A.executeKanban({ action: "edit", id, text: "mine again", session: "self" }, { ...own, fetch: piweb.fetch });
  assert.equal(out.ok, true, out.text);
  assert.equal(piweb.calls.length, 0, "editing our own card must not reach the network");
  const card = (await A.executeKanban({ action: "list" }, env)).details.cards.find((c) => c.id === id);
  assert.equal(card.title, "mine again");
  assert.equal(card.sessionId, "self-0005");
});

test("kanban: edit session:self may take a card whose owner is idle", async () => {
  const added = await A.executeKanban({ action: "add", text: "idle owner" }, env);
  const id = added.details.nextId - 1;
  await A.executeKanban({ action: "edit", id, session: "other-idle" }, env);
  const piweb = idlePiWeb();
  const own = { ...env, sessionId: "self-0003", fetch: piweb.fetch };
  const out = await A.executeKanban({ action: "edit", id, session: "self" }, own);
  assert.equal(out.ok, true, out.text);
  assert.equal(out.details.cards.find((c) => c.id === id).sessionId, "self-0003");
  assert.match(piweb.calls[0], /\/api\/agent\/other-idle\?systemPrompt=0$/);
});

test("kanban: edit session:self refuses a busy owner and leaves the card alone", async () => {
  const added = await A.executeKanban({ action: "add", text: "busy owner" }, env);
  const id = added.details.nextId - 1;
  await A.executeKanban({ action: "edit", id, session: "other-busy" }, env);
  const piweb = busyPiWeb();
  const own = { ...env, sessionId: "self-0004", fetch: piweb.fetch };
  const out = await A.executeKanban({ action: "edit", id, session: "self" }, own);
  assert.equal(out.ok, false, out.text);
  assert.match(out.text, /card #\d+ is in other-busy's turn; claim it only when it is idle/);
  const card = (await A.executeKanban({ action: "list" }, env)).details.cards.find((c) => c.id === id);
  assert.equal(card.sessionId, "other-busy", "a refused claim must not rewrite the session");
});

test("kanban: edit session:self takes an unprobeable card and says so", async () => {
  const added = await A.executeKanban({ action: "add", text: "unprobeable owner" }, env);
  const id = added.details.nextId - 1;
  await A.executeKanban({ action: "edit", id, session: "other-gone" }, env);
  const down = async () => { throw new Error("ECONNREFUSED"); };
  const own = { ...env, sessionId: "self-0005", fetch: down };
  const out = await A.executeKanban({ action: "edit", id, session: "self" }, own);
  assert.equal(out.ok, true, out.text);
  assert.match(out.text, /\(owner could not be probed; claimed anyway\)/);
  assert.equal(out.details.cards.find((c) => c.id === id).sessionId, "self-0005");
});
