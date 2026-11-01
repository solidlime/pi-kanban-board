// #55: セッション単位の書き込みロックが無いことの自己検証。`node tests/kanban-unlock.test.mjs`。
// #17 で session ボードは消えたので、生き残った不変条件を固定する:
//   - 書き込みに pin / driver は要らない（2 セッション起こしても project ボードに書ける）
//   - /api/sessions は 404、dashboard に sessions / driver / stats.active は無い
//   - global は読み取り専用のまま
//   - ディスクにボードが無くても /api/add が作る
// HOME と KANBAN_PORT を差し替えるので、本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { authFetch } from "./helpers/token.mjs";
import { readBoardAt, seedBoard, useKanban, boardExists, removeBoard } from "./helpers/board.mjs";

// #83b: HTTP routes need the server token now; tf = fetch + the kb_auth cookie.
const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-unlock-home";
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
		if ((await tf(`http://127.0.0.1:${PORT}/api/kanban`)).ok) break;
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
const SLUG = mod.projectSlugOf(process.cwd());
const boardFile = () => `${HOME_DIR}/.pi/kanban/projects/${SLUG}.json`;
const globalFile = `${HOME_DIR}/.pi/kanban/global.json`;
const readBoard = () => readBoardAt(boardFile());
const get = (path) => tf(`http://127.0.0.1:${PORT}${path}`);
const kanbanJson = async () => (await get("/api/kanban")).json();

const A = "unlock-a";
const B = "unlock-b";
// 2 セッション起こす。もう driver / pin という概念は無い（ownCtx は /kanban take で切替）。
handlers.get("session_start")({}, ctxFor(A));
handlers.get("session_start")({}, ctxFor(B));
seedBoard(boardFile(), { cards: [{ id: 1, text: "最初", col: "todo" }], nextId: 2 });

await check("/api/sessions は消えた（404）", async () => {
	const res = await get("/api/sessions");
	assert.equal(res.status, 404);
});

await check("dashboard に sessions / driver / stats.active は無い", async () => {
	const dash = await (await get("/api/dashboard")).json();
	assert.equal(dash.sessions, undefined, "sessions が残っている");
	assert.equal(dash.driver, undefined, "driver が残っている");
	assert.equal(dash.stats.sessions, undefined);
	assert.equal(dash.stats.active, undefined);
	// #17: 代わりに project / global が loops と halted を持つ。
	for (const row of [dash.project, dash.global]) {
		assert.equal(typeof row.loops, "number", "loops が無い");
		assert.equal(typeof row.halted, "boolean", "halted が無い");
	}
});

await check("/api/kanban は project/global とモードだけを返す", async () => {
	const j = await kanbanJson();
	assert.equal(j.ok, true);
	assert.equal(j.sessionId, undefined, "sessionId が残っている");
	assert.equal(j.session, undefined, "session が残っている");
	assert.deepEqual(Object.keys(j.modes).sort(), ["global", "project"]);
	assert.equal(j.projectId, SLUG);
});

await check("誰も take していなくても project ボードに /api/add が 200", async () => {
	const res = await get(`/api/add?scope=project&text=${encodeURIComponent("A追加")}`);
	assert.equal(res.status, 200);
	assert.ok(readBoard().cards.some((c) => c.text === "A追加"), "project ボードに入っていない");
});

await check("project ボードに /api/rename が 200 で反映される", async () => {
	const res = await get(`/api/rename?scope=project&id=1&text=${encodeURIComponent("改名")}`);
	assert.equal(res.status, 200);
	assert.equal(readBoard().cards.find((c) => c.id === 1).text, "改名");
});

await check("scope 省略（既定 project）でも /api/add が 200", async () => {
	const res = await get(`/api/add?text=${encodeURIComponent("既定スコープ")}`);
	assert.equal(res.status, 200);
	assert.ok(readBoard().cards.some((c) => c.text === "既定スコープ"));
});

await check("global は読み取り専用（#17 で編集口は project だけ）", async () => {
	seedBoard(globalFile, { cards: [], nextId: 1 });
	const res = await get(`/api/add?scope=global&sid=${A}&text=${encodeURIComponent("global 追加")}`);
	assert.equal(res.status, 400);
	const j = await res.json();
	assert.equal(j.ok, false);
	assert.match(String(j.error), /read-only/);
	assert.equal(readBoardAt(globalFile).cards.length, 0, "global に書けてしまった");
});

await check("ディスクに無い project ボードでも /api/add が作る", async () => {
	removeBoard(boardFile());
	assert.equal(boardExists(boardFile()), false, "前提: ボードが無い");
	const res = await get(`/api/add?scope=project&text=${encodeURIComponent("新規")}`);
	assert.equal(res.status, 200);
	assert.ok(readBoardAt(boardFile()), "ボードファイルが作られていない");
	assert.ok(readBoard().cards.some((c) => c.text === "新規"));
});

await check("session_shutdown してもボードは書けるまま（pin は無い）", async () => {
	handlers.get("session_shutdown")();
	const res = await get(`/api/add?scope=project&text=${encodeURIComponent("解放後")}`);
	assert.equal(res.status, 200);
	assert.ok(readBoard().cards.some((c) => c.text === "解放後"));
});

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
// poll timer は session_start を踏んだので動いている。HTTP サーバごと明示終了。
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
