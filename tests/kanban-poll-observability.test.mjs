// kanban poll 可観測性 + listen 一回性の回帰テスト。
// `node tests/kanban-poll-observability.test.mjs`（フレームワーク無し、既存テストと同じ流儀）。
// 対象 (#46):
//   1. sendUserMessage の戻り promise に .catch( が付いている（拒否を握り潰さない）
//   2. KANBAN_DEBUG を参照する poll ゲートのトレースがある
//   3. listen はプロセス内で 1 回だけ（ensured）。兄弟 pi が 8789 を持つ場合の EADDRINUSE 連打を止める
//   4. poll を直接叩き、KANBAN_DEBUG=1 のときだけ 1 行 stderr に出る
// HOME と KANBAN_PORT を差し替えるので、本番の ~/.pi/kanban と 8789 には触れない。
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";

const HOME_DIR = "/tmp/kb-pollobs-home";
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
const SOURCE = readFileSync(new URL("../extensions/kanban.ts", import.meta.url), "utf8");

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
const writeBoardFile = (sid) =>
	writeFileSync(
		`${SESSIONS}/${sid}.json`,
		JSON.stringify({ cards: [{ id: 7, text: "t", col: "todo" }], nextId: 8 }),
	);
const writeModes = (sid) =>
	writeFileSync(
		MODES,
		JSON.stringify({ SESSION: { [sid]: { doingLoop: true, autoPick: true, intervalMin: 3 } }, GLOBAL: {} }),
	);

// --- 1/2/3: ソース上の契約（.catch / KANBAN_DEBUG / ensured） --------------------
check("sendUserMessage の結果に .catch( が付いている", () => {
	const m = SOURCE.match(/pi\.sendUserMessage\([^;]*?\n?[\s\S]{0,400}?\.catch\(/);
	assert.ok(m, "sendUserMessage に .catch( が見つからない");
});
check("wake 拒否は logServer 経由で stderr/server.log に落ちる", () => {
	assert.match(SOURCE, /logServer\(\s*`wake rejected: \$\{/);
});
check("poll ゲートのトレースが KANBAN_DEBUG を参照している", () => {
	assert.match(SOURCE, /process\.env\.KANBAN_DEBUG/);
	assert.match(SOURCE, /kanban: poll sid=\$\{sid\} idle=/);
});
// #64: 旧 "ensured でプロセス内 1 回" は廃止。一度の失敗が寿命中ずっと listen を殺していた。
// 今は状態自体（server/apiStarting/apiState）がガードで、apiStarting は finally で戻る。
check("listen は状態ガードで再試行でき、apiStarting は finally で戻る", () => {
	assert.doesNotMatch(SOURCE, /let ensured = false;/);
	assert.match(SOURCE, /if \(server !== null \|\| apiStarting\) return;/);
	assert.match(SOURCE, /\} finally \{\s*apiStarting = false;/);
	assert.match(SOURCE, /if \(e\.code === "EADDRINUSE"\) \{/);
	assert.match(SOURCE, /await probeServer\(\)/);
});

// --- 4: poll を直接叩いてトレース出力を数える ----------------------------------
const SID = "sid-pollobs";
writeBoardFile(SID);
writeModes(SID);

const pollLines = [];
const origWrite = process.stderr.write.bind(process.stderr);
const capture = () => {
	process.stderr.write = (chunk) => {
		const s = typeof chunk === "string" ? chunk : chunk.toString();
		if (s.includes("kanban: poll ")) pollLines.push(s.trim());
		return true;
	};
};
const restore = () => {
	process.stderr.write = origWrite;
};

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
function mkCtx(sid) {
	return {
		hasUI: false,
		isIdle: () => true,
		ui: { notify() {}, setWidget() {} },
		sessionManager: {
			getSessionId: () => sid,
			getSessionName: () => undefined,
			getEntries: () => [],
		},
	};
}

// 4a: KANBAN_DEBUG 未設定 -> 1 行も出ない。
{
	delete process.env.KANBAN_DEBUG;
	const { pi, handlers } = mkPi();
	const t = mod.default(pi).__test;
	capture();
	handlers.get("session_start")({ type: "session_start" }, mkCtx(SID));
	t.poll();
	t.poll();
	restore();
	check("KANBAN_DEBUG 未設定では poll 行が出ない", () => eq(pollLines, []));
}

// 4b: KANBAN_DEBUG=1 -> 1 tick = 1 行、発火 → 次 tick は skip:interval。
{
	process.env.KANBAN_DEBUG = "1";
	const { pi, handlers, sent } = mkPi();
	const t = mod.default(pi).__test;
	pollLines.length = 0;
	capture();
	handlers.get("session_start")({ type: "session_start" }, mkCtx(SID));
	t.poll();
	const afterFirst = pollLines.slice();
	t.poll();
	restore();
	delete process.env.KANBAN_DEBUG;

	check("KANBAN_DEBUG=1 で poll 行が 1 tick 1 行", () => assert.equal(afterFirst.length, 1, afterFirst.join("|")));
	check("1 行目は発火", () => assert.match(afterFirst[0], /=> fire$/));
	check("トレースに sid/idle/doingLoop/card/halted/sinceLastTick/quiet が入る", () => {
		const line = afterFirst[0];
		assert.match(line, new RegExp(`kanban: poll sid=${SID} idle=true doingLoop=true card=7 halted=null sinceLastTick=\\d+ quiet=true => fire`));
	});
	check("発火したので wake は 1 件", () => assert.equal(sent.length, 1, `sent=${sent.length}`));
	check("2 tick 目は skip:interval", () => assert.match(pollLines[1] ?? "", /=> skip:interval$/));
}

// 4c: TODO が無ければ skip:no-card（ゲートの理由が読める）。
{
	process.env.KANBAN_DEBUG = "1";
	writeFileSync(`${SESSIONS}/${SID}.json`, JSON.stringify({ cards: [], nextId: 1 }));
	const { pi, handlers } = mkPi();
	const t = mod.default(pi).__test;
	pollLines.length = 0;
	capture();
	handlers.get("session_start")({ type: "session_start" }, mkCtx(SID));
	t.poll();
	restore();
	delete process.env.KANBAN_DEBUG;
	check("カード無しは skip:no-card で idle は n/a", () =>
		assert.match(pollLines[0] ?? "", /card=null .*=> skip:no-card$/),
	);
	check("カードが無い tick は isIdle を呼ばない（トレースが idle=n/a）", () =>
		assert.match(pollLines[0] ?? "", / idle=n\/a /),
	);
}

// 4d: 再起動（loop エントリから count=9 / halted=null を復元）後の経路でも pollTimer が立ち、
// 初回 tick で発火する。#46 の「再起動後に一度も動かない」をゲート側で押さえる。
{
	process.env.KANBAN_DEBUG = "1";
	writeFileSync(
		`${SESSIONS}/${SID}.json`,
		JSON.stringify({ cards: [{ id: 46, text: "t", col: "doing", movedBy: SID }], nextId: 47 }),
	);
	const { pi, handlers, sent } = mkPi();
	const loopEntry = {
		type: "custom",
		customType: "kanban-loop",
		data: { count: 9, halted: null, stuckId: 46, stuckCount: 1, lastActivityAt: Date.now() - 20 * 60_000 },
	};
	const ctx = mkCtx(SID);
	ctx.sessionManager.getEntries = () => [loopEntry];
	const t = mod.default(pi).__test;
	pollLines.length = 0;
	capture();
	handlers.get("session_start")({ type: "session_start" }, ctx);
	const timerArmed = t.hasTimer();
	const beforeTick = pollLines.length;
	t.poll();
	restore();
	delete process.env.KANBAN_DEBUG;
	check("session_start で pollTimer が立つ", () => assert.equal(timerArmed, true));
	check("session_start 自体は tick しない（初回は interval 待ち）", () => assert.equal(beforeTick, 0));
	check("再起動（count=9 復元）後の初回 tick で発火する", () =>
		assert.match(pollLines[0] ?? "", /card=46 .*=> fire$/),
	);
	check("再起動後の初回 tick が wake を 1 件出す", () => assert.equal(sent.length, 1, `sent=${sent.length}`));
}

// 4e: ownCtx が無い tick も debug 時だけは 1 行出す（黙って死ぬ経路を可視化する）。
{
	process.env.KANBAN_DEBUG = "1";
	const { pi } = mkPi();
	const t = mod.default(pi).__test; // session_start を一度も呼ばない = ownCtx null
	pollLines.length = 0;
	capture();
	t.poll();
	restore();
	delete process.env.KANBAN_DEBUG;
	check("ownCtx 無しの tick は skip:no-ctx を出す", () => eq(pollLines, ["kanban: poll => skip:no-ctx"]));
}

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
