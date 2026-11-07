// kanban Phase 11 の自己検証。フレームワーク無しで `node tests/kanban-phase11.test.mjs`。
// 対象: TODO の所有判定。DOING は headOwnedDoing で movedBy===sid に絞っている。
// #52: TODO も同じく、自分のもの（movedBy === sid）と無主（movedBy 無し）だけを拾う。
// 他セッションが触った TODO は既定で見えず、autoPick の対象でもない（手動 move は自由）。
// #26: 駆動するのは cwd の project ボード 1 枚。global は読み取り専用の集約ビューなので、
// global.json に何を置いても poll も settle も動かない（それをここで固定する）。
// HOME と KANBAN_PORT を差し替えるので、本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { readBoardAt, seedBoard, useKanban } from "./helpers/board.mjs";
import { settleMigration, useMigrate } from "./helpers/migrate.mjs";

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
useKanban(mod);
// 起動時 migration は fire-and-forget。seed より先に消化しないと、seed した session/global
// ボードが起動直後の移行に食われる（旧レイアウトを seed するテストの前提）。
useMigrate(mod);
await settleMigration();
const { nextTodo, tickCardFor } = mod;

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
// #17: session ボードは無い。project は cwd の slug 1 枚（引数 sid は互換のため残す）。
const SLUG = mod.projectSlugOf(process.cwd());
const boardFile = () => `${HOME_DIR}/.pi/kanban/projects/${SLUG}.json`;
const writeBoardFile = (_sid, cards) => seedBoard(boardFile(), { cards, nextId: 90 });
// global は駆動しないことを見るためだけに direct seed する（UI からは書けない）。
const writeGlobalFile = (cards) => seedBoard(GLOBAL, { cards, nextId: 90 });
const readCards = (_sid) => readBoardAt(boardFile()).cards;
const readGlobal = () => readBoardAt(GLOBAL).cards;
const readModes = () => JSON.parse(readFileSync(MODES, "utf8"));

// 全セッション分を毎回書き戻す: poll は 1.5s ごとに modes.json を読み直す。
// #26: スイッチを持つボードは project（slug キー）だけ。
const modesState = { PROJECT: {} };
const writeModes = () => writeFileSync(MODES, JSON.stringify(modesState, null, 2));
const setModes = (_sid, _scope, doingLoop, autoPick) => {
	modesState.PROJECT[SLUG] = { doingLoop, autoPick };
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
check("3 #87 整合 GLOBAL TODO: movedBy === 他者でも拾う (aggregate は sid 区分が無意味)", () =>
	eq(
		nextTodo([{ id: 1, text: "theirs", col: "todo", movedBy: OTHER, priority: 9 }], "global", S)?.id,
		1,
	));
check("4 #87 整合 GLOBAL: 他者スタンプ高priorityが priority 順で先頭に来る", () =>
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
check("4b #87 整合 GLOBAL: 他者所有の TODO しか無ければ拾う (aggregate)", () =>
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
check("5b #52: scope は関係ない — 他者スタンプは session でも拾わない", () =>
	eq(nextTodo([{ id: 1, text: "t", col: "todo", movedBy: OTHER }], "session", S), undefined));

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
	// --- (A) 6: #26 global は駆動しない — global.json に拾える TODO を積んでも wake しない --
	const A = "phase11-a";
	const sessA = startSession(A);
	setModes(A, "project", true, true);
	writeBoardFile(A, []); // project ボードは空
	writeGlobalFile([
		{ id: 1, text: "mine", col: "todo" },
		{ id: 2, text: "theirs", col: "todo", movedBy: OTHER, priority: 9 },
	]);
	await sleep(2000);
	assert.equal(
		sessA.sent.length,
		0,
		`global の TODO で wake した（#26: global は駆動しない）: ${JSON.stringify(sessA.sent)}`,
	);
	assert.equal(readGlobal().find((c) => c.id === 2).col, "todo", "poll は global を書かない");
	// 網の穴 #1: (A) は poll しか叩いておらず、settle 側に global 分岐が戻っても落ちなかった。
	const resA = settle(sessA);
	assert.equal(resA, undefined, `global の TODO で settle が続行した（#26: global は駆動しない）: ${JSON.stringify(resA)}`);
	assert.equal(readGlobal().find((c) => c.id === 2).col, "todo", "settle は global を書かない");
	passed += 1;

	// --- (B) 7: #52 project ボードの他者スタンプ TODO は settle が拾わない -----------
	const B = "phase11-b";
	const sessB = startSession(B);
	setModes(B, "project", true, true);
	writeBoardFile(B, [{ id: 5, text: "theirs", col: "todo", movedBy: OTHER, priority: 9 }]);
	const resB = settle(sessB);
	const keptB = readCards(B).find((c) => c.id === 5);
	assert.equal(keptB.col, "todo", `#52: 他セッションの TODO を自動で拾った: ${JSON.stringify(readCards(B))}`);
	assert.equal(keptB.movedBy, OTHER, "所有が移った");
	assert.equal(resB, undefined, `拾っていないのに settle が続行した: ${JSON.stringify(resB)}`);
	passed += 1;

	// --- (C) 陽性対照: 同じ経路で movedBy 無し TODO は settle が拾う ---------------
	writeBoardFile(B, [{ id: 6, text: "free", col: "todo" }]);
	settle(sessB);
	const movedC = readCards(B).find((c) => c.id === 6);
	assert.equal(movedC.col, "doing", `movedBy 無し TODO は settle が拾うはず: ${JSON.stringify(readCards(B))}`);
	assert.equal(movedC.movedBy, B, "pickFirstTodo が movedBy を自分の sid でスタンプする");
	passed += 1;

	// --- (D) 陽性対照: movedBy === 自分 の TODO も拾う ---------------------------
	writeBoardFile(B, [{ id: 7, text: "mine", col: "todo", movedBy: B }]);
	settle(sessB);
	assert.equal(readCards(B).find((c) => c.id === 7).col, "doing", "movedBy===sid は拾える");
	passed += 1;

	// --- (E) #52: 無主の TODO が混じっていれば、他者スタンプを飛ばしてそちらを拾う ------
	const E = "phase11-e";
	const sessE = startSession(E);
	setModes(E, "project", true, true);
	writeBoardFile(E, [
		{ id: 3, text: "theirs-in-project", col: "todo", movedBy: OTHER, priority: 9 },
		{ id: 4, text: "free-in-project", col: "todo" },
	]);
	const resE = settle(sessE);
	assert.equal(readCards(E).find((c) => c.id === 3).col, "todo", "他セッションの TODO が動いた");
	assert.equal(readCards(E).find((c) => c.id === 4).col, "doing", "無主の TODO が拾われていない");
	assert.ok(resE && resE.continue === true, "project TODO 経由の settle は続行する");
	passed += 1;

	// --- (F) 純関数の poll と同じ式の一致（#52: 他者スタンプは対象外） ----------------
	// #17: tickCardFor(cards, sid) — 所有権は movedBy === sid だけ。scope は nextTodo 側だけ。
	const pollPick = (cards, sid, scope) => tickCardFor(cards, sid) ?? nextTodo(cards, scope, sid);
	check("6 純関数: poll の wake 選定 = nextTodo（GLOBAL 他者スタンプあり）", () => {
		const cards = [
			{ id: 1, text: "mine", col: "todo" },
			{ id: 2, text: "theirs", col: "todo", movedBy: OTHER, priority: 9 },
		];
		eq(pollPick(cards, S, "global")?.id, nextTodo(cards, "global", S)?.id);
		eq(pollPick(cards, S, "global")?.id, 2); // #87 整合: GLOBAL は aggregate で sid 区分無意味 → priority 9 の他者スタンプが priority 順で先頭
	});

	// --- (G) 8: 旧 global エントリの予算を project に付け替えない ----------------------
	// #17 以前は global にも書けたので、scope:"global" のまま count が上限に達した
	// kanban-loop エントリが実在し得る。restoreLoop が scope だけを null にしていたため
	// paintLoop がそれを project として読み、最初の settle が即 HALTED:limit になって
	// project の doingLoop を OFF にしていた（原因不明の停止）。
	const G = "phase11-g";
	const sessG = startSession(G, [
		{
			type: "custom",
			customType: "kanban-loop",
			data: { scope: "global", count: 9, halted: "limit", stuckId: 41, stuckCount: 2, lastActivityAt: 0 },
		},
	]);
	const CAP_G = 3;
	modesState.PROJECT[SLUG] = { doingLoop: true, autoPick: true, maxLoops: CAP_G };
	writeModes();
	writeBoardFile(G, [{ id: 41, text: "g", col: "doing", movedBy: G }]);
	const resG = settle(sessG);
	// 最後に永続化された kanban-loop エントリ = paintLoop が公開した値（件数と halt）。
	const loopG = sessG.entries.filter((e) => e.customType === "kanban-loop").at(-1)?.data;
	assert.equal(
		resG && resG.continue,
		true,
		`旧 global の count(9) を project の予算として読んだ（上限 ${CAP_G} で即停止）: ${JSON.stringify(loopG)}`,
	);
	assert.equal(loopG?.halted ?? null, null, `旧 global エントリの halt が復元された: ${JSON.stringify(loopG)}`);
	assert.equal(loopG?.count, 1, `残量が 0 から始まっていない（旧 global の count を引き継いだ）: ${JSON.stringify(loopG)}`);
	assert.equal(
		readModes().PROJECT[SLUG].doingLoop,
		true,
		`project の doingLoop が OFF に書き換えられた: ${JSON.stringify(readModes())}`,
	);
	passed += 1;
} catch (err) {
	failures.push(`live: ${err.message}`);
}

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
