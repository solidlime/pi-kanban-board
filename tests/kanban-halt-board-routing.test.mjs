// #110: ダッシュボードの「一時停止/再開」は板の名前（p=）で来るが、halt はボードファイルではなく
// セッションのメモリ（+ JSONL）に載る。ここは p= が「その板を持つセッション」に解決されること、
// 行の halted/loops が板のオーナーを映すこと、板を持たない p が従来どおりであることを見る。
// ドライバ（A、リポジトリ cwd）と止まっている板の持ち主（B、別 cwd）を分けて張るので、
// "最後に session_start したセッション" に付け替える実装はここで落ちる。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { authFetch } from "./helpers/token.mjs";
import { seedBoard, useKanban } from "./helpers/board.mjs";

const HOME_DIR = "/tmp/kb-halt-board-routing";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
process.env.HOME = HOME_DIR;
// Windows: os.homedir() prefers USERPROFILE over HOME, so keep them in step.
process.env.USERPROFILE = process.env.HOME;
const PORT = await new Promise((resolve) => {
	const s = createServer();
	s.listen(0, "127.0.0.1", () => {
		const { port } = s.address();
		s.close(() => resolve(port));
	});
});
process.env.KANBAN_PORT = String(PORT);
const BASE = `http://127.0.0.1:${PORT}`;

const require = createRequire(import.meta.url);
const { createJiti } = require(
	process.env.KANBAN_JITI ?? createRequire(import.meta.url).resolve("jiti"),
);
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url)));
useKanban(mod);

const failures = [];
let passed = 0;
function check(name, fn) {
	try {
		fn();
		passed += 1;
	} catch (err) {
		failures.push(`${name}: ${err.message}`);
	}
}
const get = async (path) => {
	const r = await authFetch(`${BASE}${path}`);
	return { status: r.status, body: await r.json() };
};

const MODES = `${HOME_DIR}/.pi/kanban/modes.json`;
// Two boards: A is the repo itself (the driver's cwd), B is a directory of its own. Only the
// cwd differs, so a board key can only be told apart by asking which session lives there.
const A_DIR = process.cwd();
const B_DIR = `${HOME_DIR}/repo-b`;
mkdirSync(B_DIR, { recursive: true });
const A_KEY = mod.projectSlugOf(A_DIR);
const B_KEY = mod.projectSlugOf(B_DIR);
const A_FILE = `${HOME_DIR}/.pi/kanban/projects/${A_KEY}.json`;
const B_FILE = `${HOME_DIR}/.pi/kanban/projects/${B_KEY}.json`;
assert.notEqual(A_KEY, B_KEY, "the two test boards must not share a key");

function mkPi() {
	const handlers = new Map();
	const appended = [];
	const pi = {
		registerCommand() {},
		registerTool() {},
		appendEntry(type, data) {
			appended.push({ type, data });
		},
		on(ev, fn) {
			handlers.set(ev, fn);
		},
		sendUserMessage() {},
	};
	return { pi, handlers, appended };
}

// getCwd is what #110 turns on: without it every session reads as process.cwd(), i.e. board A,
// and no test could tell the driver from the session that owns the other board.
function mkCtx(sid, cwd, entries = []) {
	return {
		hasUI: false,
		isIdle: () => true,
		ui: { notify() {}, setWidget() {} },
		sessionManager: {
			getSessionId: () => sid,
			getSessionName: () => undefined,
			getEntries: () => entries,
			getCwd: () => cwd,
		},
	};
}

const loopEntry = (count, halted = null) => ({
	type: "custom",
	customType: "kanban-loop",
	data: { count, halted, scope: null, stuckId: null, stuckCount: 0, lastActivityAt: Date.now() },
});

const SID_A = "sid-driver";
const SID_B = "sid-nous";
// One extension instance per session: loop state is closure state, so two sessions need two.
const runA = mkPi();
const tA = mod.default(runA.pi).__test;
const runB = mkPi();
const tB = mod.default(runB.pi).__test;

seedBoard(A_FILE, { cards: [], nextId: 1 });
seedBoard(B_FILE, { cards: [{ id: 1, text: "nous", col: "doing", movedBy: SID_B }], nextId: 2 });
writeFileSync(
	MODES,
	JSON.stringify(
		{
			PROJECT: {
				[A_KEY]: { doingLoop: true, autoPick: false },
				[B_KEY]: { doingLoop: true, autoPick: false },
			},
			GLOBAL: {},
		},
		null,
		2,
	),
);
// B first, then A: the pin belongs to the FIRST start of each instance and the LAST pin wins
// process-wide, so A ends up the driver - exactly the live case (the driver is not the board
// that stopped).
runB.handlers.get("session_start")({ type: "session_start" }, mkCtx(SID_B, B_DIR, [loopEntry(2)]));
runA.handlers.get("session_start")({ type: "session_start" }, mkCtx(SID_A, A_DIR));

{
	const r = await get(`/api/halt?scope=project&p=${B_KEY}`);
	check("/api/halt?p=<B> は 202（要求の受け方は従来どおり）", () => {
		assert.equal(r.status, 202, JSON.stringify(r.body));
		assert.equal(r.body.queued, true, JSON.stringify(r.body));
	});
	check("halt は板を持つセッション（B）に積まれ、ドライバ（A）には積まれない", () => {
		assert.equal(tB.haltRequests.has(SID_B), true, `keys=${[...tB.haltRequests]}`);
		assert.equal(tB.haltRequests.has(SID_A), false, `keys=${[...tB.haltRequests]}`);
	});
	check("板の名前そのものは sid として積まれない（#17 の不変）", () => {
		assert.equal(tB.haltRequests.has(B_KEY), false, `keys=${[...tB.haltRequests]}`);
	});
}

// 実際の halt はセッションのメモリなので、そのセッションの poll が消費して初めて動く。
tB.poll();
check("B の poll が自分の halt 要求を消費する", () => assert.equal(tB.haltRequests.has(SID_B), false));

{
	const b = await get(`/api/kanban?p=${B_KEY}`);
	check("/api/kanban?p=<B> は halted:true（板のオーナーが止まっている）", () =>
		assert.equal(b.body.project.halted, true, JSON.stringify(b.body.project)));
	check("/api/kanban?p=<B> の loops は板のオーナーの消費数（2）", () =>
		assert.equal(b.body.project.loops, 2, JSON.stringify(b.body.project)));
	check("halt は B の doingLoop だけを落とす", () => {
		const modes = JSON.parse(readFileSync(MODES, "utf8")).PROJECT;
		assert.equal(modes[B_KEY].doingLoop, false, JSON.stringify(modes));
		assert.equal(modes[A_KEY].doingLoop, true, JSON.stringify(modes));
	});
	const d = await get("/api/dashboard");
	check("/api/dashboard（ドライバ A の板）は halted:false のまま", () =>
		assert.equal(d.body.project.halted, false, JSON.stringify(d.body.project)));
	check("/api/dashboard の loops は A のもの（B の 2 を借りない）", () =>
		assert.equal(d.body.project.loops, 0, JSON.stringify(d.body.project)));
}

{
	const r = await get(`/api/resume?scope=project&p=${B_KEY}`);
	check("/api/resume?p=<B> は 202", () => {
		assert.equal(r.status, 202, JSON.stringify(r.body));
		assert.equal(r.body.queued, true, JSON.stringify(r.body));
	});
	check("resume も板を持つセッション（B）に積まれる", () => {
		assert.equal(tB.resumeRequests.get(SID_B), 1, `keys=${[...tB.resumeRequests]}`);
		assert.equal(tB.resumeRequests.has(SID_A), false, `keys=${[...tB.resumeRequests]}`);
	});
}

tB.poll();
{
	const b = await get(`/api/kanban?p=${B_KEY}`);
	check("resume 後は halted:false / loops 0", () => {
		assert.equal(b.body.project.halted, false, JSON.stringify(b.body.project));
		assert.equal(b.body.project.loops, 0, JSON.stringify(b.body.project));
	});
	const modes = JSON.parse(readFileSync(MODES, "utf8")).PROJECT;
	check("resume は B の doingLoop を ON に戻す", () =>
		assert.equal(modes[B_KEY].doingLoop, true, JSON.stringify(modes)));
}

// フォールバックの回帰: どのセッションも持っていない板（sidsOnBoard が空）は従来どおり
// ドライバに積む（その板を読むプロセスが無いので、実際には誰も消費しない）。
{
	const r = await get("/api/halt?scope=project&p=nobody-has-this-board");
	check("板を持たない p の halt はドライバに積まれる（従来動作）", () => {
		assert.equal(r.status, 202, JSON.stringify(r.body));
		assert.equal(tB.haltRequests.has(SID_A), true, `keys=${[...tB.haltRequests]}`);
		assert.equal(tB.haltRequests.has(SID_B), false, `keys=${[...tB.haltRequests]}`);
	});
	tB.haltRequests.delete(SID_A);
	const s = await get("/api/resume?scope=project&p=nobody-has-this-board");
	check("板を持たない p の resume もドライバに積まれる（従来動作）", () => {
		assert.equal(s.status, 202, JSON.stringify(s.body));
		assert.equal(tB.resumeRequests.get(SID_A), 1, `keys=${[...tB.resumeRequests]}`);
	});
	tB.resumeRequests.delete(SID_A);
}

if (failures.length) {
	console.error(`kanban-halt-board-routing: ${passed} passed, ${failures.length} failed`);
	for (const f of failures) console.error("FAIL " + f);
	process.exit(1);
}
console.log(`kanban-halt-board-routing: ${passed} passed`);
runA.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" });
runB.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" });
setTimeout(() => process.exit(0), 100);
