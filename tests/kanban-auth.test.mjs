// kanban 認可フォールバックの自己検証。`node tests/kanban-auth.test.mjs`。
// 書き込み端点は sid 必須: 省略/空 -> 400、正しい sid -> 200、他セッション -> 403。
// scope=global の逃げ道（sid 省略で 200）は今回のスコープ外なので現状維持を固定する。
// HOME と KANBAN_PORT を差し替えるので、本番の ~/.pi/kanban と 8789 には触れない。
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";

const HOME_DIR = "/tmp/kb-auth-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
process.env.HOME = HOME_DIR;
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
	"/root/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.cjs",
);
const jiti = createJiti(import.meta.url);
const SRC = new URL("../extensions/kanban.ts", import.meta.url).pathname;
const mod = await jiti.import(SRC);

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
		if ((await fetch(`http://127.0.0.1:${PORT}/api/kanban`)).ok) break;
	} catch {
		// まだ listen していない
	}
	await new Promise((r) => setTimeout(r, 100));
}

const SID = "auth-sid";
const OTHER = "auth-other";
const modesFile = `${HOME_DIR}/.pi/kanban/modes.json`;
const globalFile = `${HOME_DIR}/.pi/kanban/global.json`;
const boardFile = `${HOME_DIR}/.pi/kanban/sessions/${SID}.json`;
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
writeJson(boardFile, { cards: [{ id: 1, text: "c", col: "todo" }], nextId: 9 });
writeJson(globalFile, { cards: [{ id: 1, text: "g", col: "todo" }], nextId: 9 });

const status = async (path) => (await fetch(`http://127.0.0.1:${PORT}${path}`)).status;
const DENY = "read-only session (another session is active)";

const SESSION_WRITES = [
	["/api/modes", `scope=session&key=autoPick&value=on`],
	["/api/interval", `scope=session&min=5`],
	["/api/stuck", `scope=session&n=5`],
	["/api/priority", `scope=session&id=1&n=5`],
];

// --- sid 省略 -> 400 ---------------------------------------------------------
for (const [name, q] of SESSION_WRITES) {
	await check(`${name} sid 省略 -> 400`, async () => assert.equal(await status(`${name}?${q}`), 400));
}
await check("/api/modes sid 空文字 -> 400", async () =>
	assert.equal(await status(`/api/modes?scope=session&sid=&key=autoPick&value=on`), 400));

// --- 正しい sid -> 200 -------------------------------------------------------
for (const [name, q] of SESSION_WRITES) {
	await check(`${name} 正しい sid -> 200`, async () =>
		assert.equal(await status(`${name}?${q}&sid=${SID}`), 200));
}

// --- 他セッションの sid -> 403（文言不変） -----------------------------------
for (const [name, q] of SESSION_WRITES) {
	await check(`${name} 他セッション sid -> 403`, async () => {
		const res = await fetch(`http://127.0.0.1:${PORT}${name}?${q}&sid=${OTHER}`);
		assert.equal(res.status, 403);
		assert.equal((await res.json()).error, DENY);
	});
}

// --- scope=global の逃げ道: sid 省略でも 200（現状維持・スコープ外） ---------
await check("scope=global sid 省略 -> 200（既存挙動を維持）", async () =>
	assert.equal(await status(`/api/stuck?scope=global&n=7`), 200));
await check("scope=global 書き込み先は GLOBAL（sid 省略でも）", () =>
	assert.equal(readJson(modesFile).GLOBAL[SID].stuckLimit, 7));

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
// poll timer は session_start を踏んでいないので未生成。HTTP サーバだけが残るので明示終了。
process.exit(failures.length === 0 ? 0 : 1);
