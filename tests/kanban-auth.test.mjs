// kanban 認可フォールバックの自己検証。`node tests/kanban-auth.test.mjs`。
// 書き込み端点は sid 必須: 省略/空 -> 400、どのセッションの sid でも 200（#55 でセッション
// 単位の書き込みロックを撤去した）。scope=global の逃げ道（sid 省略で 200）も現状維持。
// HOME と KANBAN_PORT を差し替えるので、本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { authFetch } from "./helpers/token.mjs";
import { useKanban, seedBoard, readBoardAt } from "./helpers/board.mjs";

// #83b: HTTP routes need the server token now; tf = fetch + the kb_auth cookie.
const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-auth-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
process.env.HOME = HOME_DIR;
// Windows: os.homedir() prefers USERPROFILE over HOME, so keep them in step or the
// server writes its token to the real profile and this test reads a missing file.
process.env.USERPROFILE = process.env.HOME;
const PORT = await new Promise((resolve) => {
	const s = createServer();
	s.listen(0, "127.0.0.1", () => {
		const { port } = s.address();
		s.close(() => resolve(port));
	});
});
process.env.KANBAN_PORT = String(PORT);

const require = createRequire(import.meta.url);
const { createJiti } = require(
	process.env.KANBAN_JITI ?? createRequire(import.meta.url).resolve("jiti"),
);
const jiti = createJiti(import.meta.url);
const SRC = fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url));
const mod = await jiti.import(SRC);
useKanban(mod);

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

const handlers = new Map();
const commands = new Map();
mod.default({
	registerCommand(name, def) {
		commands.set(name, def);
	},
	registerTool() {},
	appendEntry() {},
	on(ev, fn) {
		handlers.set(ev, fn);
	},
	sendUserMessage() {},
});
for (let i = 0; i < 40; i++) {
	try {
		if ((await tf(`http://127.0.0.1:${PORT}/api/kanban`)).ok) break;
	} catch {
		// まだ listen していない
	}
	await new Promise((r) => setTimeout(r, 100));
}

const SID = "auth-sid";
const modesFile = `${HOME_DIR}/.pi/kanban/modes.json`;
const globalFile = `${HOME_DIR}/.pi/kanban/global.json`;
const SLUG = mod.projectSlugOf(process.cwd());
const boardFile = `${HOME_DIR}/.pi/kanban/projects/${SLUG}.json`;
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const writeJson = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2));

// #40: the panel's default sid is pinned by the first session_start, not by a
// sidOf side effect. Drive the real event instead of relying on /kanban help.
handlers.get("session_start")({}, {
	hasUI: false,
	isIdle: () => false,
	ui: { notify() {}, setWidget() {} },
	sessionManager: { getSessionId: () => SID, getEntries: () => [] },
});

// priority 用にカードを1枚用意（SESSION / GLOBAL 両方）
seedBoard(boardFile, { cards: [{ id: 1, text: "c", col: "todo" }], nextId: 9 });
seedBoard(globalFile, { cards: [{ id: 1, text: "g", col: "todo" }], nextId: 9 });

const status = async (path) => (await tf(`http://127.0.0.1:${PORT}${path}`)).status;
const bodyOf = async (path) => (await tf(`http://127.0.0.1:${PORT}${path}`)).json();

// #17: 設定の書き込み先は project（この cwd のボード）か global だけ。sid は要らない。
const SETTINGS = [
	["/api/modes", `key=autoPick&value=on`],
	["/api/interval", `min=5`],
	["/api/stuck", `n=5`],
	["/api/priority", `id=1&n=5`],
];

// --- scope=session は 400（#17 でボードごと廃止） ------------------------------
for (const [name, q] of SETTINGS) {
	await check(`${name} scope=session -> 400`, async () =>
		assert.equal(await status(`${name}?scope=session&${q}`), 400));
}
await check("scope=session の 400 は移行先を名指しする", async () => {
	const body = await bodyOf(`/api/modes?scope=session&key=autoPick&value=on`);
	assert.equal(body.error, "scope=session is gone; boards are project-scoped");
});

// --- scope=project（sid 省略）-> 200 かつ project バケットに書かれる -----------
for (const [name, q] of SETTINGS) {
	await check(`${name} scope=project sid 省略 -> 200`, async () =>
		assert.equal(await status(`${name}?scope=project&${q}`), 200));
}
await check("project の modes は modes.json の PROJECT[slug] に入る", () =>
	assert.equal(readJson(modesFile).PROJECT[SLUG].autoPick, true));
await check("project の interval が PROJECT[slug] に入る", () =>
	assert.equal(readJson(modesFile).PROJECT[SLUG].intervalMin, 5));
await check("project の stuck が PROJECT[slug] に入る", () =>
	assert.equal(readJson(modesFile).PROJECT[SLUG].stuckLimit, 5));
await check("priority は project ボードのカードに入る", () =>
	assert.equal(readBoardAt(boardFile).cards[0].priority, 5));
await check("priority はカードの本文を壊さない", () => {
	assert.equal(readBoardAt(boardFile).cards[0].text, "c");
	assert.equal(readBoardAt(globalFile).cards[0].text, "g");
});

await check("scope 省略は project 扱い（既定）", async () => {
	assert.equal(await status(`/api/stuck?n=6`), 200);
	assert.equal(readJson(modesFile).PROJECT[SLUG].stuckLimit, 6);
});

await check("未知の sid + scope=project は 400（黙って cwd のボードに書かない）", async () =>
	assert.equal(await status(`/api/modes?scope=project&sid=no-such-session&key=autoPick&value=off`), 400));

// --- scope=global は driver にフォールバックする（#67/#78） -------------------
await check("scope=global sid 省略 -> 200（driver に落ちる）", async () =>
	assert.equal(await status(`/api/stuck?scope=global&n=7`), 200));
await check("scope=global の書き込み先は GLOBAL[sid]", () =>
	assert.equal(readJson(modesFile).GLOBAL[SID].stuckLimit, 7));

// --- shutdown 後の 400 は global を名指しする ---------------------------------
handlers.get("session_shutdown")();
await check("shutdown 後の scope=global sid 省略 -> 400", async () =>
	assert.equal(await status(`/api/modes?scope=global&key=autoPick&value=on`), 400));
await check("その 400 は global を名指しする（session ではない）", async () => {
	const body = await bodyOf(`/api/modes?scope=global&key=autoPick&value=on`);
	assert.equal(body.error, "scope=global requires sid (no active session to fall back to)");
});
await check("/api/interval も同じ文言（#78 の設定系5端点で共通）", async () => {
	const body = await bodyOf(`/api/interval?scope=global&min=5`);
	assert.equal(body.error, "scope=global requires sid (no active session to fall back to)");
});

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
// poll timer は session_start を踏んでいないので未生成。HTTP サーバだけが残るので明示終了。
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
