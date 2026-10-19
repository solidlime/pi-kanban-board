// kanban Phase 7 の自己検証。フレームワーク無しで `node tests/kanban-phase7.test.mjs`。
// 対象: orderTodos（autoPick の選定順）/ isValidPriority・priorityOf の境界 /
// parseKanbanArgs の priority 分岐と既存ケースの非破壊 / pickFirstTodo の実挙動 /
// GET /api/priority。
// HOME と KANBAN_PORT を差し替えるので、本番の ~/.pi/kanban と 8789 には触れない。
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { authFetch } from "./helpers/token.mjs";

// #83b: HTTP routes need the server token now; tf = fetch + the kb_token cookie.
const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-phase7-home";
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
const { orderTodos, isValidPriority, priorityOf, parseKanbanArgs, pickFirstTodo } = mod;

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
const card = (id, priority, col) => (priority === undefined ? { id, text: `t${id}`, col } : { id, text: `t${id}`, col, priority });
const ids = (cards) => cards.map((c) => c.id);

// --- 1: orderTodos（priority 降順 → 同値は id 昇順） ----------------------------
check("orderTodos([]) -> []", () => eq(orderTodos([]), []));
check("priority 無しは id 昇順", () =>
	eq(ids(orderTodos([card(5, undefined, "todo"), card(1, undefined, "todo"), card(3, undefined, "todo")])), [1, 3, 5]));
check("[{id:3,p:5},{id:1}] -> 3 が先", () =>
	eq(ids(orderTodos([card(1, undefined, "todo"), card(3, 5, "todo")])), [3, 1]));
check("同 priority は id 昇順", () =>
	eq(ids(orderTodos([card(4, 7, "todo"), card(2, 7, "todo"), card(9, 7, "todo")])), [2, 4, 9]));
check("負の priority でも降順（0 > -1 > -10）", () =>
	eq(ids(orderTodos([card(1, -10, "todo"), card(2, -1, "todo"), card(3, 0, "todo")])), [3, 2, 1]));
check("priority 未設定が混在しても壊れない（未設定=0）", () =>
	eq(ids(orderTodos([card(1, undefined, "todo"), card(2, -5, "todo"), card(3, 3, "todo"), card(4, 0, "todo")])), [
		3, 1, 4, 2,
	]));
check("orderTodos は入力を破壊しない", () => {
	const input = [card(1, undefined, "todo"), card(3, 9, "todo")];
	orderTodos(input);
	assert.deepEqual(ids(input), [1, 3]);
});

// --- 1b: priority の妥当性（stuckLimit と同じ表形式） ---------------------------
const TABLE = [
	[0, 0, true],
	[99, 99, true],
	[-99, -99, true],
	[100, 0, false],
	[-100, 0, false],
	[2.5, 0, false],
	[NaN, 0, false],
	[Infinity, 0, false],
	["5", 0, false],
	[null, 0, false],
	[undefined, 0, false],
];
for (const [input, expected, valid] of TABLE) {
	const label = typeof input === "string" ? JSON.stringify(input) : String(input);
	check(`priorityOf({priority:${label}}) -> ${expected}`, () =>
		assert.equal(priorityOf({ priority: input }), expected));
	check(`isValidPriority(${label}) -> ${valid}`, () => assert.equal(isValidPriority(input), valid));
}
check("priorityOf({}) -> 0（キー無し）", () => assert.equal(priorityOf({}), 0));

// --- 2: parseKanbanArgs の priority 分岐 ---------------------------------------
check("［priority 3 5］ -> {priority, id:3, value:5}", () =>
	eq(parseKanbanArgs(["priority", "3", "5"]), { kind: "priority", id: 3, value: 5 }));
check("［priority 3］ -> value:undefined", () =>
	eq(parseKanbanArgs(["priority", "3"]), { kind: "priority", id: 3, value: undefined }));
check("［priority］ -> 一覧（id/value とも undefined）", () =>
	eq(parseKanbanArgs(["priority"]), { kind: "priority", id: undefined, value: undefined }));
check("負の値は通る", () => eq(parseKanbanArgs(["priority", "2", "-7"]), { kind: "priority", id: 2, value: -7 }));
for (const bad of [
	["priority", "3", "100"],
	["priority", "3", "-100"],
	["priority", "3", "2.5"],
	["priority", "3", "abc"],
]) {
	check(`［${bad.join(" ")}］ -> reject`, () => {
		const r = parseKanbanArgs(bad);
		assert.equal(r.kind, "reject");
		assert.match(r.reason, /-99〜99/);
	});
}
check("［priority abc 1］ -> reject（id 不正）", () => {
	const r = parseKanbanArgs(["priority", "abc", "1"]);
	assert.equal(r.kind, "reject");
	assert.match(r.reason, /使い方/);
});

// --- 6: 既存の非 priority ケースが壊れていないこと -----------------------------
check("［買い物］ -> add", () => eq(parseKanbanArgs(["買い物"]), { kind: "add", text: "買い物" }));
check("［interval 3］ -> interval", () =>
	eq(parseKanbanArgs(["interval", "3"]), { kind: "interval", scope: "session", minutes: 3 }));
check("［stuck 5］ -> stuck", () =>
	eq(parseKanbanArgs(["stuck", "5"]), { kind: "stuck", scope: "session", count: 5 }));
check("［loop on］ -> mode", () =>
	eq(parseKanbanArgs(["loop", "on"]), { kind: "mode", key: "doingLoop", value: true }));
check("［］ -> menu", () => eq(parseKanbanArgs([]), { kind: "menu" }));

// --- 3: priority が autoPick の選定を実際に変える ------------------------------
const SID = "phase7-sid";
// global 層は /api/priority の scope=global ケース用に1枚だけ用意する。
writeFileSync(
	`${HOME_DIR}/.pi/kanban/global.json`,
	JSON.stringify({ cards: [{ id: 3, text: "global", col: "todo" }], nextId: 4 }),
);
const boardFile = `${HOME_DIR}/.pi/kanban/sessions/${SID}.json`;
const readBoardFile = () => JSON.parse(readFileSync(boardFile, "utf8"));
writeFileSync(
	boardFile,
	JSON.stringify({
		cards: [
			{ id: 3, text: "優先度なし", col: "todo" },
			{ id: 4, text: "優先度10", col: "todo", priority: 10 },
		],
		nextId: 5,
	}),
);
{
	const picked = pickFirstTodo(SID, "session");
	check("#3(p=0) と #4(p=10) があると pickFirstTodo は #4 を選ぶ", () => assert.equal(picked && picked.id, 4));
	check("選ばれた #4 は DOING、#3 は TODO のまま", () => {
		const after = readBoardFile();
		assert.equal(after.cards.find((c) => c.id === 4).col, "doing");
		assert.equal(after.cards.find((c) => c.id === 3).col, "todo");
	});
}

// --- 5: GET /api/priority（実サーバを空きポートで立てる） ----------------------
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

// --- 3b: /kanban priority の実ハンドラ（session ボードを読み書きする） ----------
const kbCmd = async (args) => {
	const notes = [];
	await commands.get("kanban").handler(args, {
		hasUI: false,
		isIdle: () => false,
		ui: { notify(m) { notes.push(m); }, setWidget() {} },
		sessionManager: { getSessionId: () => SID, getEntries: () => [] },
	});
	return notes.join("\n");
};
{
	const out = await kbCmd("priority 3 5");
	check("/kanban priority 3 5 -> #3 が 5 になる", () => {
		assert.match(out, /#3 優先度を 5 に設定/);
		assert.equal(readBoardFile().cards.find((c) => c.id === 3).priority, 5);
	});
	const show = await kbCmd("priority 3");
	check("/kanban priority 3 -> 現在値 5 を表示", () => assert.match(show, /#3 優先度: 5/));
	const listed = await kbCmd("priority");
	check("/kanban priority -> #3 (p=5) 形式の一覧", () => assert.match(listed, /#3 \(p=5\) 優先度なし/));
	const missing = await kbCmd("priority 99 5");
	check("/kanban priority 99 5 -> id が無いので拒否", () => assert.match(missing, /その id は無い: #99/));
	check("/kanban priority -> 一覧に DOING の #4 は出ない", () => assert.doesNotMatch(listed, /#4 /));
}

const api = (q) => tf(`http://127.0.0.1:${PORT}/api/priority?${q}`);
{
	const res = await api(`sid=${SID}&scope=session&id=3&n=7`);
	const body = await res.json();
	check("GET /api/priority?id=3&n=7 -> 200 かつボードに 7", () => {
		assert.equal(res.status, 200);
		assert.equal(body.ok, true);
		assert.equal(readBoardFile().cards.find((c) => c.id === 3).priority, 7);
	});
}
for (const bad of ["100", "-100", "2.5", "abc"]) {
	const res = await api(`sid=${SID}&scope=session&id=3&n=${bad}`);
	const body = await res.json();
	check(`GET /api/priority?n=${bad} -> 400 かつ現状維持（7）`, () => {
		assert.equal(res.status, 400);
		assert.equal(body.ok, false);
		assert.match(body.error, /-99\.\.99/);
		assert.equal(readBoardFile().cards.find((c) => c.id === 3).priority, 7);
	});
}
{
	const res = await api(`sid=${SID}&scope=session&id=99&n=5`);
	await res.text();
	check("GET /api/priority?id=99（無い id）-> 404", () => assert.equal(res.status, 404));
}
{
	const res = await tf(`http://127.0.0.1:${PORT}/api/priority?scope=global&id=3&n=-4`);
	const body = await res.json();
	check("GET /api/priority?scope=global -> 200（global ボード側に書く）", () => {
		assert.equal(res.status, 200);
		const g = JSON.parse(readFileSync(`${HOME_DIR}/.pi/kanban/global.json`, "utf8"));
		assert.equal(g.cards.find((c) => c.id === 3).priority, -4);
	});
}
{
	// #55: セッション単位の書き込みロックは無い。他セッションのボードもその sid で書ける。
	const otherBoardFile = `${HOME_DIR}/.pi/kanban/sessions/other-session.json`;
	writeFileSync(
		otherBoardFile,
		JSON.stringify({ cards: [{ id: 3, text: "other", col: "todo" }], nextId: 4 }),
	);
	const otherRes = await api(`sid=other-session&scope=session&id=3&n=3`);
	const otherBody = await otherRes.json();
	check("GET /api/priority 他セッション -> 200 かつそのボードに書かれる", () => {
		assert.equal(otherRes.status, 200);
		assert.equal(otherBody.ok, true);
		const written = JSON.parse(readFileSync(otherBoardFile, "utf8"));
		assert.equal(written.cards.find((c) => c.id === 3).priority, 3);
		// driver 側のボードは変わらない
		assert.equal(readBoardFile().cards.find((c) => c.id === 3).priority, 7);
	});
}

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
// poll timer は session_start を踏んでいないので未生成。HTTP サーバだけが残るので明示終了。
process.exit(failures.length === 0 ? 0 : 1);
