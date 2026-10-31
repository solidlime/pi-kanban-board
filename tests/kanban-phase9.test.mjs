// kanban Phase 9 の自己検証。フレームワーク無しで `node tests/kanban-phase9.test.mjs`。
// 対象: shouldAutoTick の starvation guard（lastActivityAt が更新され続けてもループが
// 永久停止しない逃げ道）/ STARVATION_FACTOR の export / noteActivity の呼び出し箇所。
// HOME と KANBAN_PORT を差し替えるので、本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";

const HOME_DIR = "/tmp/kb-phase9-home";
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
const { shouldAutoTick, parseKanbanArgs, AUTO_TICK_MS, STARVATION_FACTOR } = mod;

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

const MIN = 60_000;
const card = { id: 1, col: "doing" };
// 発火の既定値: アイドル・loop ON・DOING あり・halt 無し・両時計とも 5 分以上前。
const OLD = -10 * MIN;
const base = {
	isIdle: true,
	doingLoop: true,
	card,
	halted: null,
	lastTickAt: OLD,
	lastActivityAt: OLD,
	now: 0,
};

// --- 1: STARVATION_FACTOR の export ------------------------------------------
check("STARVATION_FACTOR === 3", () => assert.equal(STARVATION_FACTOR, 3));

// --- 2: starvation guard が効く ----------------------------------------------
// lastTickAt から interval*3 以上沈黙していれば、lastActivityAt が新しくても発火する。
check("starved: lastTickAt が interval*3 前 & lastActivityAt が新しくても発火", () =>
	assert.equal(
		shouldAutoTick({ isIdle: true, doingLoop: true, card, halted: null, lastTickAt: -15 * MIN, lastActivityAt: 0, now: 0 }),
		true,
	));
check("starved: ちょうど interval*3 で発火", () =>
	assert.equal(
		shouldAutoTick({ isIdle: true, doingLoop: true, card, halted: null, lastTickAt: -3 * AUTO_TICK_MS, lastActivityAt: 0, now: 0 }),
		true,
	));
check("starved: lastActivityAt が undefined でも発火（活動記録の破損で永久停止しない）", () =>
	assert.equal(
		shouldAutoTick({ isIdle: true, doingLoop: true, card, halted: null, lastTickAt: -15 * MIN, lastActivityAt: undefined, now: 0 }),
		true,
	));
check("starved: intervalMs 15分 は 45分で発火", () =>
	assert.equal(
		shouldAutoTick({ isIdle: true, doingLoop: true, card, halted: null, lastTickAt: -45 * MIN, lastActivityAt: 0, now: 0, intervalMs: 15 * MIN }),
		true,
	));

// --- 3: 通常の静止ゲートは維持（starve していなければ lastActivityAt が効く） ---
check("non-starved & lastActivityAt が新しい -> 発火しない", () =>
	assert.equal(shouldAutoTick({ ...base, lastActivityAt: base.now - 1000 }), false));
check("non-starved: interval*3 の 1ms 手前 & lastActivityAt が新しい -> 発火しない", () =>
	assert.equal(
		shouldAutoTick({ ...base, lastTickAt: -3 * AUTO_TICK_MS + 1, lastActivityAt: 0, now: 0 }),
		false,
	));
check("non-starved: 両方古い -> 発火する（従来どおり）", () => assert.equal(shouldAutoTick(base), true));
check("non-starved: lastActivityAt だけ undefined -> 発火しない（活動不明は活動あり扱い）", () =>
	assert.equal(shouldAutoTick({ ...base, lastActivityAt: undefined }), false));

// --- 4: halt と menuOpen は starvation guard より優先 -------------------------
check("halted:'stuck' は starved でも発火しない", () =>
	assert.equal(shouldAutoTick({ ...base, halted: "stuck", lastActivityAt: 0 }), false));
check("halted:'limit' は starved でも発火しない", () =>
	assert.equal(shouldAutoTick({ ...base, halted: "limit", lastActivityAt: 0 }), false));
check("menuOpen:true は starved でも発火しない", () =>
	assert.equal(shouldAutoTick({ ...base, menuOpen: true, lastActivityAt: 0 }), false));
check("isIdle:false は starved でも発火しない", () =>
	assert.equal(shouldAutoTick({ ...base, isIdle: false, lastActivityAt: 0 }), false));
check("card 無しは starved でも発火しない", () =>
	assert.equal(shouldAutoTick({ ...base, card: undefined, lastActivityAt: 0 }), false));

// --- 5: noteActivity の呼び出し箇所（ソース実測） -----------------------------
const src = readFileSync(SRC, "utf8");
check("noteActivity の呼び出しは turn_start の 1 箇所だけ", () => {
	assert.equal((src.match(/noteActivity\(\)/g) ?? []).length, 1, "呼び出しは 1 箇所であること");
	// その 1 箇所が turn_start ハンドラの中にあること（定義ではなく呼び出しの位置）。
	const turnStart = src.slice(src.indexOf('pi.on("turn_start"'));
	assert.ok(turnStart.slice(0, 200).includes("noteActivity()"), "turn_start ハンドラから noteActivity を呼ぶ");
});
check("context_with_system の noteActivity 呼び出しは削除済み", () => {
	// 計測結果: turn_start も context_with_system も 1 LLM リクエストにつき 1 回で同頻度。
	// 片方は冗長なので context_with_system 側は持たない。
	const ev = src.indexOf('pi.on("context_with_system"');
	assert.equal(ev, -1, "context_with_system ハンドラ自体を持たない");
});

// --- 6: 既存の非ループ機能（parseKanbanArgs）が壊れていないこと ---------------
check("［買い物］ -> add", () => eq(parseKanbanArgs(["買い物"]), { kind: "add", text: "買い物" }));
check("［interval 3］ -> interval", () =>
	eq(parseKanbanArgs(["interval", "3"]), { kind: "interval", scope: "session", minutes: 3 }));
check("［interval global 3］ -> interval(global)", () =>
	eq(parseKanbanArgs(["interval", "global", "3"]), { kind: "interval", scope: "global", minutes: 3 }));
check("［interval off］ -> reject（数値でない）", () =>
	eq(parseKanbanArgs(["interval", "off"]).kind, "reject"));
check("［stuck 5］ -> stuck", () =>
	eq(parseKanbanArgs(["stuck", "5"]), { kind: "stuck", scope: "session", count: 5 }));
check("［loop on］ -> mode", () =>
	eq(parseKanbanArgs(["loop", "on"]), { kind: "mode", key: "doingLoop", value: true }));
check("［pick off］ -> mode", () =>
	eq(parseKanbanArgs(["pick", "off"]), { kind: "mode", key: "autoPick", value: false }));
check("［priority 3 5］ -> priority", () =>
	eq(parseKanbanArgs(["priority", "3", "5"]), { kind: "priority", id: 3, value: 5 }));
check("［priority］ -> 一覧", () =>
	eq(parseKanbanArgs(["priority"]), { kind: "priority", id: undefined, value: undefined }));
check("［］ -> menu", () => eq(parseKanbanArgs([]), { kind: "menu" }));
check("AUTO_TICK_MS は 5 分のまま", () => assert.equal(AUTO_TICK_MS, 5 * MIN));

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
// poll timer は session_start を踏んでいないので未生成。純関数のみなので即終了。
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
