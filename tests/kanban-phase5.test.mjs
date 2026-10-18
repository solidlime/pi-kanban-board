// kanban Phase 5 の自己検証。フレームワーク無しで `node tests/kanban-phase5.test.mjs`。
// 対象: parseKanbanArgs（純関数）/ intervalMinOf / shouldAutoTick(menuOpen, intervalMs) /
// withMenuGuard の finally / A1: session_tree 後 poll が新しい ctx を見ること /
// KANBAN_HTML の <script> が構文として妥当なこと。
// HOME と KANBAN_PORT を差し替えるので、本番の ~/.pi/kanban と 8789 には触れない。
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";

const HOME_DIR = "/tmp/kb-phase5-home";
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
const { parseKanbanArgs, shouldAutoTick, intervalMinOf, intervalMsOf, withMenuGuard, AUTO_TICK_MS } = mod;

const MIN = 60_000;
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
const { readFileSync } = await import("node:fs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- B1/B2: 引数解釈（要求の実測例をそのまま） ---------------------------------
check("［買い物］ -> add", () => eq(parseKanbanArgs(["買い物"]), { kind: "add", text: "買い物" }));
check("［add 買い物］ -> 同一結果", () =>
	eq(parseKanbanArgs(["add", "買い物"]), parseKanbanArgs(["買い物"])));
check("［add］ -> 拒否（空カード禁止）", () => assert.equal(parseKanbanArgs(["add"]).kind, "reject"));
check("［loop on］ -> mode", () => eq(parseKanbanArgs(["loop", "on"]), { kind: "mode", key: "doingLoop", value: true }));
check("［pick off］ -> mode", () => eq(parseKanbanArgs(["pick", "off"]), { kind: "mode", key: "autoPick", value: false }));
check("［loop status］ -> modeStatus", () => eq(parseKanbanArgs(["loop", "status"]), { kind: "modeStatus", key: "doingLoop" }));
check("［loop bogus］ -> 拒否（旧と同文言）", () => {
	const r = parseKanbanArgs(["loop", "bogus"]);
	assert.equal(r.kind, "reject");
	assert.match(r.reason, /loop on\|off\|status/);
});
check("［loop on global］ -> scope global", () =>
	eq(parseKanbanArgs(["loop", "on", "global"]), { kind: "mode", key: "doingLoop", value: true, scope: "global" }));
check("［interval 3］", () => eq(parseKanbanArgs(["interval", "3"]), { kind: "interval", scope: "session", minutes: 3 }));
check("［interval global 15］", () =>
	eq(parseKanbanArgs(["interval", "global", "15"]), { kind: "interval", scope: "global", minutes: 15 }));
check("［interval］ -> 現在値表示", () => eq(parseKanbanArgs(["interval"]), { kind: "intervalStatus", scope: "session" }));
check("［interval global］ -> 現在値表示", () => eq(parseKanbanArgs(["interval", "global"]), { kind: "intervalStatus", scope: "global" }));
for (const bad of ["0", "abc", "-1", "", "NaN", "Infinity"]) {
	check(`［interval ${JSON.stringify(bad)}］ -> 拒否`, () =>
		assert.equal(parseKanbanArgs(["interval", bad]).kind, "reject"));
}
check("［］ -> menu", () => eq(parseKanbanArgs([]), { kind: "menu" }));
check("［help］ -> help", () => eq(parseKanbanArgs(["help"]), { kind: "help" }));
check("予約語でない語はカード、複数語は結合", () =>
	eq(parseKanbanArgs(["買い物", "に", "行く"]), { kind: "add", text: "買い物 に 行く" }));
check("loop 以外の loopx はカード", () => eq(parseKanbanArgs(["loopx"]), { kind: "add", text: "loopx" }));

// --- B2/後方互換: intervalMin --------------------------------------------------
check("intervalMin 無し -> 5分扱い", () => {
	assert.equal(intervalMinOf({ doingLoop: true, autoPick: false }), 5);
	assert.equal(intervalMsOf({ doingLoop: true, autoPick: false }), AUTO_TICK_MS);
});
check("intervalMin 有り -> その値", () => {
	assert.equal(intervalMinOf({ doingLoop: true, autoPick: false, intervalMin: 12 }), 12);
	assert.equal(intervalMsOf({ doingLoop: true, autoPick: false, intervalMin: 12 }), 12 * MIN);
});
check("不正な intervalMin は既定へフォールバック", () => {
	for (const v of [0, -3, Number.NaN]) {
		assert.equal(intervalMinOf({ doingLoop: true, autoPick: false, intervalMin: v }), 5);
	}
});

// --- A3: menuOpen ゲート / intervalMs ゲート -----------------------------------
// Phase 8: lastActivityAt も発火条件。0 = 活動の記録なし（5 分以上静止と同じ扱）。
const base = {
	isIdle: true,
	doingLoop: true,
	card: { id: 1, col: "doing" },
	halted: null,
	lastTickAt: 0,
	lastActivityAt: 0,
	now: 5 * MIN,
};
check("menuOpen:true -> 発火しない", () => assert.equal(shouldAutoTick({ ...base, menuOpen: true }), false));
check("menuOpen:false -> 発火する", () => assert.equal(shouldAutoTick({ ...base, menuOpen: false }), true));
check("intervalMs 1分 -> 1分で発火", () =>
	assert.equal(shouldAutoTick({ ...base, intervalMs: 1 * MIN, now: 1 * MIN }), true));
check("intervalMs 15分 -> 5分では発火しない", () =>
	assert.equal(shouldAutoTick({ ...base, intervalMs: 15 * MIN, now: 5 * MIN }), false));

// --- A3: withMenuGuard は例外でも降りる ---------------------------------------
const guard = { menuOpen: false };
let seenOpen = null;
await assert.rejects(
	withMenuGuard(guard, async () => {
		seenOpen = guard.menuOpen;
		throw new Error("dialog interrupted");
	}),
	/dialog interrupted/,
);
check("ダイアログ中は menuOpen:true", () => assert.equal(seenOpen, true));
check("例外後 finally で menuOpen:false", () => assert.equal(guard.menuOpen, false));
{
	const g2 = { menuOpen: false };
	await withMenuGuard(g2, async () => {});
	check("正常終了でも menuOpen:false", () => assert.equal(g2.menuOpen, false));
}

// --- サーバ起動（以降の HTTP とタイマー経路で共有する） --------------------------
const handlers = new Map();
const commands = new Map();
const sent = [];
const pi = {
	registerCommand(name, def) {
		commands.set(name, def);
	},
	registerTool() {},
	appendEntry() {},
	on(ev, fn) {
		handlers.set(ev, fn);
	},
	sendUserMessage(content) {
		sent.push(content);
	},
};
mod.default(pi); // ensureServer() はここで走る
for (let i = 0; i < 40; i++) {
	try {
		if ((await fetch(`http://127.0.0.1:${PORT}/api/kanban`)).ok) break;
	} catch {
		// まだ listen していない
	}
	await new Promise((r) => setTimeout(r, 100));
}

// --- B4: KANBAN_HTML の <script> が構文として妥当 --------------------------------
// #67: the /api/kanban.html route is deleted (pi-web split). The template is still
// exported and still written to ~/.pi/kanban/kanban.html, so the checks stay — they
// just read the export instead of the removed route.
{
	// #67: read the file writeBoardHtml() mirrors — no route, and it pins what actually
	// lands on disk. It appears at activate/session_start, so wait for it.
	let html = "";
	for (let i = 0; i < 60; i++) {
		try {
			html = readFileSync(`${HOME_DIR}/.pi/kanban/kanban.html`, "utf8");
			if (html.length > 0) break;
		} catch {
			// まだ書かれていない
		}
		await sleep(100);
	}
	const m = html.match(/<script>([\s\S]*?)<\/script>/);
	check("kanban.html に <script> がある", () => assert.ok(m, "no <script> block"));
	check("kanban.html の script が構文 OK", () => {
		// new Function は実行せず構文検査だけ（document は呼ばれた時に初めて要る）。
		new Function(m[1]);
	});
	check("kanban.html に interval の書き込み経路がある", () => {
		assert.match(html, /interval\?min=/);
	});
	check("kanban.html は ~/.pi/kanban に書かれている（定数は残っている）", () => {
		assert.ok(html.length > 1000, "kanban.html が空");
		assert.equal(typeof mod.KANBAN_HTML, "string");
		assert.ok(mod.KANBAN_HTML.length > 1000);
	});
}

// #67: the removed route must stay removed. Await first, then check(), because
// check() is synchronous and would count a rejected promise as a pass.
{
	const res = await fetch(`http://127.0.0.1:${PORT}/api/kanban.html`);
	check("/api/kanban.html は 404", () => assert.equal(res.status, 404));
}

// --- B1/B2: ハンドラ実測（add は session TODO に入り、無言でないこと） ------------
const SID = "tree-test-sid";
// #40: the panel's default sid is now pinned by the first session_start instead
// of by a sidOf side effect. Drive the real event so the write gate has a sid.
handlers.get("session_start")({}, mkCtx());
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const boardFile = `${HOME_DIR}/.pi/kanban/sessions/${SID}.json`;
const modesFile = `${HOME_DIR}/.pi/kanban/modes.json`;
const { join } = await import("node:path");
void join;

function mkCtx() {
	const notes = [];
	return {
		notes,
		hasUI: false,
		isIdle: () => false,
		ui: {
			notify(m) {
				notes.push(m);
			},
			setWidget() {},
			async select() {
				throw new Error("no dialog in test");
			},
			async input() {
				throw new Error("no dialog in test");
			},
		},
		sessionManager: { getSessionId: () => SID, getEntries: () => [] },
	};
}
const kanbanCmd = () => commands.get("kanban").handler;
{
	const ctx = mkCtx();
	await kanbanCmd()("買い物に行く", ctx);
	const b = readJson(boardFile);
	check("［買い物に行く］で TODO カードが 1 枚入る", () => {
		assert.equal(b.cards.length, 1);
		assert.equal(b.cards[0].text, "買い物に行く");
		assert.equal(b.cards[0].col, "todo");
	});
	check("add は notify で 1 行返す（無言でない）", () => {
		assert.equal(ctx.notes.length, 1);
		assert.match(ctx.notes[0], /TODO に追加/);
	});

	const ctx2 = mkCtx();
	await kanbanCmd()("add 牛乳を買う", ctx2);
	check("［add 牛乳を買う］も同じ結果（add を剥がす）", () => {
		const b2 = readJson(boardFile);
		assert.equal(b2.cards.length, 2);
		assert.equal(b2.cards[1].text, "牛乳を買う");
	});

	const ctx3 = mkCtx();
	await kanbanCmd()("add", ctx3);
	check("［add］単体は拒否してカードを増やさない", () => {
		assert.equal(readJson(boardFile).cards.length, 2);
		assert.match(ctx3.notes[0], /空のカードは作りません/);
	});

	const ctx4 = mkCtx();
	await kanbanCmd()("interval 7", ctx4);
	check("［interval 7］が modes.json に書かれる", () => {
		assert.equal(readJson(modesFile).SESSION[SID].intervalMin, 7);
		assert.match(ctx4.notes[0], /7分/);
	});

	const ctx5 = mkCtx();
	await kanbanCmd()("interval 0", ctx5);
	check("［interval 0］は拒否して現状維持（7分のまま）", () => {
		assert.equal(readJson(modesFile).SESSION[SID].intervalMin, 7);
		assert.match(ctx5.notes[0], /0より大きい数値/);
	});

	const ctx6 = mkCtx();
	await kanbanCmd()("help", ctx6);
	check("［help］は使い方を返す", () => assert.match(ctx6.notes[0], /interval/));

	// B4 の書き込み経路（HTML の input が叩くのと同じ GET+query 規約）。
	const api = (q) => fetch(`http://127.0.0.1:${PORT}/api/interval?${q}`);
	const okRes = await api(`scope=session&sid=${SID}&min=9`);
	check("GET /api/interval?min=9 -> 200 かつ modes.json に 9", () => {
		assert.equal(okRes.status, 200);
		assert.equal(readJson(modesFile).SESSION[SID].intervalMin, 9);
	});
	const badRes = await api(`scope=session&sid=${SID}&min=0`);
	check("GET /api/interval?min=0 -> 400 で現状維持", () => {
		assert.equal(badRes.status, 400);
		assert.equal(readJson(modesFile).SESSION[SID].intervalMin, 9);
	});
	const otherRes = await api(`scope=session&sid=other-session&min=3`);
	const otherBody = await otherRes.json();
	check("GET /api/interval 他セッション -> 200 かつ他セッションの interval が書かれる", () => {
		// #55: セッション単位の書き込みロックは無い。
		assert.equal(otherRes.status, 200);
		assert.equal(otherBody.ok, true);
		assert.equal(readJson(modesFile).SESSION["other-session"].intervalMin, 3);
		assert.equal(readJson(modesFile).SESSION[SID].intervalMin, 9);
	});
}

// --- A2: lastTickAt はセッションごと（module 共有なら片方しか起きない） --------------
async function perSessionIntervals() {
	const mk = (sid) => {
		const handlers = new Map();
		const sent = [];
		mod.default({
			registerCommand() {},
			registerTool() {},
			appendEntry() {},
			on(ev, fn) {
				handlers.set(ev, fn);
			},
			sendUserMessage(c) {
				sent.push(c);
			},
		});
		const ctx = {
			hasUI: false,
			isIdle: () => true,
			ui: { notify() {}, setWidget() {} },
			sessionManager: { getSessionId: () => sid, getEntries: () => [] },
		};
		handlers.get("session_start")({}, ctx);
		return sent;
	};
	const sentA = mk("sess-AAA");
	const sentB = mk("sess-BBB");
	for (const sid of ["sess-AAA", "sess-BBB"]) {
		writeFileSync(
			`${HOME_DIR}/.pi/kanban/sessions/${sid}.json`,
			JSON.stringify({ cards: [{ id: 1, text: "t", col: "doing" }], nextId: 2 }),
		);
	}
	writeFileSync(
		modesFile,
		JSON.stringify({
			SESSION: { "sess-AAA": { doingLoop: true, autoPick: false }, "sess-BBB": { doingLoop: true, autoPick: false } },
			GLOBAL: {},
		}),
	);
	await sleep(3000);
	assert.equal(sentA.length, 1, `sess-AAA must tick once (got ${sentA.length})`);
	assert.equal(sentB.length, 1, `sess-BBB must tick once, not wait for A (got ${sentB.length})`);
}
try {
	await perSessionIntervals();
	passed += 1;
} catch (err) {
	failures.push(`A2 per-session lastTickAt: ${err.message}`);
}

// --- A1: session_tree 後に poll が新しい ctx を見る ----------------------------
async function pollFollowsTreeCtx() {
	const mk = (idle) => ({
		hasUI: false,
		isIdle: () => idle,
		ui: { notify() {}, setWidget() {} },
		sessionManager: { getSessionId: () => SID, getEntries: () => [] },
	});
	// 古い ctx は isIdle:false（ターン中）。新 ctx は idle。session_tree で差し替える。
	const ctxOld = mk(false);
	const ctxNew = mk(true);
	handlers.get("session_start")({}, ctxOld);
	writeFileSync(
		`${HOME_DIR}/.pi/kanban/modes.json`,
		JSON.stringify({ SESSION: { [SID]: { doingLoop: true, autoPick: false } }, GLOBAL: {} }),
	);
	writeFileSync(
		`${HOME_DIR}/.pi/kanban/sessions/${SID}.json`,
		JSON.stringify({ cards: [{ id: 1, text: "tree tick", col: "doing" }], nextId: 2 }),
	);
	handlers.get("session_tree")({}, ctxNew);
	await sleep(1800);
	assert.equal(sent.length, 1, `poll must use the newest ctx (got ${sent.length})`);
}
try {
	await pollFollowsTreeCtx();
	passed += 1;
} catch (err) {
	failures.push(`A1 session_tree -> pollCtx: ${err.message}`);
}

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
