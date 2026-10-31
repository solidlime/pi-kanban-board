// kanban Phase 8 の自己検証。フレームワーク無しで `node tests/kanban-phase8.test.mjs`。
// 対象: shouldAutoTick の lastActivityAt ゲート（「完全静止したときだけ発火」）/
// isUserInputHead（ユーザーの head 発話だけを抑制）/ parseKanbanArgs の非破壊。
// HOME と KANBAN_PORT を差し替えるので、本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";

const HOME_DIR = "/tmp/kb-phase8-home";
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
const mod = await jiti.import(fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url)));
const { shouldAutoTick, isUserInputHead, parseKanbanArgs, AUTO_TICK_MS } = mod;

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

// --- 1: shouldAutoTick の lastActivityAt ゲート --------------------------------
check("両方古い -> 発火（従来どおり）", () => assert.equal(shouldAutoTick(base), true));
check("lastActivityAt が新しい -> 発火しない（完全静止のみ）", () =>
	assert.equal(shouldAutoTick({ ...base, lastActivityAt: base.now - 1000 }), false));
check("lastTickAt が新しい -> 発火しない（従来条件も維持）", () =>
	assert.equal(shouldAutoTick({ ...base, lastTickAt: base.now - 1000 }), false));
check("両方 undefined -> 発火しない（起動直後の暴発防止）", () =>
	assert.equal(shouldAutoTick({ ...base, lastTickAt: undefined, lastActivityAt: undefined }), false));
check("lastActivityAt だけ undefined -> 発火しない（活動不明は活動あり扱い）", () =>
	assert.equal(shouldAutoTick({ ...base, lastActivityAt: undefined }), false));
check("境界: lastActivityAt がちょうど interval 前 -> 発火", () =>
	assert.equal(shouldAutoTick({ ...base, lastActivityAt: base.now - 5 * MIN }), true));
check("境界: 1ms 足りない -> 発火しない", () =>
	assert.equal(shouldAutoTick({ ...base, lastActivityAt: base.now - 5 * MIN + 1 }), false));
check("intervalMs 15分: 活動は 5 分前 -> 発火しない", () =>
	assert.equal(shouldAutoTick({ ...base, intervalMs: 15 * MIN, lastActivityAt: -5 * MIN }), false));
check("menuOpen:true は従来どおり最優先で止める", () =>
	assert.equal(shouldAutoTick({ ...base, menuOpen: true }), false));
check("AUTO_TICK_MS は 5 分のまま", () => assert.equal(AUTO_TICK_MS, 5 * MIN));

// --- 2: 活動を記録すると発火が止まる（関数レベルで実測） -----------------------
check("lastActivityAt を now に更新 -> 発火しない", () => {
	const now = Date.now();
	const before = shouldAutoTick({ ...base, lastTickAt: now - 10 * MIN, lastActivityAt: now - 10 * MIN, now });
	assert.equal(before, true, "更新前は静止していて発火する");
	const after = shouldAutoTick({ ...base, lastTickAt: now - 10 * MIN, lastActivityAt: now, now });
	assert.equal(after, false, "更新後（静止していない）は発火しない");
});
check("lastActivityAt 更新から interval 経過で再び発火する", () => {
	const t = 1_000_000;
	const marked = shouldAutoTick({ ...base, lastTickAt: t - 10 * MIN, lastActivityAt: t, now: t });
	assert.equal(marked, false);
	const quiet = shouldAutoTick({ ...base, lastTickAt: t, lastActivityAt: t, now: t + 5 * MIN });
	assert.equal(quiet, true);
});

// --- 3: isUserInputHead -------------------------------------------------------
// 真になるのは「最後の要素が user」だけ。履歴の途中に user があっても偽。
const UI_TABLE = [
	[[{ role: "user" }], true],
	[[{ role: "assistant" }], false],
	// 今回の修正の核心: 一度でも会話されたら止まる、をやめる。
	[[{ role: "user" }, { role: "assistant" }], false],
	[[{ role: "assistant" }, { role: "user" }], true],
	[[{ role: "assistant" }, { role: "toolResult" }], false],
	[[], false],
	[undefined, false],
	[[{ role: 42 }], false],
	[[{ role: "custom", customType: "kanban-loop-continue" }], false],
	[["user"], false],
	[[null], false],
];
for (const [input, expected] of UI_TABLE) {
	check(`isUserInputHead(${JSON.stringify(input)}) -> ${expected}`, () =>
		assert.equal(isUserInputHead(input), expected));
}

// --- 4: agent_before_settle / poll 相当のフロー -------------------------------
// settle 側のゲート: head が user の発話のときだけ注入しない。
const injectsOnSettle = (contextMessages) => !isUserInputHead(contextMessages);
// poll 側のゲート: 完全静止しているときだけ注入する。
const injectsOnPoll = (tick) => shouldAutoTick(tick);

// 仕様 #2: 履歴に user があっても、エージェント応答済み（head=assistant）なら settle は通る。
check("履歴に user があっても head が assistant（応答済み）-> settle は注入する", () => {
	const contextMessages = [{ role: "user" }, { role: "assistant" }];
	assert.equal(injectsOnSettle(contextMessages), true, "応答済みの run には継続を重ねてよい");
	// 両時計沈黙の poll も同時に開いている（両ゲートの組み合わせ）。
	assert.equal(injectsOnPoll(base), true, "静止していれば poll も注入する");
});
check("head が user（発話直後）-> settle は抑制する", () => {
	const contextMessages = [{ role: "assistant" }, { role: "user" }];
	assert.equal(injectsOnSettle(contextMessages), false, "ユーザーの発話直後に steer で割り込まない");
});
check("履歴に user が残っていても head が custom -> 注入できる（沈黙しない）", () => {
	assert.equal(injectsOnSettle([{ role: "user" }, { role: "custom", customType: "kanban-loop-continue" }]), true);
});
check("custom メッセージだけの context -> 注入できる（ユーザーロールではない）", () => {
	assert.equal(injectsOnSettle([{ role: "custom", customType: "kanban-loop-continue" }]), true);
});
check("判定不能（messages 未定義）-> 従来通り注入する（静かに止まらない）", () => {
	assert.equal(injectsOnSettle(undefined), true);
});
check("ユーザー発話直後の poll -> 両ゲートとも止める", () => {
	const now = 5 * MIN + 30_000; // 前回 tick から 5 分半、しかし 30 秒前に発話
	const tick = { ...base, lastTickAt: 5 * MIN, lastActivityAt: now - 30_000, now };
	assert.equal(injectsOnPoll(tick), false);
});
check("完全静止（発話から 5 分）-> poll は注入する", () => {
	const now = 10 * MIN;
	const tick = { ...base, lastTickAt: 5 * MIN, lastActivityAt: 10 * MIN - 5 * MIN, now };
	assert.equal(injectsOnPoll(tick), true);
});

// --- 5: 既存の非ループ機能（parseKanbanArgs）が壊れていないこと ---------------
check("［買い物］ -> add", () => eq(parseKanbanArgs(["買い物"]), { kind: "add", text: "買い物" }));
check("［interval 3］ -> interval", () =>
	eq(parseKanbanArgs(["interval", "3"]), { kind: "interval", scope: "session", minutes: 3 }));
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

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
// poll timer は session_start を踏んでいないので未生成。純関数のみなので即終了。
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
