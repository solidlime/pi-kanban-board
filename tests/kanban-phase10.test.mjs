// kanban Phase 10 の自己検証。フレームワーク無しで `node tests/kanban-phase10.test.mjs`。
// 対象: TODO のみ + DOING 空 + autoPick ON の静止で poll が TODO を wake するか /
// TODO 用 continuationPrompt / agent_before_settle の autoPick が DOING ありでも
// TODO を 1 枚だけ拾い loop.count++ を通るか。
// HOME と KANBAN_PORT を差し替えるので、本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { readBoardAt, seedBoard, useKanban } from "./helpers/board.mjs";
import { settleMigration, useMigrate } from "./helpers/migrate.mjs";

const HOME_DIR = "/tmp/kb-phase10-home";
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
// 起動時 migration は fire-and-forget。seed より先に消化しないと、seed した session/global
// ボードが起動直後の移行に食われる（旧レイアウトを seed するテストの前提）。
useMigrate(mod);
await settleMigration();
const { nextTodo, continuationPrompt, tickCardFor, pickFirstTodo, parseKanbanArgs } = mod;

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
// #17: session ボードは無い。poll が見るのは project ボード（cwd の slug）1 枚だけ。
// どの sid で seed しても同じ 1 枚を指すので、引数は互換のために残している。
const SLUG = mod.projectSlugOf(process.cwd());
const boardFile = () => `${HOME_DIR}/.pi/kanban/projects/${SLUG}.json`;
const writeBoardFile = (_sid, cards) => seedBoard(boardFile(), { cards, nextId: 90 });
const readCards = (_sid) => readBoardAt(boardFile()).cards;
const readModes = () => JSON.parse(readFileSync(MODES, "utf8"));

// 全セッション分を毎回書き戻す: poll は 1.5s ごとに modes.json を読み直す。
const modesState = { PROJECT: {}, GLOBAL: {} };
const writeModes = () => writeFileSync(MODES, JSON.stringify(modesState, null, 2));
// #17: project のスイッチは slug で引く（modesFor(f, slug, "project")）。GLOBAL は sid。
const setModes = (sid, doingLoop, autoPick) => {
	modesState.PROJECT[SLUG] = { doingLoop, autoPick };
	writeModes();
};

// ---------------------------------------------------------------------------
// 1: TODO の選定は pickFirstTodo と同一（wake 対象 = pickFirstTodo の結果）
// ---------------------------------------------------------------------------
const ORD = "phase10-ord";
writeBoardFile(ORD, [
	{ id: 5, text: "low", col: "todo" },
	{ id: 2, text: "high", col: "todo", priority: 9 },
	{ id: 7, text: "doing one", col: "doing" },
]);
const ordCards = readCards(ORD);
check("nextTodo は priority 降順 -> #2", () => assert.equal(nextTodo(ordCards).id, 2));
check("nextTodo の選定は pickFirstTodo と一致する（#2）", () => {
	const picked = pickFirstTodo(SLUG, "project");
	assert.equal(picked && picked.id, nextTodo(ordCards).id);
	assert.equal(picked.col, "doing", "pickFirstTodo は実際に DOING へ移す");
});
check("TODO が無ければ nextTodo は undefined", () => {
	assert.equal(nextTodo([{ id: 7, text: "doing one", col: "doing" }]), undefined);
	assert.equal(nextTodo([]), undefined);
});

// ---------------------------------------------------------------------------
// 2: continuationPrompt — DOING 用の文言は不変、TODO 用を追加
// ---------------------------------------------------------------------------
const doingCard = { id: 1, text: "x", col: "doing" };
const todoCard = { id: 3, text: "買い物", col: "todo" };
check("DOING 用プロンプト（session）は従来の文字列のまま", () =>
	assert.equal(
		continuationPrompt(doingCard, "session"),
		'DOING #1 "x" を完了させろ。終わったら kanban ツール で DONE に移せ。',
	));
check("DOING 用プロンプト（global）は従来の文字列のまま", () =>
	assert.equal(
		continuationPrompt(doingCard, "global"),
		'GLOBAL DOING #1 "x" を完了させろ。終わったら kanban ツール (scope=global) で DONE に移せ。',
	));
check("TODO 用プロンプトは DOING 用と異なる", () =>
	assert.notEqual(continuationPrompt(todoCard, "session"), continuationPrompt(doingCard, "session")));
check("TODO 用プロンプトは #N と本文を含み、DOING へ移せと言う", () => {
	const p = continuationPrompt(todoCard, "session");
	assert.match(p, /TODO #3 "買い物" を着手しろ。/);
	assert.match(p, /DOING に移してから作業しろ/);
	assert.doesNotMatch(p, /完了させろ/);
});
check("TODO 用プロンプト（global）は scope=global を名乗る", () => {
	const p = continuationPrompt(todoCard, "global");
	assert.match(p, /GLOBAL/);
	assert.match(p, /scope=global/);
	assert.match(p, /#3/);
});
check("TODO 用でも本文は 80 文字で切られる", () => {
	const long = { id: 9, text: "あ".repeat(200), col: "todo" };
	assert.equal(Array.from(continuationPrompt(long, "session")).length < 160, true);
	assert.match(continuationPrompt(long, "session"), /…/);
});

// ---------------------------------------------------------------------------
// 3: poll の wake 対象選定 = tickCardFor ?? nextTodo（DOING 優先。二重に拾わない）
// ---------------------------------------------------------------------------
// #17: tickCardFor(cards, sid, now)。所有権は常に movedBy === sid。
const pickWake = (cards, sid) => tickCardFor(cards, sid) ?? nextTodo(cards);
check("DOING あり + TODO あり -> DOING カードで wake（TODO は拾わない）", () => {
	const cards = [
		{ id: 4, text: "t", col: "todo" },
		{ id: 6, text: "d", col: "doing", movedBy: "me" },
	];
	const woken = pickWake(cards, "me");
	assert.equal(woken.id, 6);
	assert.equal(woken.col, "doing");
});
check("DOING 空 + TODO あり -> TODO カードで wake", () => {
	const woken = pickWake([{ id: 4, text: "t", col: "todo" }], "me");
	assert.equal(woken.id, 4);
	assert.equal(woken.col, "todo");
});
check("DOING 空 + TODO 空 -> wake 対象なし", () =>
	assert.equal(pickWake([{ id: 8, text: "done", col: "done" }], "me"), undefined));

// ---------------------------------------------------------------------------
// 4: parseKanbanArgs の既存全ケース（Phase 5-9 の非破壊）
// ---------------------------------------------------------------------------
const ARGS_TABLE = [
	[[], { kind: "menu" }],
	[["help"], { kind: "help" }],
	[["買い物"], { kind: "add", text: "買い物" }],
	[["add", "買い物", "と", "牛乳"], { kind: "add", text: "買い物 と 牛乳" }],
	[["add"], { kind: "reject", reason: "使い方: /kanban add <タスク内容>（空のカードは作りません）" }],
	[["loop", "on"], { kind: "mode", key: "doingLoop", value: true }],
	[["loop", "off", "global"], { kind: "mode", key: "doingLoop", value: false, scope: "global" }],
	[["loop", "status"], { kind: "modeStatus", key: "doingLoop" }],
	[["pick", "off"], { kind: "mode", key: "autoPick", value: false }],
	[["pick", "on", "global"], { kind: "mode", key: "autoPick", value: true, scope: "global" }],
	[["loop", "maybe"], { kind: "reject", reason: "使い方: /kanban loop on|off|status [project|global] / /kanban pick on|off" }],
	[["interval", "3"], { kind: "interval", scope: "project", minutes: 3 }],
	[["interval", "global", "7"], { kind: "interval", scope: "global", minutes: 7 }],
	[["interval"], { kind: "intervalStatus", scope: "project" }],
	[["interval", "global"], { kind: "intervalStatus", scope: "global" }],
	[["interval", "off"], { kind: "reject", reason: "使い方: /kanban interval [global] <分>（0より大きい数値）: off" }],
	[["stuck", "5"], { kind: "stuck", scope: "project", count: 5 }],
	[["stuck", "global", "2"], { kind: "stuck", scope: "global", count: 2 }],
	[["stuck"], { kind: "stuckStatus", scope: "project" }],
	[["stuck", "0"], { kind: "reject", reason: "使い方: /kanban stuck [global] <回>（1〜20の整数）: 0" }],
	[["priority"], { kind: "priority", id: undefined, value: undefined }],
	[["priority", "3"], { kind: "priority", id: 3, value: undefined }],
	[["priority", "3", "5"], { kind: "priority", id: 3, value: 5 }],
	[["priority", "0"], { kind: "reject", reason: "使い方: /kanban priority <id> [n]（id は 1 以上の整数）: 0" }],
	[["priority", "3", "100"], { kind: "reject", reason: "使い方: /kanban priority <id> [n]（-99〜99の整数）: 100" }],
];
for (const [argv, expected] of ARGS_TABLE) {
	check(`parseKanbanArgs(${JSON.stringify(argv)})`, () => eq(parseKanbanArgs(argv), expected));
}

// ---------------------------------------------------------------------------
// ライブ経路: 実タイマー poll -> sendUserMessage / agent_before_settle -> 実ファイル
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const commands = new Map();

function startSession(sid, sessionEntries = []) {
	const handlers = new Map();
	const sent = [];
	const entries = [];
	const pi = {
		registerCommand(name, spec) {
			commands.set(name, spec);
		},
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
	// #17: session ボードが無くなり、poll が回すのは project ボード 1 枚 + 単一の ownCtx。
	// 同じセッションで続けて wake を試すと lastTickAt の間隔で止まるので、局面の変わり目は
	// /kanban take（lastTickAt = 0 に戻す唯一の口）で区切る。
	// --- (A) TODO のみ + DOING 空 + autoPick ON -> TODO で wake する -------------
	const A = "phase10-a";
	const sessA = startSession(A);
	const take = () => commands.get("kanban").handler("take", sessA.ctx);
	setModes(A, true, true);
	writeBoardFile(A, [
		{ id: 1, text: "first task", col: "todo" },
		{ id: 2, text: "second task", col: "todo" },
	]);
	await sleep(2000);
	assert.equal(sessA.sent.length, 1, `TODO 静止で 1 回 wake するはず: ${JSON.stringify(sessA.sent)}`);
	assert.equal(
		sessA.sent[0],
		continuationPrompt({ id: 1, text: "first task", col: "todo" }, "session"),
		"wake 対象は pickFirstTodo と同じ #1",
	);
	assert.match(sessA.sent[0], /^TODO #1 "first task" を着手しろ。/);
	const afterWake = readCards(A);
	assert.equal(afterWake.find((c) => c.id === 1).col, "todo", "poll は盤面を書かない（移すのは agent）");
	passed += 1;

	// --- (B) TODO のみ + autoPick OFF -> wake しない -----------------------------
	// sent は累積するので、以降は「増えないこと」で見る。
	const sentA = sessA.sent.length;
	const entriesA = sessA.entries.length;
	setModes(A, true, false); // doingLoop ON / autoPick OFF
	writeBoardFile(A, [{ id: 1, text: "should stay", col: "todo" }]);
	take();
	await sleep(2000);
	assert.equal(sessA.sent.length, sentA, `autoPick OFF は wake しない: ${JSON.stringify(sessA.sent)}`);
	assert.equal(sessA.entries.length, entriesA, "autoPick OFF の poll は loop を進めない");
	passed += 1;

	// --- (C) DOING あり + TODO あり -> DOING で 1 回だけ wake（TODO は拾わない） ---
	setModes(A, true, true);
	writeBoardFile(A, [
		{ id: 1, text: "doing work", col: "doing", movedBy: A },
		{ id: 2, text: "todo work", col: "todo" },
	]);
	take();
	await sleep(2000);
	assert.equal(sessA.sent.length, sentA + 1, `DOING ありは 1 回 wake: ${JSON.stringify(sessA.sent)}`);
	assert.match(sessA.sent.at(-1), /^DOING #1 "doing work" を完了させろ/);
	assert.doesNotMatch(sessA.sent.at(-1), /TODO/);
	assert.equal(readCards(A).find((c) => c.id === 2).col, "todo", "TODO は二重に拾わない");
	passed += 1;

	// --- (D) doingLoop OFF -> autoPick ON でも wake しない ----------------------
	setModes(A, false, true);
	writeBoardFile(A, [{ id: 1, text: "should stay", col: "todo" }]);
	take();
	await sleep(2000);
	assert.equal(sessA.sent.length, sentA + 1, `doingLoop OFF は wake しない: ${JSON.stringify(sessA.sent)}`);
	assert.equal(readCards(A).find((c) => c.id === 1).col, "todo");
	passed += 1;

	// --- (E) settle: DOING あり + TODO あり + autoPick ON -> WIP=1 で TODO は移らない --
	// 旧 Phase 10 はここで TODO が 1 枚移ることを固定していた。通し番号 #32 で DOING 堆積の
	// 原因と判明したため WIP=1 に反転。DOING 空の陽性対照は tests/kanban-wip.test.mjs 側。
	setModes(A, true, true); // (D) で落とした doingLoop を戻す
	writeBoardFile(A, [
		{ id: 1, text: "first task", col: "todo" },
		{ id: 2, text: "second task", col: "todo" },
		// #17: 自分の DOING は movedBy が無いと「他者のカード」になり WIP=1 が効かない。
		{ id: 3, text: "already doing", col: "doing", movedBy: A },
	]);
	const before = readCards(A);
	const res = settle(sessA);
	assert.equal(res && res.continue, true, "DOING を drive する settle は 1 ターン続ける");
	const after = readCards(A);
	const moved = before.filter((c) => {
		const now = after.find((x) => x.id === c.id);
		return c.col === "todo" && now.col === "doing";
	});
	assert.equal(moved.length, 0, `WIP=1: DOING があるとき settle は TODO を拾わない: ${JSON.stringify(moved)}`);
	assert.equal(after.find((c) => c.id === 1).col, "todo");
	assert.equal(after.find((c) => c.id === 2).col, "todo");
	assert.equal(after.find((c) => c.id === 3).col, "doing", "既存 DOING は触らない");
	assert.equal(res.entries[0].content, continuationPrompt({ id: 3, text: "already doing", col: "doing" }, "session"));
	passed += 1;

	// --- (F) TODO 経由の settle も loop.count++ を通る（上限が効く） ------------
	const loopEntry = sessA.entries.filter((e) => e.customType === "kanban-loop").at(-1);
	assert.ok(loopEntry, "settle は loop 状態を appendEntry する");
	assert.equal(loopEntry.data.count, 1, "TODO 経由でも count は 0 -> 1");
	passed += 1;

	// --- (G) count が MAX_LOOPS に達した loop は TODO を拾っても halt する ------
	const G = "phase10-g";
	const sessG = startSession(G, [
		{
			type: "custom",
			customType: "kanban-loop",
			data: { count: 10, halted: null, scope: null, stuckId: null, stuckCount: 0, lastActivityAt: 0 },
		},
	]);
	setModes(G, true, true);
	writeBoardFile(G, [
		{ id: 1, text: "todo at cap", col: "todo" },
	]);
	const resG = settle(sessG);
	assert.equal(resG, undefined, "上限では continue しない");
	assert.equal(readCards(G).find((c) => c.id === 1).col, "doing", "TODO は拾われたうえで halt する");
	const fg = readModes();
	// #17: project のスイッチは slug、global は sid で引く。
	assert.equal(fg.PROJECT[SLUG].doingLoop, false, "halt は両 scope の doingLoop を落とす");
	assert.equal(fg.GLOBAL[G].doingLoop, false);
	passed += 1;
} catch (err) {
	failures.push(`live: ${err.message}`);
}

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
