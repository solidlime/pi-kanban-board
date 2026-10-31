// kanban Phase 11 の自己検証。フレームワーク無しで `node tests/kanban-phase11.test.mjs`。
// 対象: GLOBAL TODO の所有判定。DOING は headOwnedDoing で movedBy===sid に絞っているが、
// TODO は「まだ誰も着手していない」ので movedBy 無しも拾える。他セッションが /api/move で
// 宣言済みの GLOBAL TODO は奪わない。poll の wake と pickFirstTodo は同じカードを選ぶ。
// HOME と KANBAN_PORT を差し替えるので、本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";

const HOME_DIR = "/tmp/kb-phase11-home";
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
const { nextTodo, continuationPrompt, tickCardFor, pickFirstTodo } = mod;

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

const MODES = `${HOME_DIR}/.pi/kanban/modes.json`;
const GLOBAL = `${HOME_DIR}/.pi/kanban/global.json`;
const boardFile = (sid) => `${HOME_DIR}/.pi/kanban/sessions/${sid}.json`;
const writeBoardFile = (sid, cards) =>
	writeFileSync(boardFile(sid), JSON.stringify({ cards, nextId: 90 }, null, 2));
const writeGlobalFile = (cards) => writeFileSync(GLOBAL, JSON.stringify({ cards, nextId: 90 }, null, 2));
const readCards = (sid) => JSON.parse(readFileSync(boardFile(sid), "utf8")).cards;
const readGlobal = () => JSON.parse(readFileSync(GLOBAL, "utf8")).cards;
const readModes = () => JSON.parse(readFileSync(MODES, "utf8"));

// 全セッション分を毎回書き戻す: poll は 1.5s ごとに modes.json を読み直す。
const modesState = { SESSION: {}, GLOBAL: {} };
const writeModes = () => writeFileSync(MODES, JSON.stringify(modesState, null, 2));
const setModes = (sid, scope, doingLoop, autoPick) => {
	modesState[scope][sid] = { doingLoop, autoPick };
	writeModes();
};

const S = "phase11-me";
const OTHER = "phase11-other";

// ---------------------------------------------------------------------------
// 1-5: nextTodo の選定（純関数。TODO に所有フィルタは無い）
// ---------------------------------------------------------------------------
check("1 GLOBAL TODO: movedBy 無し -> 拾える", () =>
	eq(nextTodo([{ id: 1, text: "free", col: "todo" }], "global", S)?.id, 1));
check("2 GLOBAL TODO: movedBy === sid -> 拾える", () =>
	eq(nextTodo([{ id: 1, text: "mine", col: "todo", movedBy: S }], "global", S)?.id, 1));
check("3 #87 GLOBAL TODO: movedBy === 他者でも拾う（TODO は所有を持たない）", () =>
	eq(nextTodo([{ id: 1, text: "theirs", col: "todo", movedBy: OTHER, priority: 9 }], "global", S)?.id, 1));
check("4 #87 GLOBAL: 所有でなく priority 順で選ぶ（他者スタンプが先頭）", () =>
	eq(
		nextTodo(
			[
				{ id: 1, text: "theirs", col: "todo", movedBy: OTHER, priority: 9 },
				{ id: 2, text: "free", col: "todo", priority: 1 },
			],
			"global",
			S,
		)?.id,
		1,
	));
check("4b #87 GLOBAL: 他者所有の TODO だけでも拾う", () =>
	eq(
		nextTodo(
			[
				{ id: 1, text: "theirs", col: "todo", movedBy: OTHER, priority: 9 },
				{ id: 2, text: "theirs2", col: "todo", movedBy: OTHER },
			],
			"global",
			S,
		)?.id,
		1,
	));
check("5 SESSION TODO: movedBy 無しでも拾える（既存挙動）", () =>
	eq(nextTodo([{ id: 1, text: "t", col: "todo" }], "session", S)?.id, 1));
check("5b SESSION TODO: movedBy === 他者でも拾える（自分の看板。既存挙動）", () =>
	eq(nextTodo([{ id: 1, text: "t", col: "todo", movedBy: OTHER }], "session", S)?.id, 1));

// ---------------------------------------------------------------------------
// ライブ経路: 実タイマー poll -> sendUserMessage / agent_before_settle -> 実ファイル
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startSession(sid, sessionEntries = []) {
	const handlers = new Map();
	const sent = [];
	const entries = [];
	const pi = {
		registerCommand() {},
		registerTool() {},
		appendEntry(customType, data) {
			entries.push({ customType, data: JSON.parse(JSON.stringify(data)) });
		},
		on(ev, fn) {
			handlers.set(ev, fn);
		},
		sendUserMessage(content) {
			sent.push(content);
		},
	};
	mod.default(pi); // server は空きポートで 1 回だけ立ち、HOME は /tmp 配下
	const ctx = {
		hasUI: false,
		isIdle: () => true,
		ui: { notify() {}, setWidget() {} },
		sessionManager: {
			getSessionId: () => sid,
			getEntries: () => sessionEntries,
		},
	};
	handlers.get("session_start")({}, ctx);
	return { handlers, sent, entries, ctx };
}
const settle = (sess) =>
	sess.handlers.get("agent_before_settle")({ context: { contextMessages: [{ role: "assistant" }] } }, sess.ctx);

try {
	// --- (A) 6: GLOBAL の wake カード = pickFirstTodo の結果（#87: 他者スタンプも拾う） ---
	const A = "phase11-a";
	const sessA = startSession(A);
	setModes(A, "SESSION", true, true);
	setModes(A, "GLOBAL", true, true);
	writeBoardFile(A, []); // SESSION は空 -> GLOBAL を見る
	writeGlobalFile([
		{ id: 1, text: "mine", col: "todo" },
		{ id: 2, text: "theirs", col: "todo", movedBy: OTHER, priority: 9 },
	]);
	await sleep(2000);
	assert.equal(sessA.sent.length, 1, `GLOBAL の拾える TODO で 1 回 wake するはず: ${JSON.stringify(sessA.sent)}`);
	const want = { id: 2, text: "theirs", col: "todo", movedBy: OTHER, priority: 9 };
	assert.equal(sessA.sent[0], continuationPrompt(want, "global"), "wake は priority 9 の #2");
	assert.match(sessA.sent[0], /^GLOBAL TODO #2 "theirs" を着手しろ。/);
	assert.equal(readGlobal().find((c) => c.id === 2).col, "todo", "poll は盤面を書かない");
	const picked = pickFirstTodo(A, "global");
	assert.ok(picked, "pickFirstTodo は GLOBAL の拾える TODO を返す");
	assert.equal(picked.id, 2, "poll の wake と pickFirstTodo は同じカード");
	assert.equal(readGlobal().find((c) => c.id === 2).col, "doing", "pickFirstTodo は実際に DOING へ移す");
	assert.equal(readGlobal().find((c) => c.id === 2).movedBy, A, "着手した A が所有を取る");
	assert.equal(readGlobal().find((c) => c.id === 1).col, "todo", "選ばれなかった #1 は動かない");
	passed += 1;

	// --- (B) 7: #87 settle は GLOBAL の他者スタンプ TODO も拾って DOING にする ---
	const B = "phase11-b";
	const sessB = startSession(B);
	setModes(B, "SESSION", true, true);
	setModes(B, "GLOBAL", true, true);
	writeBoardFile(B, []); // SESSION に拾う TODO なし
	writeGlobalFile([{ id: 5, text: "theirs", col: "todo", movedBy: OTHER, priority: 9 }]);
	const resB = settle(sessB);
	assert.equal(readGlobal().find((c) => c.id === 5).col, "doing", `settle が他者スタンプ GLOBAL TODO を拾わなかった: ${JSON.stringify(readGlobal())}`);
	assert.equal(readGlobal().find((c) => c.id === 5).movedBy, B, "拾った B が所有を取る");
	assert.ok(resB && resB.continue === true, "拾った以上 settle は続行する");
	passed += 1;

	// --- (C) 陽性対照: 同じ経路で movedBy 無し GLOBAL TODO は settle が拾う ---------
	writeGlobalFile([{ id: 6, text: "free", col: "todo" }]);
	settle(sessB);
	const movedC = readGlobal().find((c) => c.id === 6);
	assert.equal(movedC.col, "doing", `movedBy 無し GLOBAL TODO は settle が拾うはず: ${JSON.stringify(readGlobal())}`);
	assert.equal(movedC.movedBy, B, "pickFirstTodo が movedBy を自分の sid でスタンプする");
	passed += 1;

	// --- (D) 陽性対照: movedBy === 自分 の GLOBAL TODO も拾う ---------------------
	writeGlobalFile([{ id: 7, text: "mine", col: "todo", movedBy: B }]);
	settle(sessB);
	assert.equal(readGlobal().find((c) => c.id === 7).col, "doing", "movedBy===sid は拾える");
	passed += 1;

	// --- (E) SESSION の既存挙動は不変: 他者所有 TODO もこの看板では拾う -----------
	const E = "phase11-e";
	const sessE = startSession(E);
	setModes(E, "SESSION", true, true);
	writeBoardFile(E, [{ id: 3, text: "theirs-in-session", col: "todo", movedBy: OTHER, priority: 9 }]);
	writeGlobalFile([]);
	const resE = settle(sessE);
	assert.equal(readCards(E).find((c) => c.id === 3).col, "doing", "SESSION 看板は movedBy に関係なく拾う");
	assert.ok(resE && resE.continue === true, "SESSION TODO 経由の settle は続行する");
	passed += 1;

	// --- (F) 純関数の poll と同じ式の一致（TODO に所有フィルタは無い） -------------
	const pollPick = (cards, sid, scope) =>
		tickCardFor(cards, scope, sid) ?? nextTodo(cards, scope, sid);
	check("6 純関数: poll の wake 選定 = nextTodo（GLOBAL 他者スタンプあり）", () => {
		const cards = [
			{ id: 1, text: "mine", col: "todo" },
			{ id: 2, text: "theirs", col: "todo", movedBy: OTHER, priority: 9 },
		];
		eq(pollPick(cards, S, "global")?.id, nextTodo(cards, "global", S)?.id);
		eq(pollPick(cards, S, "global")?.id, 2); // #87: priority 9 の他者スタンプが先頭
	});
} catch (err) {
	failures.push(`live: ${err.message}`);
}

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
