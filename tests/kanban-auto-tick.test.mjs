// kanban auto-tick の自己検証。フレームワーク無しで `node tests/kanban-auto-tick.test.mjs`。
// 対象: shouldAutoTick / tickCardFor（純関数）と、実タイマー → sendUserMessage の経路。
// HOME と KANBAN_PORT を差し替えるので、本番の ~/.pi/kanban と 8789 には触れない。
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";

const HOME_DIR = "/tmp/kb-autotick-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
process.env.HOME = HOME_DIR;
// Free port before the module reads KANBAN_PORT at import time.
process.env.KANBAN_PORT = String(
	await new Promise((resolve) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	}),
);

// dist/jiti.cjs は壊れているので lib/jiti.cjs を使う。
const require = createRequire(import.meta.url);
const { createJiti } = require(
	"/root/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.cjs",
);
const jiti = createJiti(import.meta.url);
// KANBAN_TS は Phase 4 前のモジュール（関数が無い）で赤を確認するためだけの差し替え口。
const target = process.env.KANBAN_TS ?? new URL("../extensions/kanban.ts", import.meta.url).pathname;
const mod = await jiti.import(target);
const { shouldAutoTick, tickCardFor, AUTO_TICK_MS } = mod;

const MIN = 60_000;
const card = (id, col, movedBy) => (movedBy === undefined ? { id, col } : { id, col, movedBy });

// 発火条件の既定値: アイドル・loop ON・DOING あり・halt 無し・経過 5 分ちょうど。
// Phase 8: lastActivityAt も必須。0 は「活動の記録なし」= 5 分以上静止と同じ扱。
const base = {
	isIdle: true,
	doingLoop: true,
	card: card(1, "doing"),
	halted: null,
	lastTickAt: 0,
	lastActivityAt: 0,
	now: 5 * MIN,
};

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

check("AUTO_TICK_MS is 5 minutes", () => {
	assert.equal(AUTO_TICK_MS, 5 * MIN);
});

check("baseline fires", () => {
	assert.equal(shouldAutoTick(base), true);
});

check("isIdle: false -> no fire (agent is running)", () => {
	assert.equal(shouldAutoTick({ ...base, isIdle: false }), false);
});

check("doingLoop: false -> no fire", () => {
	assert.equal(shouldAutoTick({ ...base, doingLoop: false }), false);
});

check("no DOING card -> no fire (zero turns spent)", () => {
	assert.equal(shouldAutoTick({ ...base, card: undefined }), false);
});

check("elapsed 4m59s -> no fire", () => {
	assert.equal(shouldAutoTick({ ...base, now: 5 * MIN - 1000 }), false);
});

check("elapsed exactly 5m -> fire (>= boundary)", () => {
	assert.equal(shouldAutoTick({ ...base, now: 5 * MIN }), true);
});

check("halted stuck -> no fire", () => {
	assert.equal(shouldAutoTick({ ...base, halted: "stuck" }), false);
});

check("halted limit -> no fire", () => {
	assert.equal(shouldAutoTick({ ...base, halted: "limit" }), false);
});

check("lastTickAt 0 after loop ON -> fires on next poll (no 5m wait)", () => {
	assert.equal(shouldAutoTick({ ...base, lastTickAt: 0, now: Date.now() }), true);
});

check("GLOBAL: only another session's card -> no fire", () => {
	const cards = [card(7, "doing", "other-session"), card(8, "todo", "me")];
	const picked = tickCardFor(cards, "global", "me");
	assert.equal(picked, undefined, "movedBy !== sid は対象外");
	assert.equal(shouldAutoTick({ ...base, card: picked }), false);
});

check("GLOBAL: own card is picked", () => {
	const cards = [card(7, "doing", "other-session"), card(9, "doing", "me")];
	assert.equal(tickCardFor(cards, "global", "me").id, 9);
});

check("GLOBAL: unstamped card is not picked", () => {
	const cards = [card(3, "doing")];
	assert.equal(tickCardFor(cards, "global", "me"), undefined);
});

check("SESSION: any DOING card is picked, lowest id first", () => {
	const cards = [card(5, "doing"), card(2, "doing"), card(1, "todo")];
	assert.equal(tickCardFor(cards, "session", "me").id, 2);
});

check("default export is the extension factory", () => {
	assert.equal(typeof mod.default, "function");
});

// ---------------------------------------------------------------------------
// 実タイマー経路: poll が 1.5s ごとに回り、DOING + loop ON で sendUserMessage を 1 回呼ぶ。
// ---------------------------------------------------------------------------
const SID = "tick-test-sid";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function liveTick() {
	const handlers = new Map();
	const sent = [];
	const pi = {
		registerCommand() {},
		registerTool() {},
		appendEntry() {},
		on(ev, fn) {
			handlers.set(ev, fn);
		},
		// 同期 dispatch の模擬: 戻り値は void。
		sendUserMessage(content) {
			sent.push(content);
		},
	};
	mod.default(pi); // server は KANBAN_PORT (空き) で立ち、HOME は /tmp 配下
	const ctx = {
		hasUI: false, // refresh は no-op
		isIdle: () => true,
		ui: { notify() {}, setWidget() {} },
		sessionManager: { getSessionId: () => SID, getEntries: () => [] },
	};
	handlers.get("session_start")({}, ctx);

	// session_start が作った modes.json を上書き。
	const modesPath = `${HOME_DIR}/.pi/kanban/modes.json`;
	const boardPath = `${HOME_DIR}/.pi/kanban/sessions/${SID}.json`;
	const writeModes = (doingLoop) =>
		writeFileSync(
			modesPath,
			JSON.stringify({ SESSION: { [SID]: { doingLoop, autoPick: false } }, GLOBAL: {} }),
		);
	const writeBoard = (cards) => writeFileSync(boardPath, JSON.stringify({ cards, nextId: 9 }));
	const doing = [{ id: 1, text: "tick me", col: "doing" }];

	// (A) doingLoop OFF + DOING あり -> 1 ターンも消費しない。
	writeModes(false);
	writeBoard(doing);
	await sleep(1800);
	assert.equal(sent.length, 0, `OFF must not wake (got ${sent.length})`);

	// (B) doingLoop ON + DOING 空 -> 消費しない。
	writeModes(true);
	writeBoard([]);
	await sleep(1800);
	assert.equal(sent.length, 0, `empty DOING must not wake (got ${sent.length})`);

	// (C) doingLoop ON + DOING あり -> 発火 (lastTickAt はまだ 0)。
	writeBoard(doing);
	await sleep(1800);
	assert.equal(sent.length, 1, `expected exactly 1 wake, got ${sent.length}`);
	assert.match(sent[0], /#1 "tick me" を完了させろ/);

	// (D) 5 分は経っていない -> 追加発火なし。
	await sleep(1800);
	assert.equal(sent.length, 1, `second poll must not fire: got ${sent.length}`);
}

try {
	await liveTick();
	passed += 1;
} catch (err) {
	failures.push(`live timer -> sendUserMessage: ${err.message}`);
}

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
