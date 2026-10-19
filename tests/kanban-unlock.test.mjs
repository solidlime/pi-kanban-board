// #55: セッション単位の書き込みロックが無いことの自己検証。`node tests/kanban-unlock.test.mjs`。
// 2 セッション（A が driver、B は後発）を起こし、driver でない A のボードにも
// add / rename が 200 で通ること、session_shutdown が driver の pin を解放すること、
// ディスクに無い sid でもボードが作られることを固定する。
// HOME と KANBAN_PORT を差し替えるので、本番の ~/.pi/kanban と 8789 には触れない。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { authFetch } from "./helpers/token.mjs";

// #83b: HTTP routes need the server token now; tf = fetch + the kb_token cookie.
const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-unlock-home";
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
mod.default({
	registerCommand() {},
	registerTool() {},
	appendEntry() {},
	on(ev, fn) {
		handlers.set(ev, fn);
	},
	sendUserMessage() {},
});
for (let i = 0; i < 40; i++) {
	try {
		if ((await tf(`http://127.0.0.1:${PORT}/api/sessions`)).ok) break;
	} catch {
		// まだ listen していない
	}
	await new Promise((r) => setTimeout(r, 100));
}

const ctxFor = (sid) => ({
	hasUI: false,
	isIdle: () => true,
	ui: { notify() {}, setWidget() {} },
	sessionManager: { getSessionId: () => sid, getEntries: () => [] },
});
const boardFile = (sid) => `${HOME_DIR}/.pi/kanban/sessions/${sid}.json`;
const readBoard = (sid) => JSON.parse(readFileSync(boardFile(sid), "utf8"));
const get = (path) => tf(`http://127.0.0.1:${PORT}${path}`);
const sessionsJson = async () => (await get("/api/sessions")).json();

const A = "unlock-a";
const B = "unlock-b";
// A を先に起こす = A が driver（activeSessionId は最初の session_start で固定）。
handlers.get("session_start")({}, ctxFor(A));
handlers.get("session_start")({}, ctxFor(B));
// A のボードをディスクに置く（B はファイル無し = 合成行の対象）。
writeFileSync(boardFile(A), JSON.stringify({ cards: [{ id: 1, text: "最初", col: "todo" }], nextId: 2 }));

await check("driver は A のまま（B の session_start では動かない）", async () => {
	const j = await sessionsJson();
	assert.equal(j.activeSessionId, A);
	const act = j.sessions.filter((s) => s.mine).map((s) => s.id);
	assert.deepEqual(act, [A]);
});

await check("driver のボードに /api/add が 200", async () => {
	const res = await get(`/api/add?scope=session&sid=${A}&text=${encodeURIComponent("A追加")}`);
	assert.equal(res.status, 200);
	assert.ok(readBoard(A).cards.some((c) => c.text === "A追加"), "A のボードに入っていない");
});

await check("driver のボードに /api/rename が 200 で反映される", async () => {
	const res = await get(`/api/rename?scope=session&sid=${A}&id=1&text=${encodeURIComponent("改名")}`);
	assert.equal(res.status, 200);
	assert.equal(readBoard(A).cards.find((c) => c.id === 1).text, "改名");
});

await check("driver でない B のボードにも /api/add が 200 で入る（#55）", async () => {
	const res = await get(`/api/add?scope=session&sid=${B}&text=${encodeURIComponent("B追加")}`);
	assert.equal(res.status, 200);
	assert.ok(existsSync(boardFile(B)), "B のボードファイルが作られていない");
	assert.ok(readBoard(B).cards.some((c) => c.text === "B追加"), "B のボードに入っていない");
});

await check("driver でない B のボードにも /api/rename が 200 で反映される（#55）", async () => {
	const res = await get(`/api/rename?scope=session&sid=${B}&id=1&text=${encodeURIComponent("B改名")}`);
	assert.equal(res.status, 200);
	assert.equal(readBoard(B).cards.find((c) => c.id === 1).text, "B改名");
});

await check("ディスクに無い sid でも /api/add が 200 でそのボードが作られる", async () => {
	const fresh = "unlock-fresh";
	assert.equal(existsSync(boardFile(fresh)), false, "前提が壊れている: 既にファイルがある");
	const res = await get(`/api/add?scope=session&sid=${fresh}&text=${encodeURIComponent("新規")}`);
	assert.equal(res.status, 200);
	assert.ok(existsSync(boardFile(fresh)), "ボードファイルが作られていない");
	assert.ok(readBoard(fresh).cards.some((c) => c.text === "新規"));
});

await check("ボードファイルが無い driver は一覧に出るが ACTIVE 扱いにはならない", async () => {
	// 合成行（ディスクに無い sid を一覧に足す）は残すが、mine は false。
	unlinkSync(boardFile(A));
	const j = await sessionsJson();
	const row = j.sessions.find((s) => s.id === A);
	assert.ok(row, "合成行が一覧に無い");
	assert.equal(row.mine, false, "死んだセッションが driver/ACTIVE で居座っている");
	const dash = await (await get("/api/dashboard")).json();
	assert.equal(dash.sessions.filter((s) => s.isActive).length, 0, "dashboard が ACTIVE を出している");
	assert.equal(dash.sessions.find((s) => s.id === A).isActive, false);
	assert.equal(j.activeSessionId, A, "driver の pin 自体は残る（auto-tick の駆動元）");
	// 再び書けばファイルが戻る。
	const res = await get(`/api/add?scope=session&sid=${A}&text=${encodeURIComponent("復帰")}`);
	assert.equal(res.status, 200);
	assert.ok(existsSync(boardFile(A)), "ボードファイルが戻っていない");
});

await check("session_shutdown で driver の pin が解放される（#55）", async () => {
	const before = await sessionsJson();
	assert.equal(before.activeSessionId, A, "前提: A が driver");
	handlers.get("session_shutdown")();
	const after = await sessionsJson();
	assert.equal(after.activeSessionId, null, "shutdown 後も pin が残っている");
	assert.equal(after.sessions.filter((s) => s.mine).length, 0, "ACTIVE の看板が残っている");
	const dash = await (await get("/api/dashboard")).json();
	assert.equal(dash.driver, null);
	assert.equal(dash.sessions.filter((s) => s.isActive).length, 0);
	assert.equal(dash.stats.active, 0);
});

await check("解放後もどのボードにも書ける", async () => {
	const res = await get(`/api/add?scope=session&sid=${A}&text=${encodeURIComponent("解放後")}`);
	assert.equal(res.status, 200);
	assert.ok(readBoard(A).cards.some((c) => c.text === "解放後"));
});

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
// poll timer は session_start を踏んだので動いている。HTTP サーバごと明示終了。
process.exit(failures.length === 0 ? 0 : 1);
