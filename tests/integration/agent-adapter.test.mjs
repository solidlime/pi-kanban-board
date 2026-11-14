// W3F: the v2 agent adapter (extensions/kanban-v2.ts + src/agent/adapter.ts).
// Temp home only — ~/.pi/kanban is never touched.
import "./_ts-hooks.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const { executeInit, planInit } = await import("../../src/persistence/init.ts");

const root = await mkdtemp(path.join(tmpdir(), "kb-adapter-"));
const home = path.join(root, ".pi", "kanban");
await executeInit(planInit(new Date(), home), { confirmed: true });
process.env.KANBAN_HOME = home;
process.env.KANBAN_PORT = "0"; // ephemeral: never fight a real dashboard for 8789

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

  const missing = await A.executeKanban({ action: "img", id: 1, image: "/tmp/nope.png" }, env);
  assert.equal(missing.ok, false);
  assert.match(missing.text, /cannot read/);

  const notImage = await A.executeKanban({ action: "img", id: 1, image: txtPath }, env);
  assert.equal(notImage.ok, false);
  assert.match(notImage.text, /not a png, jpeg, gif or webp/);

  const ok = await A.executeKanban({ action: "img", id: 1, image: pngPath }, env);
  assert.equal(ok.ok, true, ok.text);
  assert.match(ok.text, /attached #1 to card #1 \(image\/png/);

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
  const add = await A.executeDeliverable({ action: "add", text: "shot.png", ref: "/tmp/shot.png" }, env);
  assert.equal(add.ok, true, add.text);
  assert.match(add.text, /added deliverable #1/); // card #1 exists on this board too

  const list = await A.executeDeliverable({ action: "list" }, env);
  assert.match(list.text, /#1 shot\.png/);
  assert.match(list.text, /ref:\/tmp\/shot\.png/);

  const ref = await A.executeDeliverable({ action: "ref", id: 1, ref: "/tmp/other.png" }, env);
  assert.equal(ref.ok, true, ref.text);
  assert.match(ref.text, /other\.png/);

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
  assert.equal((await A.executeDeliverable({ action: "add", scope: "global", text: "x" }, env)).ok, false);
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

test("not initialized: writes refuse, check explains, nothing is created", async () => {
  const empty = path.join(root, "uninit", ".pi", "kanban");
  const previous = process.env.KANBAN_HOME;
  await A.closeRuntime();
  process.env.KANBAN_HOME = empty;
  try {
    await assert.rejects(() => A.executeKanban({ action: "add", text: "x" }, env), /not initialized/);
    const check = await A.executeKanban({ action: "check" }, env);
    assert.equal(check.ok, false);
    assert.equal(JSON.parse(check.text).db.ok, false);
    await assert.rejects(() => stat(empty));
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
