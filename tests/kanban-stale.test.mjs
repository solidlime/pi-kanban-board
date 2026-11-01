// #18: 停滞検知（movedAt からの経過）。サーバは要らない純関数テスト。
// フレームワーク無しで `node tests/kanban-stale.test.mjs`。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { useKanban } from "./helpers/board.mjs";

const HOME_DIR = tmpdir() + "/kb-stale-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${join(HOME_DIR, ".pi/kanban/sessions")}`, { recursive: true });
process.env.HOME = HOME_DIR;
// Windows: os.homedir() prefers USERPROFILE over HOME.
process.env.USERPROFILE = process.env.HOME;
// モジュールが import 時に読むので、先に空きポートを渡す。
process.env.KANBAN_PORT = String(
	await new Promise((resolve) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	}),
);

const { createJiti } = createRequire(import.meta.url)(
	process.env.KANBAN_JITI ?? createRequire(import.meta.url).resolve("jiti"),
);
const mod = await createJiti(import.meta.url).import(fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url)));
useKanban(mod);
const { staleSince, oldestDoingAge, staleTag, renderInjectionText } = mod;

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

const H = 3_600_000;
const D = 86_400_000;
const NOW = 1_900_000_000_000; // 固定時刻（実時計に依存させない）
const board = (cards) => ({ cards, nextId: cards.length + 1 });

// --- staleSince: 段階の境界 ---------------------------------------------------
check("staleSince: 2時間59分は何も出さない", () => {
	assert.equal(staleSince(2 * H + 59 * 60_000), null);
});
check("staleSince: ちょうど3時間で時間表示", () => {
	assert.equal(staleSince(3 * H), "⚠3h");
});
check("staleSince: 23時間はまだ時間表示", () => {
	assert.equal(staleSince(23 * H), "⚠23h");
});
check("staleSince: ちょうど24時間で日表示", () => {
	assert.equal(staleSince(D), "⚠1d");
});
check("staleSince: 7日", () => {
	assert.equal(staleSince(7 * D), "⚠7d");
});
check("staleSince: 8.5日は切り捨てて 8d", () => {
	assert.equal(staleSince(8.5 * D), "⚠8d");
});

// --- oldestDoingAge / staleTag ------------------------------------------------
check("staleTag: DOING 限定（古い TODO では警告しない）", () => {
	const b = board([
		{ id: 1, text: "古いが未着手", col: "todo", movedAt: NOW - 5 * D },
		{ id: 2, text: "始めたばかり", col: "doing", movedAt: NOW - 10 * 60_000 },
	]);
	assert.equal(oldestDoingAge(b, NOW), 10 * 60_000);
	assert.equal(staleTag(b, NOW), "");
});
check("staleTag: movedAt の無い DOING は推測しない（警告しない）", () => {
	const b = board([{ id: 1, text: "スタンプ無し", col: "doing" }]);
	assert.equal(oldestDoingAge(b, NOW), Number.NEGATIVE_INFINITY);
	assert.equal(staleTag(b, NOW), "");
});
check("staleTag: 複数の DOING は最古を採る（先頭スペース + ラベル）", () => {
	const b = board([
		{ id: 1, text: "3時間", col: "doing", movedAt: NOW - 3 * H },
		{ id: 2, text: "5日", col: "doing", movedAt: NOW - 5 * D },
		{ id: 3, text: "スタンプ無し", col: "doing" },
	]);
	assert.equal(oldestDoingAge(b, NOW), 5 * D);
	assert.equal(staleTag(b, NOW), " ⚠5d");
});

// --- renderInjectionText: 注入文の経過表記 ------------------------------------
check("renderInjectionText: 1日以上は警告タグだけになる（日数の重複を出さない）", () => {
	const out = renderInjectionText(board([{ id: 1, text: "止まってる", col: "doing", movedAt: Date.now() - 2 * D }]));
	const doingLine = out.split("\n").find((l) => l.startsWith("DOING"));
	assert.ok(doingLine.includes("(⚠2d)"), `日数の警告が無い: ${doingLine}`);
	assert.ok(!doingLine.includes("2日前から"), `日数が二重に出ている: ${doingLine}`);
});
check("renderInjectionText: 3時間以上1日未満も時間のタグだけ", () => {
	const out = renderInjectionText(board([{ id: 1, text: "止まりかけ", col: "doing", movedAt: Date.now() - 5 * H }]));
	const doingLine = out.split("\n").find((l) => l.startsWith("DOING"));
	assert.ok(doingLine.includes("(⚠5h)"), `時間の警告が無い: ${doingLine}`);
	assert.ok(!doingLine.includes("300分"), `分と時間が二重に出ている: ${doingLine}`);
});

for (const f of failures) console.error("FAIL", f);
console.log(`kanban-stale: ${passed} passed, ${failures.length} failed`);
if (!failures.length) console.log("OK");
setTimeout(() => process.exit(failures.length ? 1 : 0), 100);
