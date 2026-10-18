// kanban loop-ctx 回帰テスト。フレームワーク無しで `node tests/kanban-loop-ctx.test.mjs`。
// 対象: poll が駆動する ctx の所有権（A: 最初の session_start が owner） /
//       死んだ ctx で interval が死なないこと（B: 2 連続 throw で timer を止める）。
// HOME と KANBAN_PORT を差し替えるので、本番の ~/.pi/kanban と 8789 には触れない。
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const HOME_DIR = "/tmp/kb-loopctx-home";
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

const SESSIONS = `${HOME_DIR}/.pi/kanban/sessions`;
const MODES = `${HOME_DIR}/.pi/kanban/modes.json`;
const board = (sid) => `${SESSIONS}/${sid}.json`;
const writeBoardFile = (sid) =>
	writeFileSync(board(sid), JSON.stringify({ cards: [{ id: 1, text: "t", col: "doing" }], nextId: 2 }));
const writeModes = (sid) =>
	writeFileSync(MODES, JSON.stringify({ SESSION: { [sid]: { doingLoop: true, autoPick: false } }, GLOBAL: {} }));
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

// factory は 1 呼び出し = 1 クロージャ。テストごとに新しい pi を作って隔離する。
function mkPi() {
	const handlers = new Map();
	const sent = [];
	const pi = {
		registerCommand() {},
		registerTool() {},
		appendEntry() {},
		on(ev, fn) {
			handlers.set(ev, fn);
		},
		sendUserMessage(c) {
			sent.push(c);
		},
	};
	return { pi, handlers, sent };
}

function mkCtx(sid, idle = true) {
	return {
		hasUI: false,
		isIdle: typeof idle === "function" ? idle : () => idle,
		ui: { notify() {}, setWidget() {} },
		sessionManager: {
			getSessionId: () => sid,
			getSessionName: () => undefined,
			getEntries: () => [],
		},
	};
}

// stdin/stderr に出る警告を数える（"1 回だけ" の検証用）。
const warns = [];
const origWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk) => {
	const s = typeof chunk === "string" ? chunk : chunk.toString();
	if (s.includes("poll ctx")) warns.push(s);
	return true;
};

// --- A1/A2: ownCtx は最初の session_start が持ち、後続セッションに奪われない -----
{
	const { pi, handlers } = mkPi();
	const t = mod.default(pi).__test;
	const ctxA = mkCtx("sid-A");
	const ctxB = mkCtx("sid-B");

	handlers.get("session_start")({ type: "session_start" }, ctxA);
	check("session_start#1 が ownCtx を取る", () => eq(t.ownCtx(), ctxA));
	check("session_start で timer が張られる", () => assert.equal(t.hasTimer(), true));

	handlers.get("session_start")({ type: "session_start" }, ctxB);
	check("別 sid の session_start は乗っ取らない", () => eq(t.ownCtx(), ctxA));

	// 別セッションの枝移動でも奪われない。
	handlers.get("session_tree")({ type: "session_tree" }, ctxB);
	check("別 sid の session_tree は乗っ取らない", () => eq(t.ownCtx(), ctxA));

	// 同じセッションの枝移動は追随する（A1: 死んだ枝を見続けない）。
	const ctxA2 = mkCtx("sid-A");
	handlers.get("session_tree")({ type: "session_tree" }, ctxA2);
	check("同一 sid の session_tree は ownCtx を更新", () => eq(t.ownCtx(), ctxA2));

	handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" });
	check("session_shutdown で ownCtx=null", () => assert.equal(t.ownCtx(), null));
	check("session_shutdown で timer 停止", () => assert.equal(t.hasTimer(), false));
}

// --- B1: 一過性の throw は tick をスキップするだけで timer を止めない -----------
{
	const { pi, handlers, sent } = mkPi();
	const t = mod.default(pi).__test;
	const SID = "sid-transient";
	writeBoardFile(SID);
	writeModes(SID);

	let first = true;
	const ctx = mkCtx(SID, () => {
		if (first) {
			first = false;
			throw new Error("boom");
		}
		return true;
	});
	handlers.get("session_start")({ type: "session_start" }, ctx);

	t.poll(); // isIdle が throw -> strike 1、クラッシュしない
	check("throw した tick でもクラッシュしない", () => eq(t.ownCtx(), ctx));
	check("1 回の throw では timer を止めない", () => assert.equal(t.hasTimer(), true));

	t.poll(); // 次 tick は isIdle 成功 -> 発火
	check("throw の次の tick が動く（送信 1 件）", () => assert.equal(sent.length, 1, `sent=${sent.length}`));
	check("throw は 1 回だけ警告", () => assert.equal(warns.length, 1, `warns=${warns.length}`));
	check("警告文に poll ctx が入る", () => assert.match(warns[0], /poll ctx unavailable/));
}

// --- B2: 死んだ ctx は 2 連続 throw で解放し、timer も止める --------------------
{
	const { pi, handlers, sent } = mkPi();
	const t = mod.default(pi).__test;
	const SID = "sid-dead";
	writeBoardFile(SID);
	writeModes(SID);

	const ctx = mkCtx(SID, () => {
		throw new Error("runner disposed");
	});
	handlers.get("session_start")({ type: "session_start" }, ctx);

	t.poll(); // strike 1
	check("死んだ ctx: 1 回目は保持", () => eq(t.ownCtx(), ctx));
	t.poll(); // strike 2 -> stopPoll
	check("死んだ ctx: 2 連続 throw で ownCtx=null", () => assert.equal(t.ownCtx(), null));
	check("死んだ ctx: 2 連続 throw で timer 停止", () => assert.equal(t.hasTimer(), false));
	check("死んだ ctx からも送信しない", () => assert.equal(sent.length, 0));

	// 解放後の tick は no-op（例外を投げない）。
	t.poll();
	check("解放後の poll は no-op", () => assert.equal(t.ownCtx(), null));
	// 次の session_start が再び owner になれる。
	const ctx2 = mkCtx(SID, false);
	handlers.get("session_start")({ type: "session_start" }, ctx2);
	check("停止後は次の session_start が再取得", () => eq(t.ownCtx(), ctx2));
}

process.stderr.write = origWrite;

check("modes.json は読める（副作用の健全性）", () => assert.ok(readJson(MODES).SESSION));

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
