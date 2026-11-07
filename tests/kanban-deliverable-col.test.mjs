// #67: card.col に第4列 "deliverable"（成果物）。TODO/DOING/DONE の外の独立列。
// 契約:
//   1. /api/move と /api/add は col=deliverable を受ける（parseCol が 4 値）。
//   2. counts は todo/doing/done の 3 キーのまま。deliverable は入らない。
//   3. project payload に deliverableCount（= deliverable 枚数）が増える。
//   4. projectRollup の total/done/progress/overdue は deliverable を数えない
//      （成果物は「進捗」ではなく、終わった成果）。
//   5. loop は deliverable を駆動しない: nextTodo は todo だけ、tickCardFor は doing だけ。
//   6. 他セッションの deliverable は隠さない（hiddenTodoCount は todo だけの話）。
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

const require = createRequire(import.meta.url);
const mod = require("../extensions/kanban.ts");
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

// --- 1. /api/move は deliverable を受ける ---------------------------------------
await check("#67 /api/move?col=deliverable は 200 で、col が変わる", async () => {
	const r = await move(1, "deliverable", A);
	assert.equal(r.status, 200, `status ${r.status} ${await r.text()}`);
	const b = readBoardAt(BOARD);
	assert.equal(b.cards.find((c) => c.id === 1).col, "deliverable", "board に書かれていない");
	const rep = await boardOf(null, true);
	assert.equal(rep.cards.find((c) => c.id === 1).col, "deliverable", "payload に反映されていない");
});

// --- 2. counts は 3 キーのまま（deliverable は入らない） -------------------------
await check("#67 counts は todo/doing/done の 3 キーだけ", async () => {
	const rep = await boardOf(null, true);
	assert.deepEqual(Object.keys(rep.counts).sort(), ["doing", "done", "todo"], JSON.stringify(rep.counts));
	assert.deepEqual(rep.counts, { todo: 1, doing: 0, done: 1 }, JSON.stringify(rep.counts));
});

// --- 3. deliverableCount ------------------------------------------------------
await check("#67 project payload に deliverableCount", async () => {
	const rep = await boardOf(null, true);
	assert.equal(typeof rep.deliverableCount, "number", "deliverableCount が無い");
	assert.equal(rep.deliverableCount, 2, `deliverableCount=${rep.deliverableCount}`); // #1 + #4
});

// --- 4. stats / progress は deliverable を数えない ------------------------------
await check("#67 /api/dashboard の stats は deliverable を足さない", async () => {
	const r = await tf(`${BASE}/api/dashboard`);
	assert.equal(r.status, 200, `status ${r.status}`);
	const d = await r.json();
	const cards = d.global.cards;
	assert.equal(cards.filter((c) => c.col === "deliverable").length, 2, "global.cards に deliverable が居ない");
	assert.equal(
		d.stats.todo + d.stats.doing + d.stats.done,
		cards.filter((c) => c.col !== "deliverable").length,
		"stats の合計に deliverable が混ざった",
	);
});

await check("#67 projectRollup: total/done/progress は deliverable を数えない", () => {
	const at = (id, col) => ({ scope: "project", sid: "kb", card: { id, text: `t${id}`, col } });
	const rows = mod.projectRollup(
		[],
		[],
		[at(1, "done"), at(2, "todo"), at(3, "deliverable"), at(4, "deliverable")],
		"2026-01-01",
	);
	const p = rows.find((r) => r.slug === "kb");
	assert.equal(p.total, 2, `total=${p.total}`);
	assert.equal(p.done, 1, `done=${p.done}`);
	assert.equal(p.progress, 50, `progress=${p.progress}`);
	assert.equal(p.counts.done, 1);
});

await check("#67 projectRollup: 期限超過に deliverable は入らない", () => {
	const at = (id, col) => ({
		scope: "project",
		sid: "kb",
		card: { id, text: `t${id}`, col, due: "2025-01-01" },
	});
	const p = mod.projectRollup([], [], [at(1, "todo"), at(2, "deliverable")], "2026-01-01").find((r) => r.slug === "kb");
	assert.equal(p.overdue, 1, `overdue=${p.overdue}`);
});

// --- 5. loop は deliverable を駆動しない ---------------------------------------
await check("#67 nextTodo は deliverable を拾わない", () => {
	const cards = [
		{ id: 1, text: "成果物", col: "deliverable", priority: 99 },
		{ id: 2, text: "todo", col: "todo" },
	];
	assert.equal(mod.nextTodo(cards, "project", A)?.id, 2);
	assert.equal(mod.nextTodo([{ id: 1, text: "成果物", col: "deliverable" }], "project", A), undefined);
});

await check("#67 tickCardFor（doingLoop の駆動元）は deliverable を拾わない", () => {
	assert.equal(mod.tickCardFor([{ id: 1, text: "成果物", col: "deliverable", movedBy: A }], A), undefined);
});

// --- 6. 他セッションの deliverable は隠さない ----------------------------------
await check("#67 hiddenTodoCount は deliverable を隠さない", async () => {
	seed();
	const rep = await boardOf(A, false);
	assert.equal(rep.hiddenTodoCount, 1, "隠れたのは B の TODO 1 枚だけのはず");
	assert.equal(rep.cards.filter((c) => c.col === "deliverable").length, 1, "他セッションの成果物が消えた");
});

// --- 7. /api/add も deliverable を受ける ---------------------------------------
await check("#67 /api/add?col=deliverable は 200 で deliverable に置かれる", async () => {
	seed();
	const q = new URLSearchParams({ p: SLUG, col: "deliverable", text: "新しい成果物", sid: A });
	const r = await tf(`${BASE}/api/add?${q}`);
	assert.equal(r.status, 200, `status ${r.status} ${await r.text()}`);
	const b = readBoardAt(BOARD);
	assert.equal(b.cards.find((c) => c.text === "新しい成果物").col, "deliverable");
});

// --- 8. UI 構造（ブラウザ実機は #057 の担当。ここは配線だけ） --------------------
const read = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

await check("#67 _app.js の board は 4 列（deliverable を含む）", () => {
	const app = read("web/dash/_app.js");
	assert.match(app, /\["todo", "doing", "done", "deliverable"\]\.forEach/, "4 列の forEach が無い");
	assert.ok(app.includes('el("h2", null, "成果物")') || app.includes('col === "deliverable"'), "成果物ヘッドが無い");
});

await check("#67 _b.css の .cols は 4 列、狭い時は 1 列", () => {
	const css = read("web/dash/_b.css");
	assert.match(css, /\.cols\{display:grid; grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/, "4 列グリッドが無い");
	assert.match(css, /@media \(max-width:[\d]+px\)\{ ?\.cols\{grid-template-columns:1fr\}/, "1 列フォールバックが無い");
});

if (failures.length > 0) {
	console.error(`FAIL ${failures.length} / ${passed + failures.length}`);
	for (const f of failures) console.error(`  - ${f}`);
}
if (!failures.length) console.log(`ok ${passed} checks (kanban-deliverable-col)`);
setTimeout(() => process.exit(failures.length ? 1 : 0), 100);
