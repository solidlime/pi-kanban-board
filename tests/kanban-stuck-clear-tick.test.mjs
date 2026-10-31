// #90 stuck-halt の自動解除が「活動時計をリセット」していたかを固定する回帰テスト。
// フレームワーク無しで `node tests/kanban-stuck-clear-tick.test.mjs`。
// 対象:
//   1. 純関数: quiet は lastActivityAt + interval で開く / starved は活動時計を無視する
//   2. 実タイマー: stuck-halt が解除された直後、interval 後に tick が発火する
// 修正前は解除時に lastActivityAt=0（= 活動の記録なし）を書いていたため quiet が
// starved（interval * 3）まで開かず、5 分の窓が 15 分に伸びていた（#88 実験A）。
// HOME と KANBAN_PORT を差し替えるので、本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";

const HOME_DIR = "/tmp/kb-stuck-clear-home";
const ERR_LOG = "/tmp/kb-stuck-clear.err";
rmSync(HOME_DIR, { recursive: true, force: true });
rmSync(ERR_LOG, { force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
process.env.HOME = HOME_DIR;
// Windows: os.homedir() prefers USERPROFILE over HOME, so keep them in step or the
// server writes its token to the real profile and this test reads a missing file.
process.env.USERPROFILE = process.env.HOME;
process.env.KANBAN_DEBUG = "1";
process.env.KANBAN_PORT = String(
	await new Promise((resolve) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	}),
);
// poll の判定（quiet=... => skip:not-quiet / fire）を後から読めるように残す。
const origWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
	appendFileSync(ERR_LOG, `[${Date.now()}] ${chunk}`);
	return origWrite(chunk, ...rest);
};

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

const MIN = 60_000;
const card = (id) => ({ id, col: "doing" });
// lastTickAt は interval を 1 つ超えた程度（starved=3 interval には届かない）に置く。
const base = { isIdle: true, doingLoop: true, card: card(1), halted: null, now: 10 * MIN, lastTickAt: 4 * MIN };

// --- 1. 純関数: quiet の窓と starved の短絡 ---------------------------------
check("活動の記録なし（undefined）は interval を待っても quiet にならない", () => {
	const v = mod.autoTickVerdict({ ...base, lastActivityAt: undefined });
	assert.equal(v.quiet, false, JSON.stringify(v));
	assert.equal(v.reason, "not-quiet", JSON.stringify(v));
});

check("lastActivityAt = now なら interval 直前に not-quiet、interval ちょうどで fire", () => {
	const at = 10 * MIN;
	const before = mod.autoTickVerdict({ ...base, lastActivityAt: at, now: at + mod.AUTO_TICK_MS - 1 });
	assert.equal(before.reason, "not-quiet", JSON.stringify(before));
	const atEdge = mod.autoTickVerdict({ ...base, lastActivityAt: at, now: at + mod.AUTO_TICK_MS });
	assert.equal(atEdge.fire, true, JSON.stringify(atEdge));
});

check("starved: lastTickAt が interval*3 以上古ければ活動時計が新しくても fire", () => {
	const now = 10 * MIN;
	const v = mod.autoTickVerdict({
		...base,
		now,
		lastTickAt: now - mod.AUTO_TICK_MS * mod.STARVATION_FACTOR,
		lastActivityAt: now - 1000, // ついさっき活動した、でも lastTickAt が嘘をついている
	});
	assert.equal(v.quiet, true, JSON.stringify(v));
	assert.equal(v.fire, true, JSON.stringify(v));
});

// --- 2. 実タイマー: stuck-halt 解除 -> interval で発火 ----------------------
const SID = "sid-stuck-clear";
const BOARDS = `${HOME_DIR}/.pi/kanban/sessions/${SID}.json`;
const MODES = `${HOME_DIR}/.pi/kanban/modes.json`;
// intervalMin は分単位の実数。0.1 分 = 6 秒にして、既定 5 分を待たずに同じ判定を通す。
const INTERVAL_MIN = 0.1;
const INTERVAL_MS = INTERVAL_MIN * MIN;

const writeModes = (extra = {}) =>
	writeFileSync(
		MODES,
		JSON.stringify({ SESSION: { [SID]: { doingLoop: true, autoPick: false, intervalMin: INTERVAL_MIN, ...extra } }, GLOBAL: {} }),
	);
const writeBoard = (cards) => writeFileSync(BOARDS, JSON.stringify({ cards, nextId: 9 }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// stuckLimit 1: settle 1 回で halted:stuck が立つ（halt を作るのも解除するのも settle）。
// 盤面を先に作る: modes の掃除（死んだ sid の削除）はボードファイルの存在で判定する。
writeBoard([card(1)]);
writeModes({ stuckLimit: 1 });

async function liveStuckClear() {
	const handlers = new Map();
	const sent = [];
	const pi = {
		registerCommand() {},
		registerTool() {},
		appendEntry() {},
		on(ev, fn) {
			handlers.set(ev, fn);
		},
		sendUserMessage(content) {
			sent.push({ at: Date.now(), content });
		},
	};
	const t = mod.default(pi).__test;
	const ctx = {
		hasUI: false,
		isIdle: () => true,
		ui: { notify() {}, setWidget() {} },
		sessionManager: { getSessionId: () => SID, getEntries: () => [] },
	};
	// (A) 1 発火ぶん回して lastTickAt を「たった今」にする（starvation 短絡を外す）。
	handlers.get("session_start")({}, ctx);
	const deadline = Date.now() + 10_000;
	while (sent.length === 0 && Date.now() < deadline) await sleep(100);
	assert.equal(sent.length, 1, "bootstrap wake が来ない（poll タイマーが回っていない）");
	const tBootstrap = sent[0].at;

	// (B) 同じカードで settle を通す -> stuckLimit 1 なので halted:stuck が立つ。
	handlers.get("agent_before_settle")({ context: { contextMessages: undefined } }, ctx);
	// (C) DOING から #1 が消えた状態で settle を通す -> stuck halt が自動解除される。
	writeBoard([]);
	handlers.get("agent_before_settle")({ context: { contextMessages: undefined } }, ctx);
	const tClear = Date.now();
	assert.ok(tClear - tBootstrap < INTERVAL_MS, `解除が interval 内に起きていない（${tClear - tBootstrap}ms）`);

	// (C) 次の仕事を置く。あとはタイマーが interval 後に起こすかだけを見る。
	writeBoard([card(2)]);
	const wakeDeadline = Date.now() + 12_000;
	while (sent.length < 2 && Date.now() < wakeDeadline) await sleep(100);
	assert.equal(sent.length, 2, `解除後に tick が来ない（${Math.round((Date.now() - tClear) / 1000)}s 経過）`);
	const elapsed = sent[1].at - tClear;
	assert.match(sent[1].content, /#2 /, "解除後の wake は新しいカードでなければならない");
	// 修正前は starved（interval*3 = 18s）まで quiet が開かず、~11.9s かかっていた。
	assert.ok(
		elapsed <= INTERVAL_MS + 3000,
		`解除から ${elapsed}ms で発火。interval(${INTERVAL_MS}ms) を待ちすぎ（starved 待ちの再発）`,
	);
	assert.ok(elapsed >= INTERVAL_MS - 1500, `解除から ${elapsed}ms で発火は早すぎる（quiet を無視している）`);
	assert.equal(t.hasTimer(), true, "タイマーは ensurePollTimer 経由で立っているはず");
	return { tBootstrap, tClear, ...{ wakeAt: sent[1].at, elapsed } };
}

try {
	const timing = await liveStuckClear();
	appendFileSync(ERR_LOG, `\n#90 timing ${JSON.stringify(timing)}\n`);
	passed += 1;
} catch (err) {
	failures.push(`live stuck-halt clear -> interval tick: ${err.message}`);
}

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
