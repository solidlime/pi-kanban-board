// #82: 成果物は card.col ではなく deliv テーブル。ここは「列ではなくなった」ことの契約:
//   1. /api/move の col=deliverable は 400（deliverable is not a phase）。旧行の退出は通る。
//   2. counts は todo/doing/done の 3 キーのまま。旧 col=deliverable 行は入らない。
//   3. project payload の deliverableCount は deliv の件数（= deliverables.length）。
//   4. projectRollup は旧 col 行も 1 枚のカードとして数える（除外はもう無い）。
//   5. loop は deliverable を駆動しない: nextTodo は todo だけ、tickCardFor は doing だけ。
//   6. 他セッションの旧 deliverable 行は隠さない（hiddenTodoCount は todo だけの話）。
// フレームワーク無しで `node tests/kanban-deliverable-col.test.mjs`。
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { authFetch } from "./helpers/token.mjs";
import { readBoardAt, seedBoard, useKanban } from "./helpers/board.mjs";

const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-deliv-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
mkdirSync(`${HOME_DIR}/workspace`, { recursive: true });
process.env.HOME = HOME_DIR;
process.env.USERPROFILE = HOME_DIR; // Windows: os.homedir() reads this
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

const mod = createRequire(import.meta.url)("../extensions/kanban.ts");
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

const pi = {
	registerCommand() {},
	registerTool() {},
	appendEntry() {},
	on() {},
	sendUserMessage() {},
};
mod.default(pi);
for (let i = 0; i < 40; i++) {
	try {
		if ((await tf(`${BASE}/`)).ok) break;
	} catch {
		// まだ listen していない
	}
	await new Promise((r) => setTimeout(r, 100));
}

const SLUG = mod.projectSlugOf(process.cwd());
const BOARD = `${HOME_DIR}/.pi/kanban/projects/${SLUG}.json`;
const A = "sid-session-a";
const B = "sid-session-b";

// 4 枚: A の TODO / B の TODO / A の DONE / B の deliverable（他セッションの成果物）。
const seed = () =>
	seedBoard(BOARD, {
		nextId: 5,
		delivNextId: 1,
		deliverables: [],
		cards: [
			{ id: 1, text: "A の todo", col: "todo", movedBy: A, movedAt: 1 },
			{ id: 2, text: "B の todo", col: "todo", movedBy: B, movedAt: 1 },
			{ id: 3, text: "A の done", col: "done", movedBy: A, movedAt: 1 },
			{ id: 4, text: "B の成果物", col: "deliverable", movedBy: B, movedAt: 1 },
		],
	});
seed();

const boardOf = async (sid, showOthers) => {
	const q = new URLSearchParams({ p: SLUG });
	if (sid !== null) q.set("sid", sid);
	if (showOthers) q.set("showOthers", "1");
	const r = await tf(`${BASE}/api/kanban?${q}`);
	assert.equal(r.status, 200, `status ${r.status}`);
	return (await r.json()).project;
};
const move = async (id, col, sid) => {
	const q = new URLSearchParams({ p: SLUG, id: String(id), col });
	if (sid) q.set("sid", sid);
	return tf(`${BASE}/api/move?${q}`);
};

// --- 1. /api/move は deliverable を受けない -------------------------------------
await check("#82 /api/move?col=deliverable は 400 で、col は変わらない", async () => {
	const r = await move(1, "deliverable", A);
	assert.equal(r.status, 400, `status ${r.status}`);
	assert.deepEqual(await r.json(), { ok: false, error: "deliverable is not a phase" });
	const b = readBoardAt(BOARD);
	assert.equal(b.cards.find((c) => c.id === 1).col, "todo", "board が書き換わった");
});

await check("#82 旧 col=deliverable 行は done へ退出できる", async () => {
	const r = await move(4, "done", B);
	assert.equal(r.status, 200, `status ${r.status}`);
	assert.equal(readBoardAt(BOARD).cards.find((c) => c.id === 4).col, "done");
	seed(); // 次のチェックのために戻す
});

// --- 2. counts は 3 キーのまま（deliverable は入らない） -------------------------
await check("#67 counts は todo/doing/done の 3 キーだけ", async () => {
	const rep = await boardOf(null, true);
	assert.deepEqual(Object.keys(rep.counts).sort(), ["doing", "done", "todo"], JSON.stringify(rep.counts));
	assert.deepEqual(rep.counts, { todo: 2, doing: 0, done: 1 }, JSON.stringify(rep.counts));
});

// --- 3. deliverableCount は deliv の件数 ---------------------------------------
await check("#82 project payload の deliverableCount は deliv の件数", async () => {
	const rep = await boardOf(null, true);
	assert.equal(typeof rep.deliverableCount, "number", "deliverableCount が無い");
	assert.equal(rep.deliverableCount, 0, `deliverableCount=${rep.deliverableCount}`); // 旧 col 行は数えない
	const add = await tf(`${BASE}/api/deliv/add?${new URLSearchParams({ p: SLUG, text: "成果物 1" })}`);
	assert.equal(add.status, 200, `add: status ${add.status}`);
	const rep2 = await boardOf(null, true);
	assert.equal(rep2.deliverableCount, 1, `deliverableCount=${rep2.deliverableCount}`);
	assert.equal(rep2.deliverables.length, 1);
});

// --- 4. stats / progress は deliverable を数えない ------------------------------
await check("#82 /api/dashboard の stats はカードだけ、成果物は global.deliverables", async () => {
	const r = await tf(`${BASE}/api/dashboard`);
	assert.equal(r.status, 200, `status ${r.status}`);
	const d = await r.json();
	const cards = d.global.cards;
	// 旧 col=deliverable 行も 1 枚のカードとして残る（read は壊さない）。stats はその合計。
	assert.equal(cards.filter((c) => c.col === "deliverable").length, 1, "旧行が global.cards から消えた");
	// 旧 col=deliverable 行は 3 つの列のどれでもないので counts に入らない（新規には作れない）。
	assert.equal(
		d.stats.todo + d.stats.doing + d.stats.done,
		cards.filter((c) => c.col !== "deliverable").length,
		"stats の合計がカード数と合わない",
	);
	assert.equal(d.global.deliverables.length, 1, "global.deliverables が deliv 行を返していない");
	assert.equal(d.global.deliverables[0].sid, SLUG, "sid が付いていない");
});

await check("#82 projectRollup は旧 col 行も 1 枚として数える（除外しない）", () => {
	const at = (id, col) => ({ scope: "project", sid: "kb", card: { id, text: `t${id}`, col } });
	const rows = mod.projectRollup(
		[],
		[],
		[at(1, "done"), at(2, "todo"), at(3, "deliverable"), at(4, "deliverable")],
		"2026-01-01",
	);
	const p = rows.find((r) => r.slug === "kb");
	assert.equal(p.total, 4, `total=${p.total}`);
	assert.equal(p.done, 1, `done=${p.done}`);
	assert.equal(p.progress, 25, `progress=${p.progress}`);
	assert.equal(p.counts.done, 1);
});

await check("#82 projectRollup: 期限超過も旧 col 行を含めて数える", () => {
	const at = (id, col) => ({
		scope: "project",
		sid: "kb",
		card: { id, text: `t${id}`, col, due: "2025-01-01" },
	});
	const p = mod.projectRollup([], [], [at(1, "todo"), at(2, "deliverable")], "2026-01-01").find((r) => r.slug === "kb");
	assert.equal(p.overdue, 2, `overdue=${p.overdue}`);
});

// --- 5. loop は deliverable を駆動しない ---------------------------------------
await check("#82 nextTodo は deliverable を拾わない", () => {
	const cards = [
		{ id: 1, text: "成果物", col: "deliverable", priority: 99 },
		{ id: 2, text: "todo", col: "todo" },
	];
	assert.equal(mod.nextTodo(cards, "project", A)?.id, 2);
	assert.equal(mod.nextTodo([{ id: 1, text: "成果物", col: "deliverable" }], "project", A), undefined);
});

await check("#82 tickCardFor（doingLoop の駆動元）は deliverable を拾わない", () => {
	assert.equal(mod.tickCardFor([{ id: 1, text: "成果物", col: "deliverable", movedBy: A }], A), undefined);
});

// --- 6. 他セッションの deliverable は隠さない ----------------------------------
await check("#82 hiddenTodoCount は旧 deliverable 行を隠さない", async () => {
	seed();
	const rep = await boardOf(A, false);
	assert.equal(rep.hiddenTodoCount, 1, "隠れたのは B の TODO 1 枚だけのはず");
	assert.equal(rep.cards.filter((c) => c.col === "deliverable").length, 1, "他セッションの旧行が消えた");
});

// --- 7. /api/add はもう deliverable を作れない ----------------------------------
await check("#82 /api/add?col=deliverable は新規の旧形式行を作らない（todo に落ちる）", async () => {
	seed();
	const q = new URLSearchParams({ p: SLUG, col: "deliverable", text: "新しい成果物", sid: A });
	const r = await tf(`${BASE}/api/add?${q}`);
	assert.equal(r.status, 200, `status ${r.status}`);
	const b = readBoardAt(BOARD);
	assert.equal(b.cards.find((c) => c.text === "新しい成果物").col, "todo", "parseCol が deliverable を通した");
	assert.equal(b.cards.filter((c) => c.col === "deliverable").length, 1, "旧形式の行が増えた");
});

// --- 8. UI 構造（ブラウザ実機は #057 の担当。ここは配線だけ） --------------------
const read = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

await check("#67/#79 _app.js の board は 3 列（deliverable は列ではない）", () => {
	const app = read("web/dash/_app.js");
	assert.match(app, /\["todo", "doing", "done"\]\.forEach/, "3 列の forEach が無い");
	assert.ok(!app.includes('["todo", "doing", "done", "deliverable"].forEach'), "#79: 4 列目は撤去");
	assert.ok(!app.includes('function colName(col) { return col === "deliverable"'), "colName に成果物の分岐が残っている");
	const board3 = app.slice(app.indexOf("function renderBoard()"), app.indexOf("function cardEl("));
	assert.ok(!board3.includes("deliverable"), "renderBoard に成果物の列分岐が残っている");
});

await check("#67/#79 _b.css の .cols は 3 列、狭い時は 1 列", () => {
	const css = read("web/dash/_b.css");
	assert.match(css, /\.cols\{display:grid; grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/, "3 列グリッドが無い");
	assert.match(css, /@media \(max-width:[\d]+px\)\{ ?\.cols\{grid-template-columns:1fr\}/, "1 列フォールバックが無い");
});

await check("#77/#78/#79 UI の配線（ブラウザ実機は #057 の担当）", () => {
	const app = read("web/dash/_app.js");
	const head = read("web/dash/_head.html");
	assert.ok(app.includes('"del-nobody"'), "#79: 添付なしの成果物が帯に出ない");
	assert.ok(app.includes("p.innerHTML === d.innerHTML"), "#78: 列ノードの再利用が無い");
	assert.ok(app.includes('e.key === "Escape" && $("#cm").hasAttribute("open")'), "#77: Esc でモーダルが閉じない");
	assert.ok(app.includes('t.closest(".del-cap")'), "#79: 帯タイルからモーダルを開けない");
	assert.ok(head.includes('id="deladd"'), "#79: 帯に + が無い");
	assert.ok(!head.includes('data-move="deliverable"'), "#82: カードモーダルに成果物への移動ボタンが残っている");
});

if (failures.length > 0) {
	console.error(`FAIL ${failures.length} / ${passed + failures.length}`);
	for (const f of failures) console.error(`  - ${f}`);
}
if (!failures.length) console.log(`ok ${passed} checks (kanban-deliverable-col)`);
setTimeout(() => process.exit(failures.length ? 1 : 0), 100);
