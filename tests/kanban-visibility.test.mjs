// #52: 他セッションの TODO は既定で見せない（コンテキスト汚染防止）+ 明示的な取りに行き口。
// 契約:
//   1. /api/kanban は viewer(自分の sid) から見て他セッションの TODO を cards から外し、
//      hiddenTodoCount に枚数を出す。showOthers=1 で全部返す（hiddenTodoCount は据え置き）。
//   2. movedBy 未設定の TODO は「無主」= 誰にでも見える（初回投入のカード）。
//   3. sid の無い呼び出し（curl / ドライバ未開始）は全 TODO を見せる = 後方互換。
//   4. nextTodo（= autoPick / poll の wake 元）は無主と自分の TODO だけを拾う。
// フレームワーク無しで `node tests/kanban-visibility.test.mjs`。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { authFetch } from "./helpers/token.mjs";
import { readBoardAt, seedBoard, useKanban } from "./helpers/board.mjs";

const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-visibility-home";
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

const { createJiti } = createRequire(import.meta.url)(
	process.env.KANBAN_JITI ?? createRequire(import.meta.url).resolve("jiti"),
);
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(
	process.env.KANBAN_TS ?? fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url)),
);
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

// 4 枚: A の TODO / B の TODO / 無主の TODO / A の DOING。
const seed = () =>
	seedBoard(BOARD, {
		nextId: 5,
		cards: [
			{ id: 1, text: "A の todo", col: "todo", movedBy: A, movedAt: 1 },
			{ id: 2, text: "B の todo", col: "todo", movedBy: B, movedAt: 1 },
			{ id: 3, text: "無主の todo", col: "todo" },
			{ id: 4, text: "A の doing", col: "doing", movedBy: A, movedAt: 1 },
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
const ids = (rep) => rep.cards.map((c) => c.id);
const todoIds = (rep) => rep.cards.filter((c) => c.col === "todo").map((c) => c.id);

// --- 1. hiddenTodoCount: B から見ると A の TODO だけが隠れる ----------------------
await check("B の /api/kanban: A の TODO は cards に無い / hiddenTodoCount=1", async () => {
	const rep = await boardOf(B, false);
	assert.deepEqual(todoIds(rep).sort(), [2, 3], `TODO が ${JSON.stringify(todoIds(rep))}`);
	assert.equal(rep.hiddenTodoCount, 1, "hiddenTodoCount");
	// DOING は従来どおり全員に見える（掴んでいる人の表示だけが増える）。
	assert.deepEqual(ids(rep).sort(), [2, 3, 4], `cards ${JSON.stringify(ids(rep))}`);
});

await check("A の /api/kanban: B の TODO が隠れ、自分と無主は見える", async () => {
	const rep = await boardOf(A, false);
	assert.deepEqual(todoIds(rep).sort(), [1, 3]);
	assert.equal(rep.hiddenTodoCount, 1);
});

await check("showOthers=1: 隠していた TODO が cards に戻る（hiddenTodoCount は据え置き）", async () => {
	const rep = await boardOf(B, true);
	assert.deepEqual(todoIds(rep).sort(), [1, 2, 3], `TODO が ${JSON.stringify(todoIds(rep))}`);
	assert.equal(rep.hiddenTodoCount, 1, "バッジの数字が消えた");
	assert.deepEqual(ids(rep).sort(), [1, 2, 3, 4]);
});

await check("sid 無し（curl / ドライバ未開始）: 全 TODO + hiddenTodoCount=0 = 後方互換", async () => {
	const rep = await boardOf(null, false);
	assert.deepEqual(todoIds(rep).sort(), [1, 2, 3]);
	assert.equal(rep.hiddenTodoCount, 0);
});

await check("counts は従来どおりボード全体（隠しても数字は減らない）", async () => {
	const rep = await boardOf(B, false);
	assert.deepEqual(rep.counts, { todo: 3, doing: 1, done: 0 }, JSON.stringify(rep.counts));
});

await check("viewer 自身のカードにだけ mine が立つ（DOING の 👤 あなた 用）", async () => {
	const rep = await boardOf(A, true);
	const byId = new Map(rep.cards.map((c) => [c.id, c]));
	assert.equal(byId.get(1).mine, true, "A の TODO に mine が無い");
	assert.equal(byId.get(4).mine, true, "A の DOING に mine が無い");
	assert.ok(!("mine" in byId.get(2)), "B のカードに mine が立った");
	assert.ok(!("mine" in byId.get(3)), "無主のカードに mine が立った");
});

// --- 2. nextTodo は無主（と自分）だけを拾う --------------------------------------
const T = (id, extra) => ({ id, text: `t${id}`, col: "todo", ...extra });

await check("nextTodo: 他セッションの TODO は拾わない（priority が高くても）", () => {
	const cards = [T(1, { movedBy: B, priority: 99 }), T(2)];
	const got = mod.nextTodo(cards, "project", A);
	assert.equal(got?.id, 2, `拾ったのは #${got?.id}`);
});

await check("nextTodo: 無主 TODO の中では priority 降順 → id 昇順", () => {
	const cards = [T(1), T(2, { priority: 5 }), T(3, { priority: 5 })];
	assert.equal(mod.nextTodo(cards, "project", A)?.id, 2);
});

await check("nextTodo: 自分の TODO は拾う（movedBy === sid）", () => {
	const cards = [T(1, { movedBy: A, priority: 1 }), T(2, { movedBy: B, priority: 9 })];
	assert.equal(mod.nextTodo(cards, "project", A)?.id, 1);
});

await check("nextTodo: sid が空なら全 TODO が対象（後方互換）", () => {
	const cards = [T(1, { movedBy: A, priority: 3 }), T(2, { movedBy: B, priority: 9 })];
	assert.equal(mod.nextTodo(cards, "project", "")?.id, 2);
});

await check("nextTodo: 他セッションの TODO しか無ければ undefined（空ピック）", () => {
	assert.equal(mod.nextTodo([T(1, { movedBy: B })], "project", A), undefined);
});

await check("todoMineOrUnowned: 無主 / 自分 / 他人 / 空 sid", () => {
	assert.equal(mod.todoMineOrUnowned({ id: 1, text: "", col: "todo" }, A), true);
	assert.equal(mod.todoMineOrUnowned({ id: 1, text: "", col: "todo", movedBy: A }, A), true);
	assert.equal(mod.todoMineOrUnowned({ id: 1, text: "", col: "todo", movedBy: B }, A), false);
	assert.equal(mod.todoMineOrUnowned({ id: 1, text: "", col: "todo", movedBy: B }, ""), true);
});

// --- 3. pickFirstTodo も同じ規則（poll の wake 元 / settle の pick） --------------
const started = mod.default(pi);
await check("pickFirstTodo: 他セッションの TODO を掴まない / 無主を掴む", () => {
	seedBoard(BOARD, {
		nextId: 3,
		cards: [T(1, { movedBy: B, priority: 50 }), T(2)],
	});
	const picked = mod.pickFirstTodo(SLUG, "project", A);
	assert.equal(picked?.id, 2, `掴んだのは #${picked?.id}`);
	// 無主の #2 は A のものになり、#1 は B のまま。
	const after = readBoardAt(BOARD);
	assert.equal(after.cards.find((c) => c.id === 1).movedBy, B, "B の TODO が奪われた");
	assert.equal(after.cards.find((c) => c.id === 2).col, "doing");
	assert.equal(after.cards.find((c) => c.id === 2).movedBy, A);
});

await check("pickFirstTodo: 他セッションの TODO しか無ければ何も動かさない", () => {
	seedBoard(BOARD, { nextId: 2, cards: [T(1, { movedBy: B })] });
	assert.equal(mod.pickFirstTodo(SLUG, "project", A), null);
	assert.equal(readBoardAt(BOARD).cards[0].col, "todo", "掴めないはずのカードが動いた");
});

void started;

// --- 結果 -----------------------------------------------------------------------
if (failures.length > 0) {
	console.error(`FAIL ${failures.length} / ${passed + failures.length}`);
	for (const f of failures) console.error(`  - ${f}`);
}
if (!failures.length) console.log(`ok ${passed} checks (kanban-visibility)`);
setTimeout(() => process.exit(failures.length ? 1 : 0), 100);
