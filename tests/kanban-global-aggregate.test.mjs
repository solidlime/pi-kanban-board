// #16 global は全 project ボードの読み取り専用の合成ビュー。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { authFetch } from "./helpers/token.mjs";
import { useKanban, seedBoard, removeBoard } from "./helpers/board.mjs";

const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-global-agg-home";
rmSync(HOME_DIR, { recursive: true, force: true });
const KB = `${HOME_DIR}/.pi/kanban`;
mkdirSync(`${KB}/sessions`, { recursive: true });
mkdirSync(`${KB}/media`, { recursive: true });
mkdirSync(`${KB}/projects`, { recursive: true });
process.env.HOME = HOME_DIR;
// Windows: os.homedir() prefers USERPROFILE over HOME, so keep them in step.
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
const PORT = process.env.KANBAN_PORT;
const BASE = `http://127.0.0.1:${PORT}`;

const require = createRequire(import.meta.url);
const { createJiti } = require(
	process.env.KANBAN_JITI ?? createRequire(import.meta.url).resolve("jiti"),
);
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url)));
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

const tools = {};
const pi = {
	registerCommand() {},
	registerTool(def) {
		tools[def.name] = def;
	},
	appendEntry() {},
	on() {},
	sendUserMessage() {},
};
mod.default(pi);
for (let i = 0; i < 40; i++) {
	try {
		if ((await tf(`${BASE}/api/kanban`)).ok) break;
	} catch {
		// まだ listen していない
	}
	await new Promise((r) => setTimeout(r, 100));
}

// --- seed: global 1 枚 + project 2 枚（migration の後に置く） ------------------
seedBoard(`${KB}/global.json`, { cards: [{ id: 1, text: "g1", col: "todo" }], nextId: 2 });
seedBoard(`${KB}/projects/alpha.json`, {
	cards: [
		{ id: 1, text: "a1", col: "todo" },
		{ id: 2, text: "a2", col: "done" },
	],
	nextId: 3,
});
seedBoard(`${KB}/projects/beta.json`, { cards: [{ id: 1, text: "b1", col: "doing" }], nextId: 2 });

const byText = (cards) => new Map(cards.map((c) => [c.text, c]));

// --- 1. GET /api/kanban -------------------------------------------------------
await check("/api/kanban: global は全 project のカードを sid 付きで返す", async () => {
	const r = await tf(`${BASE}/api/kanban`);
	assert.equal(r.status, 200);
	const j = await r.json();
	const cards = byText(j.global.cards);
	assert.deepEqual([...cards.keys()].sort(), ["a1", "a2", "b1", "g1"], JSON.stringify(j.global.cards));
	assert.equal(cards.get("a1").sid, "alpha");
	assert.equal(cards.get("a2").sid, "alpha");
	assert.equal(cards.get("b1").sid, "beta");
});

await check("/api/kanban: GLOBAL_JSON のカードは sid 空で残る（後方互換）", async () => {
	const j = await (await tf(`${BASE}/api/kanban`)).json();
	const g = byText(j.global.cards).get("g1");
	assert.equal(g.sid, "");
	assert.equal(g.col, "todo");
});

// --- 1b. ?fields= の射影が集約の由来を落とさない -------------------------------
await check("/api/kanban?fields=id,col,sid → sid が射影後も残る", async () => {
	const j = await (await tf(`${BASE}/api/kanban?fields=id,col,sid`)).json();
	// 同じ id が別ボードに並ぶので、sid が無いとどこのカードか復元できない。
	const dropped = j.global.cards.filter((c) => !("sid" in c));
	assert.deepEqual(dropped, [], `sid が射影で落ちている: ${JSON.stringify(j.global.cards)}`);
	assert.deepEqual(
		j.global.cards.map((c) => `${c.sid}:${c.id}`),
		[":1", "alpha:1", "alpha:2", "beta:1"],
		// GLOBAL 残行（sid 空）も slug "" として先頭に並ぶ。
		"slug 昇順、ボード内は id 昇順（順序は書き込みで揺れない）",
	);
});

// --- 2. GET /api/dashboard ----------------------------------------------------
await check("/api/dashboard: global.counts は project 2 枚 + global 1 枚の合算", async () => {
	const r = await tf(`${BASE}/api/dashboard`);
	assert.equal(r.status, 200);
	const j = await r.json();
	assert.deepEqual(j.global.counts, { todo: 2, doing: 1, done: 1 });
	assert.equal(j.global.cards.length, 4);
});

// 契約が変わった（#16）: stats = 全 project + GLOBAL 残行 + 全セッション。
// 不変条件: stats − 全セッションの counts === global.counts。
await check("/api/dashboard: stats − 全セッション === global.counts", async () => {
	const j = await (await tf(`${BASE}/api/dashboard`)).json();
	const sess = { todo: 0, doing: 0, done: 0 };
	for (const s of j.sessions) for (const k of Object.keys(sess)) sess[k] += s.counts[k];
	for (const k of Object.keys(sess)) {
		assert.equal(
			j.stats[k] - sess[k],
			j.global.counts[k],
			`${k}: stats=${j.stats[k]} sessions=${sess[k]} global=${j.global.counts[k]}`,
		);
	}
});

await check("/api/dashboard: 自 project に 1 枚だけ → stats.todo も global.counts.todo も 1", async () => {
	// 二重計上の本体: 自ボードのカードは集約（global）と project の両方に現れる。
	// 両方を足すと 2 になる。集約だけを数えれば 1。
	removeBoard(`${KB}/global.json`);
	removeBoard(`${KB}/projects/alpha.json`);
	removeBoard(`${KB}/projects/beta.json`);
	const slug = (await (await tf(`${BASE}/api/dashboard`)).json()).project.id;
	seedBoard(`${KB}/projects/${slug}.json`, { cards: [{ id: 1, text: "own1", col: "todo" }], nextId: 2 });
	const j = await (await tf(`${BASE}/api/dashboard`)).json();
	assert.equal(j.project.counts.todo, 1, `project=${JSON.stringify(j.project.counts)}`);
	assert.equal(j.stats.todo, 1, `二重計上: stats=${JSON.stringify(j.stats)}`);
	assert.equal(j.global.counts.todo, 1, `global.counts=${JSON.stringify(j.global.counts)}`);
});

// --- 3. `kanban` ツールの list（scope=global）も集約であること -----------------
// HTTP とダッシュボードの global は集約なのに、ツールだけ GLOBAL_JSON（移行後は常に空）を
// 読んでいた。同名で別物は混乱の元なので、同じ集合を返すことを固定する。
seedBoard(`${KB}/projects/gamma.json`, { cards: [{ id: 1, text: "g1-from-project", col: "todo" }], nextId: 2 });
const toolCtx = {
	hasUI: false,
	ui: { notify() {}, setWidget() {} },
	sessionManager: { getSessionId: () => "tool-session", getSessionName: () => undefined, getEntries: () => [] },
};

await check("kanban ツール list scope=global: project ボードのカードを含む", async () => {
	const r = await tools.kanban.execute("t1", { action: "list", scope: "global" }, undefined, undefined, toolCtx);
	assert.notEqual(r.isError, true, JSON.stringify(r.content));
	const text = r.content.map((c) => c.text).join("\n");
	assert.match(text, /own1/, `own1 が無い: ${text}`);
	assert.match(text, /g1-from-project/, `project ボードのカードが無い: ${text}`);
	// BLOCK: id はボードごとに 1 から振り直されるので、本文に由来が無いと #1 が複数並ぶ。
	assert.match(text, /\[gamma\]/, `集約本文に由来ボードが出ていない: ${text}`);
	assert.equal(r.details.scope, "global");
	assert.deepEqual(
		r.details.cards.map((c) => c.text).sort(),
		["g1-from-project", "own1"],
		`details.cards=${JSON.stringify(r.details.cards)}`,
	);
});

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
// poll timer は session_start を踏んでいないので未生成。HTTP サーバだけが残るので明示終了。
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
