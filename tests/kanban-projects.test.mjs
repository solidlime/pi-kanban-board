// フェーズ2: プロジェクト API (#7)。
// フレームワーク無しで `node tests/kanban-projects.test.mjs`。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { authFetch } from "./helpers/token.mjs";
import { seedBoard, useKanban } from "./helpers/board.mjs";

const tf = (input, init) => authFetch(input, init);

const HOME_DIR = tmpdir() + "/kb-projects-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${join(HOME_DIR, ".pi/kanban/sessions")}`, { recursive: true });
process.env.HOME = HOME_DIR;
// Windows: os.homedir() prefers USERPROFILE over HOME.
process.env.USERPROFILE = process.env.HOME;
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

// --- 1. 集計の純関数 ---------------------------------------------------------
await check("projectRollup: カードだけが真実で進捗を導出する", () => {
	// ボード（scope project + sid）がプロジェクトの実体。card.project はカード単位のタグで、
	// それを集計に使うとボードの無い幽霊プロジェクトが並ぶ。
	const cards = [
		{ scope: "project", sid: "kb-core", card: { id: 1, text: "done 済み", col: "done", due: "2026-01-01", estimate: 3 } },
		{ scope: "project", sid: "kb-core", card: { id: 2, text: "作業中", col: "doing", due: "2999-01-01", estimate: 2, blocked: "レビュー待ち" } },
		{ scope: "project", sid: "ghost", card: { id: 3, text: "未宣言のボード", col: "todo" } },
		// タグだけのカードは集計に入らない（"" と同じで、ボードの無いプロジェクトを作らない）。
		{ scope: "session", sid: "s1", card: { id: 4, text: "タグだけ", col: "todo", project: "tag-only" } },
		// GLOBAL の残骸（scope global）もボードではない。
		{ scope: "global", sid: "", card: { id: 5, text: "GLOBAL の残骸", col: "todo", project: "tag-only" } },
	];
	const decisions = [
		{ id: 1, slug: "kb-core", at: 1, text: "SQLite を採用" },
		{ id: 2, slug: "", at: 2, text: "横断の決定" },
	];
	const out = mod.projectRollup([{ slug: "kb-core", name: "kanban core" }], decisions, cards, "2026-06-01");
	assert.deepEqual(out.map((p) => p.slug), ["ghost", "kb-core"], "宣言済みもボードだけの slug も並ぶ");
	const core = out[1];
	assert.equal(core.name, "kanban core");
	assert.equal(core.declared, true);
	assert.deepEqual(core.counts, { todo: 0, doing: 1, done: 1 });
	assert.equal(core.total, 2);
	assert.equal(core.done, 1);
	assert.deepEqual(core.points, { total: 5, done: 3 });
	assert.equal(core.progress, 50);
	assert.equal(core.overdue, 0);
	assert.deepEqual(core.milestones.map((m) => m.id), [1, 2], "期限の早い順");
	assert.deepEqual(core.blockers.map((b) => b.blocked), ["レビュー待ち"]);
	assert.deepEqual(core.decisions.map((d) => d.text), ["SQLite を採用"], "横断の決定は混ざらない");
	const ghost = out[0];
	assert.equal(ghost.declared, false);
	assert.equal(ghost.name, "ghost", "名前が無ければ slug が名前");
	assert.equal(ghost.progress, 0);
	assert.deepEqual(ghost.points, { total: 0, done: 0 }, "見積なしは 0 ポイント");
});

await check("projectRollup: 期限切れは done を数えない", () => {
	const cards = [
		{ scope: "project", sid: "p", card: { id: 1, text: "遅れ", col: "todo", due: "2026-01-01" } },
		{ scope: "project", sid: "p", card: { id: 2, text: "片付いた", col: "done", due: "2026-01-01" } },
	];
	const out = mod.projectRollup([], [], cards, "2026-06-01");
	assert.equal(out[0].overdue, 1);
	assert.equal(mod.projectRollup([], [], cards, "2025-12-31")[0].overdue, 0, "期限当日より前は遅れていない");
});

// --- 2. HTTP ----------------------------------------------------------------
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
const ACTIVE = "proj-active";
handlers.get("session_start")(
	{},
	{
		hasUI: false,
		isIdle: () => true,
		ui: { notify() {}, setWidget() {} },
		sessionManager: { getSessionId: () => ACTIVE, getEntries: () => [] },
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

const q = (s) => encodeURIComponent(s);
const add = async (params) => {
	const r = await tf(`${BASE}/api/add?scope=project&${params}`);
	return { status: r.status, body: await r.json() };
};
const get = async (path) => {
	const r = await tf(`${BASE}${path}`);
	return { status: r.status, body: await r.json() };
};
const projectOf = (body, slug) => body.projects.find((p) => p.slug === slug);

await check("/api/projects: ボードのカードからプロジェクトを集計する", async () => {
	// ?p= で書いた先のボードがプロジェクトになる（cwd のボードではなく）。
	const a = await add(`text=${q("集計される作業")}&col=todo&p=kb-core&due=2999-01-01&estimate=3`);
	assert.equal(a.status, 200);
	const { status, body } = await get("/api/projects");
	assert.equal(status, 200);
	assert.equal(body.ok, true);
	const p = projectOf(body, "kb-core");
	assert.ok(p, "ボード名が一覧に出る");
	assert.equal(p.declared, false);
	assert.equal(p.total, 1);
	assert.equal(p.points.total, 3);
	assert.deepEqual(p.milestones.map((m) => m.due), ["2999-01-01"]);
});

await check("/api/project: 名前を付けると一覧の名前が変わる", async () => {
	const r = await get(`/api/project?project=kb-core&name=${q("カンバン本体")}`);
	assert.equal(r.status, 200);
	assert.equal(r.body.created, true);
	assert.equal((await get("/api/project?project=kb-core&name=" + q("別名"))).body.created, false, "2回目は新規ではない");
	assert.equal(projectOf((await get("/api/projects")).body, "kb-core").name, "別名", "改名できる");
	await get("/api/project?project=kb-core&name=" + q("カンバン本体"));
	const p = projectOf((await get("/api/projects")).body, "kb-core");
	assert.equal(p.name, "カンバン本体");
	assert.equal(p.declared, true);
});

await check("/api/project: 名前を省くと slug が名前になる", async () => {
	await get("/api/project?project=bare");
	const p = projectOf((await get("/api/projects")).body, "bare");
	assert.equal(p.name, "bare");
});

await check("/api/project: 空 slug は 400、不正文字は /api/add と同じ規則で落とす", async () => {
	assert.equal((await get("/api/project?project=")).status, 400);
	// カードと同じ規則で、不正文字は落として slug にする（/api/add と一つのルール）。大小は保つ。
	assert.equal((await get(`/api/project?project=${q("My Proj!")}`)).status, 200);
	assert.equal(projectOf((await get("/api/projects")).body, "MyProj").name, "MyProj");
});

await check("/api/decision: 決定を足すとプロジェクトに載る", async () => {
	const r = await get(`/api/decision?project=kb-core&text=${q("SQLite を採用")}&why=${q("単一ファイルで済む")}`);
	assert.equal(r.status, 200);
	assert.equal(r.body.decision.slug, "kb-core");
	assert.equal(r.body.decision.why, "単一ファイルで済む");
	const p = projectOf((await get("/api/projects")).body, "kb-core");
	assert.deepEqual(p.decisions.map((d) => d.text), ["SQLite を採用"]);
});

await check("/api/decision: why 省略でキーが生えない", async () => {
	const r = await get(`/api/decision?project=kb-core&text=${q("why なし")}`);
	assert.ok(!("why" in r.body.decision), "why が undefined で生えた");
});

await check("/api/decision: カードが無い slug でも一覧に出る（書けたのに読めない、を防ぐ）", async () => {
	assert.equal((await get("/api/decision?project=orphan&text=" + q("まだカードが無い決定"))).status, 200);
	const p = projectOf((await get("/api/projects")).body, "orphan");
	assert.ok(p, "決定を書いた slug がプロジェクト一覧に出ない");
	assert.equal(p.total, 0);
	assert.deepEqual(p.decisions.map((d) => d.text), ["まだカードが無い決定"]);
});

await check("/api/decision: 未知の action は 400（追記に落ちない）", async () => {
	assert.equal((await get("/api/decision?action=foo&text=" + q("入ってはいけない"))).status, 400);
	const p = projectOf((await get("/api/projects")).body, "kb-core");
	assert.ok(!p.decisions.some((d) => d.text === "入ってはいけない"), "400 のはずが追記された");
});

await check("/api/decision: text 無しは 400", async () => {
	assert.equal((await get("/api/decision?project=kb-core")).status, 400);
	assert.equal((await get("/api/decision?text=")).status, 400);
});

await check("/api/decision: プロジェクト無しは横断ログに入る", async () => {
	const r = await get(`/api/decision?text=${q("全体の決定")}`);
	assert.equal(r.status, 200);
	assert.equal(r.body.decision.slug, "");
	const body = (await get("/api/projects")).body;
	assert.deepEqual(body.decisions.map((d) => d.text), ["全体の決定"], "トップレベルの decisions にだけ出る");
	const everyProject = body.projects.flatMap((p) => p.decisions.map((d) => d.text));
	assert.ok(!everyProject.includes("全体の決定"), "プロジェクト個別の決定に混ざった");
});

await check("/api/decision: 消せる。不正な id は 400", async () => {
	const made = await get(`/api/decision?project=kb-core&text=${q("消す決定")}`);
	assert.equal((await get(`/api/decision?action=delete&id=${made.body.decision.id}`)).body.deleted, true);
	assert.equal((await get(`/api/decision?action=delete&id=${made.body.decision.id}`)).body.deleted, false);
	assert.equal((await get("/api/decision?action=delete&id=abc")).status, 400);
	assert.equal((await get("/api/decision?action=delete&id=0")).status, 400);
	assert.equal((await get("/api/decision?action=delete")).status, 400, "id 無しは 400");
});

await check("/api/projects: 別ボードのカードも集計する（cwd のボードに混ぜない）", async () => {
	const r = await tf(`${BASE}/api/add?scope=project&p=kb-core&text=${q("全体の作業")}`);
	assert.equal(r.status, 200);
	const board = (await get("/api/kanban?p=kb-core")).body.project.cards;
	assert.ok(board.some((c) => c.text === "全体の作業"), "ボードに載っていない");
	const p = projectOf((await get("/api/projects")).body, "kb-core");
	assert.equal(p.total, 2);
	assert.equal(p.counts.todo, 2);
});

await check("/api/projects: 完了させると進捗が動く", async () => {
	const body = (await get("/api/kanban?p=kb-core")).body.project;
	const moved = body.cards.find((c) => c.col === "todo");
	const r = await tf(`${BASE}/api/move?scope=project&p=kb-core&id=${moved.id}&col=done`);
	assert.equal(r.status, 200);
	assert.equal((await get("/api/projects")).status, 200);
	const p = projectOf((await get("/api/projects")).body, "kb-core");
	assert.equal(p.done, 1);
	assert.equal(p.progress, 50);
});

// #25: 供給が自 cwd の 1 枚だけだと、他リポのボードのカードが黙って欠ける（件数だけ 0 に見える）。
// ボード基準になったので、他リポのボードはそのディレクトリ名で一覧に出る（タグは見ない）。
await check("/api/projects: 他リポのボードのカードも数える（自 cwd だけ数えない）", async () => {
	seedBoard(HOME_DIR + "/.pi/kanban/projects/other-repo.json", {
		cards: [{ id: 1, text: "他リポの作業", col: "done", project: "other-proj", estimate: 2 }],
		nextId: 2,
	});
	const body = (await get("/api/projects")).body;
	const p = projectOf(body, "other-repo");
	assert.ok(p, "他リポのボードが一覧に出ない");
	assert.equal(projectOf(body, "other-proj"), undefined, "カードのタグがプロジェクトを作った");
	assert.equal(p.total, 1);
	assert.equal(p.done, 1);
	assert.equal(p.points.done, 2, "見積もりが他ボードから来ていない");
	// 差し替えで自 cwd のボードを消し飛ばしていないこと
	assert.equal(projectOf(body, "kb-core").total, 2);
});

// --- 3. 集計 -----------------------------------------------------------------
for (const f of failures) console.error("FAIL", f);
console.log(`kanban-projects: ${passed} passed, ${failures.length} failed`);
if (!failures.length) console.log("OK");
setTimeout(() => process.exit(failures.length ? 1 : 0), 100);
