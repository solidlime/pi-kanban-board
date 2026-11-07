// 書き込み先ボードの指定（?p=<slug>）の自己検証。
// フレームワーク無しで `node tests/kanban-board-write-target.test.mjs`。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { authFetch } from "./helpers/token.mjs";
import { readBoardAt, seedBoard, useKanban } from "./helpers/board.mjs";

const tf = (input, init) => authFetch(input, init);

const HOME_DIR = tmpdir() + "/kb-board-write-target-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/projects`, { recursive: true });
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

const pi = { registerCommand() {}, registerTool() {}, appendEntry() {}, on() {}, sendUserMessage() {} };
mod.default(pi);
for (let i = 0; i < 40; i++) {
	try {
		if ((await tf(`${BASE}/api/kanban`)).ok) break;
	} catch {
		// まだ listen していない
	}
	await new Promise((r) => setTimeout(r, 100));
}

const get = async (path) => {
	const r = await tf(`${BASE}${path}`);
	return { status: r.status, body: await r.json() };
};
// 書き込みルートは GET（ダッシュボードの act() が method を付けずに叩くのと同じ）。
const post = async (path) => {
	const r = await tf(`${BASE}${path}`);
	let body = null;
	try {
		body = await r.json();
	} catch {
		// 本文なしの応答もある
	}
	return { status: r.status, body };
};
const cardsOf = (slug) => readBoardAt(`${HOME_DIR}/.pi/kanban/projects/${slug}.json`).cards;

// cwd のボード（このテストのリポジトリ）と、書き込み先に選ぶ別ボード。
const cwdSlug = "pi-kanban-board";
seedBoard(`${HOME_DIR}/.pi/kanban/projects/${cwdSlug}.json`, {
	cards: [{ id: 1, text: "cwd のカード", col: "todo" }],
	nextId: 2,
});
seedBoard(`${HOME_DIR}/.pi/kanban/projects/alpha.json`, {
	cards: [{ id: 1, text: "alpha のカード", col: "todo" }],
	nextId: 2,
});

await check("GET /api/move?p=alpha は alpha に着地し、cwd のボードは変わらない", async () => {
	const r = await post("/api/move?scope=project&p=alpha&id=1&col=done");
	assert.equal(r.status, 200);
	assert.equal(cardsOf("alpha")[0].col, "done", "alpha に書かれていない");
	assert.equal(cardsOf(cwdSlug)[0].col, "todo", "cwd のボードまで動いた");
	// 読む側も同じボードを指す（書きと読みで別名にならない）
	const view = await get("/api/kanban?p=alpha");
	assert.equal(view.body.project.cards[0].col, "done");
});

await check("p の表記ゆれ（Pi-Kanban-Board）は保存表記のボードに着地する", async () => {
	const r = await post(`/api/move?scope=project&p=${encodeURIComponent(cwdSlug.toUpperCase())}&id=1&col=doing`);
	assert.equal(r.status, 200);
	assert.equal(cardsOf(cwdSlug)[0].col, "doing", "保存表記のボードに書かれていない");
});

// normalizeProject は不正な文字を落とす（書き込み境界の他の入力と同じ扱い）ので、
// 400 になるのは全部落ちて空になったときだけ。計画書の「不正文字は 400」はここが実態。
await check("p が 1 文字も残らないなら 400（別ボードに落とさない）", async () => {
	for (const bad of ["///", "!!!", "  ", "あ"]) {
		const r = await post(`/api/move?scope=project&p=${encodeURIComponent(bad)}&id=1&col=done`);
		assert.equal(r.status, 400, `${bad}: ${r.status}`);
		assert.equal(r.body && r.body.error, "p must match [A-Za-z0-9._-]", `${bad}: ${JSON.stringify(r.body)}`);
	}
});

await check("GET /api/move?scope=global&p=alpha は 400（global は読み取り専用のまま）", async () => {
	const r = await post("/api/move?scope=global&p=alpha&id=1&col=done");
	assert.equal(r.status, 400, `global が書き込みを許した: ${r.status}`);
	assert.equal(cardsOf("alpha")[0].col, "done", "global 指定なのに alpha が書かれた");
});

await check("/api/projects はカードのあるボードを全部返す（タグ無しでも）", async () => {
	const body = (await get("/api/projects")).body;
	const slugs = body.projects.map((p) => p.slug).sort();
	assert.deepEqual(slugs, ["alpha", cwdSlug], `ボードが揃っていない: ${JSON.stringify(slugs)}`);
});

// #35: 形が違うと、選んだ看板は「次にやる」も残数も再開ボタンも無い板として描かれる。
await check("/api/kanban?p= の project は /api/dashboard と同じ 10 キーを返す", async () => {
	const keys = (o) => Object.keys(o || {}).sort().join(",");
	const dash = (await get("/api/dashboard")).body.project;
	const one = (await get(`/api/kanban?p=${cwdSlug}`)).body;
	assert.equal(keys(one.project), keys(dash), `形が違う: ${keys(one.project)} != ${keys(dash)}`);
	// #67: deliverableCount（成果物の帯の見出しの数字）。#82: deliverables（deliv の行）が 10 個目。
	assert.equal(
		keys(one.project),
		"cards,counts,deliverableCount,deliverables,halted,hiddenTodoCount,id,loops,modes,next",
		"10 キーではない",
	);
	assert.equal(one.projectId, one.project.id, "projectId と project.id が食い違う");
});

await check("?p= に fields= を付けると射影された素の Board のまま", async () => {
	const body = (await get(`/api/kanban?p=${cwdSlug}&fields=id`)).body;
	// #82: 素の Board には deliv も乗る（成果物は card の fields では絞れない）。
	assert.deepEqual(Object.keys(body.project).sort(), ["cards", "delivNextId", "deliverables", "nextId"], "射影が崩れている");
});

for (const f of failures) console.error("FAIL", f);
console.log(`kanban-board-write-target: ${passed} passed, ${failures.length} failed`);
// サーバを掴んだままにしない（プロセスを終了させる）
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
