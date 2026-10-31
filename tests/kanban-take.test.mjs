// #40 `/kanban take` の回帰テスト。フレームワーク無しで `node tests/kanban-take.test.mjs`。
// 対象: auto-tick の駆動元（ownCtx）を、後から開いたセッションへ明示的に切り替えられること。
// HOME と KANBAN_PORT を差し替えるので、本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { authFetch } from "./helpers/token.mjs";

// #83b: HTTP routes need the server token now; tf = fetch + the kb_auth cookie.
const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-take-home";
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
const BASE = `http://127.0.0.1:${PORT}`;

// dist/jiti.cjs は壊れているので lib/jiti.cjs を使う（既存テストと同じ経路）。
const require = createRequire(import.meta.url);
const { createJiti } = require(
	process.env.KANBAN_JITI ?? createRequire(import.meta.url).resolve("jiti"),
);
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url)));

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
const board = (sid) => `${HOME_DIR}/.pi/kanban/sessions/${sid}.json`;
const writeBoardFile = (sid, cards = [{ id: 1, text: "t", col: "doing" }]) =>
	writeFileSync(board(sid), JSON.stringify({ cards, nextId: cards.length + 1 }));
// doingLoop を ON にした modes.json を、指定 sid ぶんまとめて書く。
const writeModes = (...sids) =>
	writeFileSync(
		MODES,
		JSON.stringify({
			SESSION: Object.fromEntries(sids.map((s) => [s, { doingLoop: true, autoPick: false }])),
			GLOBAL: {},
		}),
	);

// registerCommand がハンドラを保持する pi スタブ（既存テストは捨てているが、ここでは呼ぶ）。
function mkPi() {
	const handlers = new Map();
	const commands = new Map();
	const sent = [];
	const pi = {
		registerCommand(name, spec) {
			commands.set(name, spec);
		},
		registerTool() {},
		appendEntry() {},
		on(ev, fn) {
			handlers.set(ev, fn);
		},
		sendUserMessage(c) {
			sent.push(c);
		},
	};
	return { pi, handlers, commands, sent };
}

// `entries` を渡すと restoreLoop がその kanban-loop entry を読む（halted の再現用）。
function mkCtx(sid, entries = []) {
	const notes = [];
	return {
		notes,
		hasUI: false,
		isIdle: () => true,
		ui: {
			notify(m) {
				notes.push(m);
			},
			setWidget() {},
		},
		sessionManager: {
			getSessionId: () => sid,
			getSessionName: () => undefined,
			getEntries: () => entries,
		},
	};
}

const haltingEntry = (at) => ({
	type: "custom",
	customType: "kanban-loop",
	data: { count: 10, halted: "limit", scope: null, stuckId: null, stuckCount: 0, lastActivityAt: at },
});

const driver = async () => (await (await tf(`${BASE}/api/dashboard`)).json()).driver;

// KANBAN_DEBUG の poll verdict 行を集める（なぜ発火/停止したかの観測用）。
const traces = [];
const origWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk) => {
	const s = typeof chunk === "string" ? chunk : chunk.toString();
	if (s.startsWith("kanban: poll ")) traces.push(s);
	return true;
};
// その sid の verdict（"fire" / "skip:halted:limit" / ...）。無ければ null。
// poll は session -> global の順に 2 行吐くので、先頭（= session 層）の行を採る。
const verdictOf = (sid) => {
	for (const line of traces) {
		if (!line.includes(`sid=${sid} `)) continue;
		const m = /=> (\S+)/.exec(line);
		if (m !== null) return m[1];
	}
	return null;
};

// --- 1. parseKanbanArgs が take を返す ----------------------------------------
check("parseKanbanArgs(['take']) は kind:take", () => eq(mod.parseKanbanArgs(["take"]), { kind: "take" }));
check("take は scope 語を無視する（session）", () =>
	eq(mod.parseKanbanArgs(["take", "session"]), { kind: "take" }));
check("take は scope 語を無視する（global）", () =>
	eq(mod.parseKanbanArgs(["take", "global"]), { kind: "take" }));
check("既存の予約語 help は変わらない", () => eq(mod.parseKanbanArgs(["help"]), { kind: "help" }));
check("未知語はカードのまま", () => eq(mod.parseKanbanArgs(["買い物"]), { kind: "add", text: "買い物" }));

// --- 2. take で ownCtx が後発セッションへ移り、dashboard の driver も追従する --
{
	const { pi, handlers, commands } = mkPi();
	const t = mod.default(pi).__test;
	const kanban = commands.get("kanban");
	check("registerCommand('kanban') がハンドラ付きで登録される", () =>
		assert.equal(typeof kanban.handler, "function"));

	const SID_A = "sid-take-a";
	const SID_B = "sid-take-b";
	writeBoardFile(SID_A);
	writeBoardFile(SID_B);
	writeModes(SID_A, SID_B);

	const ctxA = mkCtx(SID_A);
	const ctxB = mkCtx(SID_B);
	handlers.get("session_start")({ type: "session_start" }, ctxA);
	handlers.get("session_start")({ type: "session_start" }, ctxB);
	check("session_start だけでは先着が駆動元（既存挙動）", () => eq(t.ownCtx(), ctxA));

	await kanban.handler("take", ctxB);
	check("take で ownCtx が後発セッションへ移る", () => eq(t.ownCtx(), ctxB));
	check("take の notify 文言", () =>
		eq(ctxB.notes.at(-1), `kanban: 駆動元を ${SID_A} → ${SID_B} に切り替えた`));

	// dashboard は読み取り専用の `driver` を返す（書き込み経路は無い）。
	const drv = await driver();
	check("dashboard.driver が切り替え後は SID_B", () => assert.equal(drv, SID_B));

	// /kanban help の本文は take を 1 行で説明している。
	await kanban.handler("help", ctxB);
	check("/kanban help に take の行がある", () =>
		assert.match(ctxB.notes.at(-1), /\/kanban take {2}auto-tick の駆動元をこのセッションに切り替える/));

	handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" });
	check("session_shutdown は take 後も ownCtx を解放する", () => assert.equal(t.ownCtx(), null));
}

// --- 3. take が halted を引き継がない ----------------------------------------
// B のセッション entry に halted:"limit" を仕込み、session_start がそれを復元した状態で
// まず「止まっている」ことを確認し、take の後に同じ条件で発火することを見る。
{
	const { pi, handlers, commands, sent } = mkPi();
	const t = mod.default(pi).__test;
	const kanban = commands.get("kanban");
	process.env.KANBAN_DEBUG = "1";

	const SID_A = "sid-halt-a";
	const SID_B = "sid-halt-b";
	writeBoardFile(SID_A);
	writeBoardFile(SID_B);
	writeModes(SID_A, SID_B);

	handlers.get("session_start")({ type: "session_start" }, mkCtx(SID_A));
	const ctxB = mkCtx(SID_B, [haltingEntry(Date.now())]);
	handlers.get("session_start")({ type: "session_start" }, ctxB);

	// 前提: loop はプロセス共有なので、B の halted は A が駆動元のままでも効いている。
	traces.length = 0;
	t.poll();
	check("take 前は halted:limit で止まっている（前提）", () =>
		assert.equal(verdictOf(SID_A), "skip:halted:limit", `verdict=${verdictOf(SID_A)}`));
	check("take 前は 1 件も送っていない", () => assert.equal(sent.length, 0, `sent=${sent.length}`));

	await kanban.handler("take", ctxB);
	traces.length = 0;
	t.poll();
	check("take 後の poll は B を駆動し、halted:limit を継承しない", () =>
		assert.equal(verdictOf(SID_B), "fire", `verdict=${verdictOf(SID_B)}`));
	check("take 後の wake は 1 件", () => assert.equal(sent.length, 1, `sent=${sent.length}`));

	// 対照: halted を復元しただけのセッションは発火しない（既存挙動の維持）。
	const { pi: pi2, handlers: h2, sent: sent2 } = mkPi();
	const t2 = mod.default(pi2).__test;
	const SID_C = "sid-halt-c";
	writeBoardFile(SID_C);
	writeModes(SID_A, SID_B, SID_C);
	h2.get("session_start")({ type: "session_start" }, mkCtx(SID_C, [haltingEntry(Date.now())]));
	traces.length = 0;
	t2.poll();
	check("halted を復元したセッションは発火しない", () => assert.equal(sent2.length, 0, `sent=${sent2.length}`));
	check("その verdict は skip:halted:limit", () =>
		assert.equal(verdictOf(SID_C), "skip:halted:limit", `verdict=${verdictOf(SID_C)}`));

	h2.get("session_shutdown")({ type: "session_shutdown", reason: "quit" });
	handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" });
	delete process.env.KANBAN_DEBUG;
}

// --- 4. take が lastActivityAt を捨てる --------------------------------------
// 固定時計。T0 で turn_start（lastActivityAt=T0）→ take → poll が発火して
// lastTickAt=T0 になる。T0+interval+1 では starved ではないので quiet 判定は
// lastActivityAt だけで決まる: リセット済み (0 -> "活動不明") なら skip:not-quiet、
// 残っていれば (T0 は interval 以上前) fire。take 無しの対照と比べる。
const atFixedClock = async (take, SID) => {
	const { pi, handlers, commands, sent } = mkPi();
	const t = mod.default(pi).__test;
	const kanban = commands.get("kanban");
	process.env.KANBAN_DEBUG = "1";
	writeBoardFile(SID);
	writeModes(SID);

	const T0 = 1_700_000_000_000;
	const realNow = Date.now;
	Date.now = () => T0;
	try {
		const ctx = mkCtx(SID);
		handlers.get("session_start")({ type: "session_start" }, ctx);
		handlers.get("turn_start")({ type: "turn_start" }, ctx); // lastActivityAt = T0
		if (take) await kanban.handler("take", ctx);
		t.poll(); // lastTickAt = T0 で発火
		Date.now = () => T0 + mod.AUTO_TICK_MS + 1000;
		traces.length = 0;
		t.poll();
		return { verdict: verdictOf(SID), sent };
	} finally {
		Date.now = realNow;
		handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" });
		delete process.env.KANBAN_DEBUG;
	}
};

{
	const withTake = await atFixedClock(true, "sid-quiet-take");
	check("take は lastActivityAt を捨てる（直近の活動で quiet に落ちない）", () =>
		assert.equal(withTake.verdict, "skip:not-quiet", `verdict=${withTake.verdict}`));
	const noTake = await atFixedClock(false, "sid-quiet-notake");
	check("対照: take 無しなら同じ状況で発火する（差は take のリセット由来）", () =>
		assert.equal(noTake.verdict, "fire", `verdict=${noTake.verdict}`));
}

// --- 5. tickInFlight 中の take 拒否は検証しない -------------------------------
// tickInFlight は poll の中で true -> false が同じ同期ブロックで完結する（wake は
// `void Promise.resolve(...).catch()` で投げっぱなし）。外側から true の瞬間を観測する
// 経路が無く、内部変数を露出させるとテストのためだけに API を増やすことになるため、
// このガードは未検証のまま残す。

process.stderr.write = origWrite;

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
