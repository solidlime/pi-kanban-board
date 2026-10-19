// kanban Phase 6 の自己検証。フレームワーク無しで `node tests/kanban-phase6.test.mjs`。
// 対象: stuckLimitOf / isValidStuckLimit の境界 / parseKanbanArgs の stuck 分岐と
// 既存ケースの非破壊 / nextStuckState（実装が使う閾値判定の純関数）/ GET /api/stuck。
// HOME と KANBAN_PORT を差し替えるので、本番の ~/.pi/kanban と 8789 には触れない。
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { authFetch } from "./helpers/token.mjs";

// #83b: HTTP routes need the server token now; tf = fetch + the kb_token cookie.
const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-phase6-home";
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

// dist/jiti.cjs は壊れているので lib/jiti.cjs を使う（既存テストと同じ経路）。
const require = createRequire(import.meta.url);
const { createJiti } = require(
	"/root/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.cjs",
);
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(new URL("../extensions/kanban.ts", import.meta.url).pathname);
const { parseKanbanArgs, isValidStuckLimit, stuckLimitOf, nextStuckState } = mod;

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
const eq = (a, b) => assert.deepEqual(a, b);

// --- 1/2: 境界値テーブル（stuckLimitOf と isValidStuckLimit を同じ表で回す） ---------
// [入力, 期待する stuckLimitOf, 期待する isValidStuckLimit]
const TABLE = [
	[undefined, 3, false],
	[1, 1, true],
	[20, 20, true],
	[0, 3, false],
	[21, 3, false],
	[-1, 3, false],
	[2.5, 3, false],
	[NaN, 3, false],
	[Infinity, 3, false],
	["3", 3, false],
	[null, 3, false],
];
for (const [input, expected, valid] of TABLE) {
	const label = typeof input === "string" ? JSON.stringify(input) : String(input);
	check(`stuckLimitOf({stuckLimit:${label}}) -> ${expected}`, () =>
		assert.equal(stuckLimitOf({ stuckLimit: input }), expected));
	check(`isValidStuckLimit(${label}) -> ${valid}`, () =>
		assert.equal(isValidStuckLimit(input), valid));
}
check("stuckLimitOf({}) -> 3（キー無し）", () => assert.equal(stuckLimitOf({}), 3));

// --- 3: parseKanbanArgs の stuck 分岐 -------------------------------------------
check("［stuck 5］ -> {stuck, session, 5}", () =>
	eq(parseKanbanArgs(["stuck", "5"]), { kind: "stuck", scope: "session", count: 5 }));
check("［stuck global 7］ -> {stuck, global, 7}", () =>
	eq(parseKanbanArgs(["stuck", "global", "7"]), { kind: "stuck", scope: "global", count: 7 }));
check("［stuck］ -> stuckStatus session", () =>
	eq(parseKanbanArgs(["stuck"]), { kind: "stuckStatus", scope: "session" }));
check("［stuck global］ -> stuckStatus global", () =>
	eq(parseKanbanArgs(["stuck", "global"]), { kind: "stuckStatus", scope: "global" }));
for (const bad of ["0", "21", "abc", "2.5", "-1"]) {
	check(`［stuck ${JSON.stringify(bad)}］ -> reject`, () => {
		const r = parseKanbanArgs(["stuck", bad]);
		assert.equal(r.kind, "reject");
		assert.match(r.reason, /1〜20の整数/);
	});
}
check("境界の 1 と 20 は通る", () => {
	assert.equal(parseKanbanArgs(["stuck", "1"]).count, 1);
	assert.equal(parseKanbanArgs(["stuck", "20"]).count, 20);
	assert.equal(parseKanbanArgs(["stuck", "global", "1"]).scope, "global");
});

// --- 3b: 既存（非 stuck）ケースが壊れていないこと --------------------------------
check("［買い物］ -> add", () => eq(parseKanbanArgs(["買い物"]), { kind: "add", text: "買い物" }));
check("［interval 3］ -> interval", () =>
	eq(parseKanbanArgs(["interval", "3"]), { kind: "interval", scope: "session", minutes: 3 }));
check("［loop on］ -> mode", () =>
	eq(parseKanbanArgs(["loop", "on"]), { kind: "mode", key: "doingLoop", value: true }));
check("［］ -> menu", () => eq(parseKanbanArgs([]), { kind: "menu" }));

// --- 4: 閾値の実動作。実装が driving card に使う判定をそのまま回す ---------------
// stuckLimitOf の既定は 3、nextStuckState が「同じカードが n 回連続で DOING のまま」を
// 数え、stuckCount >= limit で stuck。0 回（settle 前）は state を作らない = halt しない。
const CARD = 42;
function settle(n, limit) {
	let s = { scope: null, stuckId: null, stuckCount: 0 };
	for (let i = 0; i < n; i++) s = nextStuckState(s, CARD, "session", limit);
	// n === 0 は「まだ settle していない」= halted は null のまま。
	return { stuckCount: n === 0 ? 0 : s.stuckCount, stuck: n === 0 ? false : s.stuck };
}
const halted = (n, limit) => (settle(n, limit).stuck ? "stuck" : null);

for (const [limit, below] of [
	[1, 0],
	[3, 2],
	[5, 4],
	[20, 19],
]) {
	check(`limit=${limit}: ${below}回では halted しない`, () => {
		assert.equal(halted(below, limit), null);
		assert.equal(settle(below, limit).stuck, false);
	});
	check(`limit=${limit}: ${limit}回で halted:"stuck"`, () => {
		assert.equal(halted(limit, limit), "stuck");
		assert.equal(settle(limit, limit).stuckCount, limit);
	});
}
check("limit=1: 1回目から halt（0回は halt しない）", () => {
	assert.equal(halted(0, 1), null);
	assert.equal(halted(1, 1), "stuck");
});
check("別カードへ進むと連続数は 1 に戻る（進捗でリセット）", () => {
	let s = settle(3, 3);
	assert.equal(s.stuck, true);
	// 次に別カードが driving になった settle: 連続数は 1 から数え直す。
	s = nextStuckState({ scope: "session", stuckId: CARD, stuckCount: 3 }, 43, "session", 3);
	assert.equal(s.stuckCount, 1);
	assert.equal(s.stuck, false);
});
check("scope が変われば同じ id でも数え直す", () => {
	const s = nextStuckState({ scope: "session", stuckId: CARD, stuckCount: 2 }, CARD, "global", 3);
	assert.equal(s.stuckCount, 1);
	assert.equal(s.stuck, false);
});
check("既定 3 は stuckLimitOf 経由で nextStuckState に届く", () => {
	const limit = stuckLimitOf({ doingLoop: true, autoPick: false });
	assert.equal(halted(2, limit), null);
	assert.equal(halted(3, limit), "stuck");
});

// --- 5: GET /api/stuck（実サーバを空きポートで立てる） ---------------------------
const handlers = new Map();
const commands = new Map();
const pi = {
	registerCommand(name, def) {
		commands.set(name, def);
	},
	registerTool() {},
	appendEntry() {},
	on(ev, fn) {
		handlers.set(ev, fn);
	},
	sendUserMessage() {},
};
mod.default(pi); // ensureServer() はここで走る
for (let i = 0; i < 40; i++) {
	try {
		if ((await tf(`http://127.0.0.1:${PORT}/api/kanban`)).ok) break;
	} catch {
		// まだ listen していない
	}
	await new Promise((r) => setTimeout(r, 100));
}

const SID = "phase6-sid";
const modesFile = `${HOME_DIR}/.pi/kanban/modes.json`;
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

// #40: the panel's default sid is pinned by the first session_start, not by a
// sidOf side effect. Drive the real event instead of relying on /kanban help.
{
	const notes = [];
	handlers.get("session_start")({}, {
		hasUI: false,
		isIdle: () => false,
		ui: { notify(m) { notes.push(m); }, setWidget() {} },
		sessionManager: { getSessionId: () => SID, getEntries: () => [] },
	});
}

const api = (q) => tf(`http://127.0.0.1:${PORT}/api/stuck?${q}`);
{
	const res = await api(`sid=${SID}&scope=session&n=5`);
	const body = await res.json();
	check("GET /api/stuck?n=5 -> 200 かつ modes.json に 5", () => {
		assert.equal(res.status, 200);
		assert.equal(body.ok, true);
		assert.equal(readJson(modesFile).SESSION[SID].stuckLimit, 5);
	});
}
for (const bad of ["0", "21", "abc"]) {
	const res = await api(`scope=session&n=${bad}`);
	const body = await res.json();
	check(`GET /api/stuck?n=${bad} -> 400 かつ現状維持（5）`, () => {
		assert.equal(res.status, 400);
		assert.equal(body.ok, false);
		assert.equal(readJson(modesFile).SESSION[SID].stuckLimit, 5);
	});
}
{
	const res = await api(`scope=global&n=7`);
	await res.text();
	check("GET /api/stuck?scope=global&n=7 -> 200 かつ GLOBAL に 7", () => {
		assert.equal(res.status, 200);
		assert.equal(readJson(modesFile).GLOBAL[SID].stuckLimit, 7);
	});
}
{
	const otherRes = await api(`sid=other-session&scope=session&n=3`);
	const otherBody = await otherRes.json();
	const intervalRes = await tf(
		`http://127.0.0.1:${PORT}/api/interval?scope=session&sid=other-session&min=3`,
	);
	const intervalBody = await intervalRes.json();
	check("GET /api/stuck 他セッション -> 200 かつ他セッションの settle 数が書かれる", () => {
		// #55: セッション単位の書き込みロックは無い。
		assert.equal(otherRes.status, 200);
		assert.equal(otherBody.ok, true);
		assert.equal(readJson(modesFile).SESSION["other-session"].stuckLimit, 3);
		// 同じゲートを持っていた interval も同じく書ける
		assert.equal(intervalRes.status, 200);
		assert.equal(intervalBody.ok, true);
	});
}

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
// poll timer は session_start を踏んでいないので未生成。HTTP サーバだけが残るので明示終了。
process.exit(failures.length === 0 ? 0 : 1);
