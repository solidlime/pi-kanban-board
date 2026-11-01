// phase0 自己検証: ボード scope に "project" を足した core（設計 plans/phase0-cwd-scope.md）。
// フレームワーク無しで `node tests/kanban-scope-project.test.mjs`。
// 対象: projectSlugOf / boardPath("project") ↔ boardKeyOf の対称性 / writeBoardPath の 2 ゲート /
// tool の既定 project と actor（movedBy）が session のままであること。
// #17: scope は project / global の 2 つだけ。session はボードではなく actor に残る。
// HOME と KANBAN_PORT を差し替えるので、本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { authFetch } from "./helpers/token.mjs";
import { boardExists, readBoardAt, useKanban } from "./helpers/board.mjs";

const HOME_DIR = "/tmp/kb-scope-project-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
process.env.HOME = HOME_DIR;
// Windows: os.homedir() prefers USERPROFILE over HOME, so keep them in step or the
// server writes its token to the real profile and this test reads a missing file.
process.env.USERPROFILE = process.env.HOME;
process.env.KANBAN_PORT = String(
	await new Promise((resolve) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	}),
);

const require = createRequire(import.meta.url);
const { createJiti } = require(
	process.env.KANBAN_JITI ?? createRequire(import.meta.url).resolve("jiti"),
);
const jiti = createJiti(import.meta.url);
const target = process.env.KANBAN_TS ?? fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url));
const mod = await jiti.import(target);
useKanban(mod);

const HOME = `${HOME_DIR}/.pi/kanban`;
const API_BASE = `http://127.0.0.1:${process.env.KANBAN_PORT}`;
const tf = (input, init) => authFetch(input, init);
const projectBoard = (slug) => readBoardAt(`${HOME}/projects/${slug}.json`);
const projectExists = (slug) => boardExists(`${HOME}/projects/${slug}.json`);

const ctxFor = (sid) => ({
	hasUI: false,
	isIdle: () => true,
	ui: { notify() {}, setWidget() {} },
	sessionManager: { getSessionId: () => sid, getEntries: () => [] },
});

const registered = [];
const pi = {
	registerCommand() {},
	registerTool(spec) {
		registered.push(spec);
	},
	appendEntry() {},
	on() {},
	sendUserMessage() {},
};
mod.default(pi);
const tool = registered.find((s) => s.name === "kanban");
assert.ok(tool, "kanban ツールが登録されている");

const failures = [];
let passed = 0;
async function check(name, fn) {
	try {
		await fn();
		passed += 1;
	} catch (err) {
		failures.push(`${name}: ${err.message}`);
	}
}

const run = (sid, params) => tool.execute("c", params, undefined, undefined, ctxFor(sid));

// --- 1. slug は git ルートの basename（失敗時は cwd）、normalizeProject を通す ---------
await check("slug は git ルートの basename", () => {
	const cwd = fileURLToPath(new URL("..", import.meta.url));
	const top = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
	const expected = mod.normalizeProject(top.replace(/[\\/]+$/, "").split(/[\\/]/).pop());
	assert.equal(mod.projectSlugOf(cwd), expected);
	// 同じ cwd はキャッシュから同じ答え（fork の有無は測れないが、答えは揺れない）。
	assert.equal(mod.projectSlugOf(cwd), expected);
	assert.ok(!expected.includes("/"), `slug にセパレータが残った: ${expected}`);
});

await check("git でない cwd は cwd の basename", () => {
	const dir = mkdtempSync(join(tmpdir(), "kb-NOT-a-repo-"));
	try {
		assert.equal(mod.projectSlugOf(dir), mod.normalizeProject(dir.split(/[\\/]/).pop()));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

await check("normalize で空になる cwd は inbox", () => {
	// 日本語ディレクトリ名は [a-z0-9._-] で全部落ちる。
	const dir = mkdtempSync(join(tmpdir(), "kb-"));
	const weird = join(dir, "日本語");
	mkdirSync(weird);
	try {
		assert.equal(mod.projectSlugOf(weird), "inbox");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- 2. tool: 既定は project。ボードキーは slug、actor は sid ---------------------
const SID = "scope-proj-sid";
const CWD = fileURLToPath(new URL("..", import.meta.url));
const SLUG = mod.projectSlugOf(CWD);
const ctxWithCwd = (sid) => ({ ...ctxFor(sid), sessionManager: { ...ctxFor(sid).sessionManager, getCwd: () => CWD } });
const runIn = (sid, params) => tool.execute("c", params, undefined, undefined, ctxWithCwd(sid));

await check("tool add の既定は project ボード", async () => {
	const r = await runIn(SID, { action: "add", text: "proj card" });
	assert.equal(r.isError, undefined, r.content[0].text);
	assert.equal(r.details.scope, "project");
	const cards = projectBoard(SLUG).cards;
	assert.equal(cards.length, 1, JSON.stringify(cards));
	assert.equal(cards[0].text, "proj card");
	// actor は session のまま（ボードキーに sid を使い回していない）。
	assert.equal(cards[0].movedBy, SID, `movedBy=${cards[0].movedBy}`);
	// session ボードは空のまま（1 枚も書いていない）。
	assert.equal(projectExists(SLUG), true);
	assert.equal(boardExists(`${HOME}/sessions/${SID}.json`), false);
});

await check("tool add scope=global は isError（読み取り専用）でボードを書かない", async () => {
	const before = projectBoard(SLUG).cards.map((c) => c.text);
	const r = await runIn(SID, { action: "add", text: "nope", scope: "global" });
	assert.equal(r.isError, true, "global への add が通ってしまった");
	assert.match(r.content[0].text, /global board is read-only/);
	assert.deepEqual(projectBoard(SLUG).cards.map((c) => c.text), before);
});

// --- 3. /api/kanban: project 面が増え、既存キーは残る ----------------------------
await check("/api/kanban は project 面と global 面を返す（session は無い）", async () => {
	const res = await tf(`${API_BASE}/api/kanban?scope=project`);
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.equal(body.projectId, SLUG);
	assert.deepEqual(
		body.project.cards.map((c) => c.text),
		["proj card"],
	);
	assert.ok(body.global, "global キーが消えている");
	assert.equal("session" in body, false, "session キーが残っている");
	assert.equal("sessionId" in body, false, "sessionId が残っている");
	assert.deepEqual(Object.keys(body.modes).sort(), ["global", "project"]);
});

await check("/api/kanban?scope=session は 400（廃止された scope）", async () => {
	const res = await tf(`${API_BASE}/api/kanban?scope=session`);
	assert.equal(res.status, 400);
	assert.deepEqual(await res.json(), {
		ok: false,
		error: "scope=session is gone; boards are project-scoped",
	});
});

// --- 4. writeBoardPath: project は sid 不要 / global は読み取り専用 / session は sid 必須 ---
await check("/api/add?scope=project は sid 無しで通る", async () => {
	const res = await tf(`${API_BASE}/api/add?scope=project&text=http+card&col=todo`);
	assert.equal(res.status, 200);
	assert.equal((await res.json()).ok, true);
	assert.ok(
		projectBoard(SLUG).cards.some((c) => c.text === "http card"),
		JSON.stringify(projectBoard(SLUG).cards),
	);
});

await check("/api/add?scope=global は 400（global は読み取り専用）", async () => {
	const res = await tf(`${API_BASE}/api/add?scope=global&text=nope`);
	assert.equal(res.status, 400);
	assert.equal((await res.json()).error, "global board is read-only");
});

await check("/api/add?scope=session は 400（廃止された scope）", async () => {
	const res = await tf(`${API_BASE}/api/add?scope=session&text=nope`);
	assert.equal(res.status, 400);
	assert.equal((await res.json()).error, "scope=session is gone; boards are project-scoped");
});

await check("/api/upload?scope=global も 400（アップロードのゲート）", async () => {
	const res = await tf(`${API_BASE}/api/upload?scope=global&ext=png`, {
		method: "POST",
		body: Buffer.from("x"),
	});
	assert.equal(res.status, 400);
	assert.equal((await res.json()).error, "global board is read-only");
});

console.log(`${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`FAIL ${f}`);
// poll timer は session_start を踏むので動いている。HTTP サーバごと明示終了。
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
