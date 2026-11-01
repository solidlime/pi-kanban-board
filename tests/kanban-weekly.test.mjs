// #23: 週次サマリ。純関数（isoWeek / weekRange / weeklySummary）と HTTP（/api/weekly）。
// フレームワーク無しで `node tests/kanban-weekly.test.mjs`。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { authFetch } from "./helpers/token.mjs";
import { useKanban, seedBoard } from "./helpers/board.mjs";

const tf = (input, init) => authFetch(input, init);

const HOME_DIR = tmpdir() + "/kb-weekly-home";
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
const BASE = `http://127.0.0.1:${process.env.KANBAN_PORT}`;

const { createJiti } = createRequire(import.meta.url)(
	process.env.KANBAN_JITI ?? createRequire(import.meta.url).resolve("jiti"),
);
const mod = await createJiti(import.meta.url).import(fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url)));
useKanban(mod);

const failures = [];
let passed = 0;
async function check(name, fn) {
	try {
		await fn();
		passed += 1;
	} catch (err) {
		failures.push(`${name}: ${err.message}`);
	}
}

const D = 86_400_000;
const iso = (s) => new Date(`${s}T00:00:00Z`);
// 固定時刻。実時計に依存させない（週次の集計は now を引数に取る）。
const NOW = Date.parse("2026-08-26T12:00:00Z"); // 2026-08-26 は水曜（2026-W35）
const WEEK = "2026-W35";

// --- 1. isoWeek の境界 --------------------------------------------------------
await check("isoWeek: 年跨ぎ（2026-01-01 は 2026-W01、前日は 2025-W53 ではない）", () => {
	assert.equal(mod.isoWeek(iso("2026-01-01")), "2026-W01");
	// 2025 は 52 週なので、2025-12-31 は 2026-W01（ISO 週は木曜が属する年で決まる）。
	assert.equal(mod.isoWeek(iso("2025-12-31")), "2026-W01");
	assert.equal(mod.isoWeek(iso("2025-12-29")), "2026-W01");
	assert.equal(mod.isoWeek(iso("2025-12-28")), "2025-W52");
});
await check("isoWeek: 月曜と日曜が同じ週、翌月曜で次の週", () => {
	assert.equal(mod.isoWeek(iso("2026-01-05")), "2026-W02"); // 月
	assert.equal(mod.isoWeek(iso("2026-01-11")), "2026-W02"); // 日
	assert.equal(mod.isoWeek(iso("2026-01-12")), "2026-W03"); // 翌月
});
await check("isoWeek: 53 週の年（2020-W53 と 2026-W53）", () => {
	assert.equal(mod.isoWeek(iso("2021-01-01")), "2020-W53");
	assert.equal(mod.isoWeek(iso("2020-12-28")), "2020-W53");
	assert.equal(mod.isoWeek(iso("2026-12-28")), "2026-W53");
	assert.equal(mod.isoWeek(iso("2027-01-03")), "2026-W53"); // 週の終わりは翌年
	assert.equal(mod.isoWeek(iso("2027-01-04")), "2027-W01");
});

// --- 2. weekRange の往復 ------------------------------------------------------
await check("weekRange: isoWeek との往復（from がその週を指し返す）", () => {
	for (const w of ["2020-W53", "2025-W52", "2026-W01", "2026-W35", "2026-W53", "2027-W01"]) {
		const r = mod.weekRange(w);
		assert.ok(r !== null, `${w} が null`);
		assert.equal(mod.isoWeek(new Date(r.from)), w, `${w} の from が往復しない`);
		assert.equal(r.to - r.from, 7 * D, `${w} の長さが 7 日でない`);
		assert.equal(mod.isoWeek(new Date(r.to - 1)), w, `${w} の to が翌週に食い込む`);
	}
});
await check("weekRange: 2026-W35 は月曜 00:00 UTC から", () => {
	const r = mod.weekRange(WEEK);
	assert.equal(new Date(r.from).toISOString(), "2026-08-24T00:00:00.000Z");
	assert.equal(new Date(r.to).toISOString(), "2026-08-31T00:00:00.000Z");
});

// --- 3. weekRange の不正入力 --------------------------------------------------
await check("weekRange: 存在しない週と壊れた文字列は null", () => {
	assert.equal(mod.weekRange("2026-W54"), null); // 2026 は 53 週まで
	assert.equal(mod.weekRange("2025-W53"), null); // 2025 は 52 週まで
	assert.equal(mod.weekRange("2026-W00"), null);
	assert.equal(mod.weekRange("x"), null);
	assert.equal(mod.weekRange(""), null);
	assert.equal(mod.weekRange("2026-35"), null);
});

// --- 4. weeklySummary --------------------------------------------------------
const boards = () => [
	{
		slug: "kb-core",
		cards: [
			// 週内の done
			{ id: 1, text: "週内に片付いた", col: "done", movedAt: Date.parse("2026-08-25T03:00:00Z") },
			// 週外の done（先週）
			{ id: 2, text: "先週片付いた", col: "done", movedAt: Date.parse("2026-08-20T03:00:00Z") },
			// movedAt が無い done は拾わない（at: 0 を捏造しない）
			{ id: 3, text: "スタンプ無し", col: "done" },
			// doing: 3.9 日 -> days は切り捨てて 3
			{ id: 4, text: "止まってる", col: "doing", movedAt: NOW - 3.9 * D },
			// doing だが 1 日未満は停滞ではない
			{ id: 5, text: "始めたばかり", col: "doing", movedAt: NOW - 3_600_000 },
			// todo は古くても停滞ではない
			{ id: 6, text: "古い todo", col: "todo", movedAt: NOW - 30 * D },
			{ id: 7, text: "理由付きで詰まり", col: "todo", blocked: "レビュー待ち" },
			{ id: 8, text: "空の理由", col: "doing", blocked: "" },
		],
	},
	{
		slug: "other",
		cards: [{ id: 1, text: "別プロジェクトで完了", col: "done", movedAt: Date.parse("2026-08-24T00:00:00Z") }],
	},
	// カードはあるが、この週に何も無いプロジェクト
	{ slug: "quiet", cards: [{ id: 1, text: "ずっと todo", col: "todo" }] },
];
await check("weeklySummary: 見出しと範囲", () => {
	const s = mod.weeklySummary(boards(), WEEK, NOW);
	assert.equal(s.week, WEEK);
	assert.equal(s.from, Date.parse("2026-08-24T00:00:00Z"));
	assert.equal(s.to, Date.parse("2026-08-31T00:00:00Z"));
	assert.equal(s.generatedAt, NOW);
});
await check("weeklySummary: done は週内だけ、movedAt 無しは落とす", () => {
	const s = mod.weeklySummary(boards(), WEEK, NOW);
	const core = s.projects.find((p) => p.slug === "kb-core");
	assert.deepEqual(core.done, [
		{ id: 1, text: "週内に片付いた", at: Date.parse("2026-08-25T03:00:00Z") },
	]);
	// 週の両端: from は含み、to は含まない
	const edge = mod.weeklySummary(
		[
			{
				slug: "edge",
				cards: [
					{ id: 1, text: "ちょうど from", col: "done", movedAt: Date.parse("2026-08-24T00:00:00Z") },
					{ id: 2, text: "ちょうど to", col: "done", movedAt: Date.parse("2026-08-31T00:00:00Z") },
				],
			},
		],
		WEEK,
		NOW,
	);
	assert.deepEqual(edge.projects[0].done.map((c) => c.id), [1]);
});
await check("weeklySummary: stale は doing のみ・1 日以上・days 切り捨て", () => {
	const s = mod.weeklySummary(boards(), WEEK, NOW);
	const core = s.projects.find((p) => p.slug === "kb-core");
	assert.deepEqual(core.stale, [{ id: 4, text: "止まってる", days: 3 }]);
});
await check("weeklySummary: blocked は理由が非空のものだけ", () => {
	const s = mod.weeklySummary(boards(), WEEK, NOW);
	const core = s.projects.find((p) => p.slug === "kb-core");
	assert.deepEqual(core.blocked, [{ id: 7, text: "理由付きで詰まり", blocked: "レビュー待ち" }]);
});
await check("weeklySummary: プロジェクト別に分かれ、totals が合計と一致する", () => {
	const s = mod.weeklySummary(boards(), WEEK, NOW);
	assert.deepEqual(s.projects.map((p) => p.slug), ["kb-core", "other", "quiet"]);
	const sum = (k) => s.projects.reduce((n, p) => n + p[k].length, 0);
	assert.deepEqual(s.totals, { done: sum("done"), stale: sum("stale"), blocked: sum("blocked") });
	assert.deepEqual(s.totals, { done: 2, stale: 1, blocked: 0 + 1 });
});
await check("weeklySummary: 何も無いプロジェクトも空配列で出る", () => {
	const s = mod.weeklySummary(boards(), WEEK, NOW);
	const quiet = s.projects.find((p) => p.slug === "quiet");
	assert.deepEqual(quiet, { slug: "quiet", done: [], stale: [], blocked: [] });
});

// --- 5. tick の分岐（週変わり）------------------------------------------------
// サーバを起こす前にやる: 起動直後の poll が lastWeeklyAt を実時計で埋めてしまうと、
// 過去の時刻を注入した tick は開引きで弾かれる（間引きは単調増加前提）。
const { openKanbanDb } = await import("../extensions/db.ts");
const dbFile = join(HOME_DIR, ".pi/kanban", "boards.sqlite");
// meta を直接読む。weekly:lastWeek は API に出していない。
const metaOf = async (key) => {
	const db = await openKanbanDb(dbFile);
	const v = db.getMeta(key);
	db.close();
	return v;
};
const savedWeek = async (week) => {
	const raw = await metaOf("weekly:" + week);
	return raw === null ? null : JSON.parse(raw).week;
};
const doneOf = async (week) =>
	JSON.parse(await metaOf("weekly:" + week)).projects.flatMap((p) => p.done.map((c) => c.id));

// 注入する時刻は必ず過去に取る（W30/W31）。未来を注入すると lastWeeklyAt が未来に残り、
// 以降の poll の tick（now = Date.now()）が全部間引かれ、下の「poll が週変わりを観測する」が
// tick の書いた行を読むだけの空振り緑になる。
const W_OLD = "2026-W30";
const W_NEW = "2026-W31";
await check("tick: 週変わりで先週の行を残したまま今週を書く（meta 経由の 1 往復）", async () => {
	// 週末の最終 tick 以降に W30 内で動いたカードを、2 回目の tick が W30 側に拾い直すか。
	const probe = `${join(HOME_DIR, ".pi/kanban/projects")}/weekly-probe.json`;
	const done30 = (id, text) => ({ id, text, col: "done", movedAt: Date.parse("2026-07-21T03:00:00Z") });
	seedBoard(probe, { cards: [done30(1, "tick 前の done")], nextId: 2 });

	// storeWeekly を直接呼ぶと分岐のピンにならない。tick 本体の経路を通す。
	const t30 = mod.weekRange(W_OLD).from + 3_600_000; // 2026-W30 の月曜 01:00
	mod.weeklyTickThrottled(t30);
	assert.equal(await savedWeek(W_OLD), W_OLD, "W30 の行が tick で書かれない");
	assert.equal(await metaOf("weekly:lastWeek"), W_OLD, "weekly:lastWeek が W30 でない");

	// 最後の tick の後に W30 内で動いたカード（movedAt は上書きされるので、拾い直さないと消える）
	seedBoard(probe, { cards: [done30(1, "tick 前の done"), done30(2, "tick 後の done")], nextId: 3 });

	// 8 日空ければ 1 時間の間引きは必ず通る（週も W31 に変わる）
	mod.weeklyTickThrottled(t30 + 8 * D);
	assert.equal(await savedWeek(W_NEW), W_NEW, "W31 の行が書かれない");
	assert.equal(await metaOf("weekly:lastWeek"), W_NEW, "weekly:lastWeek が W31 でない");
	assert.deepEqual(await doneOf(W_OLD), [1, 2], "先週の行が tick 後の移動を拾い直していない");
});

// --- 6-9. HTTP ---------------------------------------------------------------
const handlers = new Map();
mod.default({
	registerCommand() {},
	registerTool() {},
	appendEntry() {},
	on(ev, fn) {
		handlers.set(ev, fn);
	},
	sendUserMessage() {},
});
handlers.get("session_start")(
	{},
	{
		hasUI: false,
		isIdle: () => true,
		ui: { notify() {}, setWidget() {} },
		sessionManager: { getSessionId: () => "weekly-active", getEntries: () => [] },
	},
);
for (let i = 0; i < 40; i++) {
	try {
		if ((await tf(`${BASE}/`)).ok) break;
	} catch {
		// まだ listen していない
	}
	await new Promise((r) => setTimeout(r, 100));
}

const get = async (path) => {
	const r = await tf(`${BASE}${path}`);
	return { status: r.status, body: await r.json() };
};
const q = (s) => encodeURIComponent(s);

await check("/api/weekly: current は今週をその場で計算する", async () => {
	const { status, body } = await get("/api/weekly");
	assert.equal(status, 200);
	assert.equal(body.ok, true);
	assert.equal(body.current.week, mod.isoWeek(new Date()));
	assert.ok(Array.isArray(body.current.projects), "projects が配列でない");
	assert.ok(Array.isArray(body.weeks), "weeks が配列でない");
	assert.ok(body.weeks.includes(body.current.week), "weeks に今週が入っていない");
});

await check("/api/weekly: done にすると current の完了に出る", async () => {
	const add = await get(`/api/add?scope=project&text=${q("週次に出る作業")}&col=todo`);
	assert.equal(add.status, 200);
	const made = add.body.cards.find((c) => c.text === "週次に出る作業");
	assert.ok(made, "追加したカードが応答に無い");
	const moved = await get(`/api/move?scope=project&id=${made.id}&col=done`);
	assert.equal(moved.status, 200);
	const { body } = await get("/api/weekly");
	const mine = body.current.projects.flatMap((p) => p.done).find((c) => c.text === "週次に出る作業");
	assert.ok(mine, "今週 done にしたカードが current.done に出ない");
	assert.ok(Math.abs(mine.at - Date.now()) < 60_000, "at が移動時刻でない");
});

await check("/api/weekly?week=: 保存が無ければ summary は null", async () => {
	// 計画書の例は 2026-W35 だが、テストがその週に走ると tick が保存してしまい
	// 「保存が無い週」を作れないので、確実に過去の週を使う。
	const { status, body } = await get("/api/weekly?week=2000-W01");
	assert.equal(status, 200);
	assert.equal(body.ok, true);
	assert.equal(body.summary, null);
});

await check("/api/weekly?week=: 存在しない週と壊れた値は 400", async () => {
	for (const w of ["2026-W54", "2025-W53", "2026-W00", "bogus", ""]) {
		const { status, body } = await get(`/api/weekly?week=${q(w)}`);
		assert.equal(status, 400, `${w} が 400 でない`);
		assert.deepEqual(body, { ok: false, error: "bad week" });
	}
});

await check("tick: poll が週変わりを観測して今週の行を meta に書く", async () => {
	// poll は 1.5 秒間隔。上の tick が残した lastWeeklyAt は過去（W31）なので、実時刻の tick が通る。
	// weeks には今週を計算で足しているので、選択肢ではなく保存済みの行そのものを見る。
	const cur = mod.isoWeek(new Date());
	let summary = null;
	for (let i = 0; i < 40; i++) {
		summary = (await get(`/api/weekly?week=${cur}`)).body.summary;
		if (summary) break;
		await new Promise((r) => setTimeout(r, 100));
	}
	assert.ok(summary, `${cur} の保存が tick で書かれない`);
	assert.equal(summary.week, cur);
	assert.deepEqual(summary.totals, {
		done: summary.projects.reduce((n, p) => n + p.done.length, 0),
		stale: summary.projects.reduce((n, p) => n + p.stale.length, 0),
		blocked: summary.projects.reduce((n, p) => n + p.blocked.length, 0),
	});
});

await check("/api/weekly: tick が書いた先週と今週が両方読める", async () => {
	assert.equal((await get(`/api/weekly?week=${W_OLD}`)).body.summary?.week, W_OLD, "W30 が読めない");
	assert.equal((await get(`/api/weekly?week=${W_NEW}`)).body.summary?.week, W_NEW, "W31 が読めない");
});

await check("/api/weekly: weeks は新しい順で、両方の週が入る", async () => {
	const { body } = await get("/api/weekly");
	assert.ok(body.weeks.includes(W_OLD) && body.weeks.includes(W_NEW), `両方が無い: ${body.weeks}`);
	assert.deepEqual(body.weeks, body.weeks.slice().sort().reverse(), `新しい順でない: ${body.weeks}`);
});

await check("/api/weekly: 壊れた weekly:lastWeek は weeks に出さない", async () => {
	// 選択肢に出すと、選んだ瞬間 /api/weekly?week= が 400 になるだけ。
	const db = await openKanbanDb(dbFile);
	db.setMeta("weekly:lastWeek", "bogus");
	db.close();
	const { body } = await get("/api/weekly");
	assert.ok(!body.weeks.includes("bogus"), `壊れた週が weeks に出た: ${body.weeks}`);
	assert.ok(body.weeks.every((w) => mod.weekRange(w) !== null), `壊れた週が混じる: ${body.weeks}`);
});

await check("/api/weekly: 索引から落ちた週でも weekly:lastWeek なら weeks に出す", async () => {
	// setMeta(WEEKLY_KEY+week) と setMeta(WEEKLY_INDEX) の間で落ちた状態を作る。
	// tick は 1 時間開引きなので、索引を空にした後に poll が埋め直す競合は無い。
	const db = await openKanbanDb(dbFile);
	db.setMeta("weekly:index", "[]");
	db.setMeta("weekly:lastWeek", W_OLD); // 今週ではない値でないと cur の補完と区別できない
	db.close();
	const { body } = await get("/api/weekly");
	assert.ok(body.weeks.includes(W_OLD), `lastWeek が weeks に無い: ${body.weeks}`);
});

// --- 集計 --------------------------------------------------------------------
for (const f of failures) console.error("FAIL", f);
console.log(`kanban-weekly: ${passed} passed, ${failures.length} failed`);
if (!failures.length) console.log("OK");
setTimeout(() => process.exit(failures.length ? 1 : 0), 100);
