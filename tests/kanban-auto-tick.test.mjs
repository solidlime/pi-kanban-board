// kanban auto-tick の自己検証。フレームワーク無しで `node tests/kanban-auto-tick.test.mjs`。
// 対象: shouldAutoTick / tickCardFor（純関数）と、実タイマー → sendUserMessage の経路。
// HOME と KANBAN_PORT を差し替えるので、本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { readBoardAt, seedBoard, useKanban } from "./helpers/board.mjs";
import { authFetch } from "./helpers/token.mjs";

const HOME_DIR = "/tmp/kb-autotick-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
process.env.HOME = HOME_DIR;
// Windows: os.homedir() prefers USERPROFILE over HOME, so keep them in step or the
// server writes its token to the real profile and this test reads a missing file.
process.env.USERPROFILE = process.env.HOME;
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
	process.env.KANBAN_JITI ?? createRequire(import.meta.url).resolve("jiti"),
);
const jiti = createJiti(import.meta.url);
// KANBAN_TS は Phase 4 前のモジュール（関数が無い）で赤を確認するためだけの差し替え口。
const target = process.env.KANBAN_TS ?? fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url));
const mod = await jiti.import(target);
useKanban(mod);
const { shouldAutoTick, autoTickVerdict, tickCardFor, AUTO_TICK_MS } = mod;

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

// #93: ダッシュボードの「+」で足した TODO は 5 分ゲートを待たない。1 回きりの合図なので
// interval も quiet も飛ばすが、menu / loop-off / no-card / busy / halted は曲げない。
check("forced: true -> interval と quiet を飛ばして fire (reason forced)", () => {
	const v = autoTickVerdict({ ...base, now: MIN, lastTickAt: 0, lastActivityAt: 0, forced: true });
	assert.equal(v.fire, true);
	assert.equal(v.reason, "forced");
	// 実際 quiet ではない（lastActivityAt が新しい）。それでも発火するのが forced。
	assert.equal(v.quiet, false);
});

check("forced は quiet を偽装しない (trace の quiet= は実値)", () => {
	// 直前に喋っていても強制発火は起きる。ただし quiet の値は嘘をつかない（trace が説明できる）。
	const v = autoTickVerdict({ ...base, now: MIN, lastTickAt: 0, lastActivityAt: MIN, forced: true });
	assert.equal(v.fire, true);
	assert.equal(v.reason, "forced");
	assert.equal(v.quiet, false);
});

check("forced でも halted limit -> no fire", () => {
	const v = autoTickVerdict({ ...base, now: MIN, lastActivityAt: 0, halted: "limit", forced: true });
	assert.equal(v.fire, false);
	assert.equal(v.reason, "halted:limit");
});

check("forced でも doingLoop OFF -> no fire", () => {
	assert.equal(autoTickVerdict({ ...base, now: MIN, lastActivityAt: 0, doingLoop: false, forced: true }).fire, false);
});

check("forced でも busy -> no fire", () => {
	assert.equal(autoTickVerdict({ ...base, now: MIN, lastActivityAt: 0, isIdle: false, forced: true }).fire, false);
});

check("forced でも /kanban ダイアログ中 -> no fire", () => {
	assert.equal(autoTickVerdict({ ...base, now: MIN, lastActivityAt: 0, menuOpen: true, forced: true }).fire, false);
});

check("forced 未指定は従来どおり interval で止まる (退行なし)", () => {
	const v = autoTickVerdict({ ...base, now: MIN, lastTickAt: 0, lastActivityAt: 0 });
	assert.equal(v.fire, false);
	assert.equal(v.reason, "interval");
});

check("lastTickAt 0 after loop ON -> fires on next poll (no 5m wait)", () => {
	assert.equal(shouldAutoTick({ ...base, lastTickAt: 0, now: Date.now() }), true);
});

check("GLOBAL: only another session's card -> no fire", () => {
	const cards = [card(7, "doing", "other-session"), card(8, "todo", "me")];
	const picked = tickCardFor(cards, "me");
	assert.equal(picked, undefined, "movedBy !== sid は対象外");
	assert.equal(shouldAutoTick({ ...base, card: picked }), false);
});

check("GLOBAL: own card is picked", () => {
	const cards = [card(7, "doing", "other-session"), card(9, "doing", "me")];
	assert.equal(tickCardFor(cards, "me").id, 9);
});

check("GLOBAL: unstamped card is not picked", () => {
	const cards = [card(3, "doing")];
	assert.equal(tickCardFor(cards, "me"), undefined);
});

// #17: session スコープの「所有権を無視する」特例は無くなった。DOING を拾えるのは
// movedBy が自分と一致するカードだけで、未スタンプは誰も拾わない。
check("movedBy の無い DOING は誰も拾わない", () => {
	const cards = [card(5, "doing"), card(2, "doing"), card(1, "todo")];
	assert.equal(tickCardFor(cards, "me"), undefined);
});
check("自分の所有する DOING は id 昇順で 1 枚", () => {
	const cards = [card(5, "doing", "me"), card(2, "doing", "me"), card(1, "todo", "me")];
	assert.equal(tickCardFor(cards, "me").id, 2);
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
	// #17: poll が見るのは project ボード（cwd の slug）1 枚。switch も同じ slug に載る。
	const SLUG = mod.projectSlugOf(process.cwd());
	const boardPath = `${HOME_DIR}/.pi/kanban/projects/${SLUG}.json`;
	const writeModes = (doingLoop) =>
		writeFileSync(
			modesPath,
			JSON.stringify({ PROJECT: { [SLUG]: { doingLoop, autoPick: false } }, GLOBAL: {} }),
		);
	const writeBoard = (cards) => seedBoard(boardPath, { cards, nextId: 9 });
	// 所有権は movedBy === sid。ここが無いと poll は拾わない。
	const doing = [{ id: 1, text: "tick me", col: "doing", movedBy: SID }];

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

	// (E) #94: 直前に wake した板（interval も quiet も閉じている）に dashboard の「+」で TODO を
	//     足すと、次の tick で 1 回だけ起きる。合図の往復(/api/add -> userPickAt -> poll)は
	//     ここでしか実経路を通らない: 文字列一致のテストでは delete の位置や > の向きを守れない。
	const beforeCue = sent.length;
	await authFetch("http://127.0.0.1:" + process.env.KANBAN_PORT + "/api/add?p=" + SLUG + "&text=from+dashboard");
	await sleep(1800);
	assert.equal(sent.length, beforeCue + 1, "forced wake expected, got " + (sent.length - beforeCue));
	// (F) 合図は 1 回きり -> 次の tick は 5 分ゲートに戻る。
	await sleep(1800);
	assert.equal(sent.length, beforeCue + 1, "cue must fire once, got " + (sent.length - beforeCue));
}

try {
	await liveTick();
	passed += 1;
} catch (err) {
	failures.push(`live timer -> sendUserMessage: ${err.message}`);
}

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
