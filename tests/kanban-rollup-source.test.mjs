// #28: 「この機械の全カード」を組む式が 4 箇所に散っている（storeWeekly / aggregateGlobal /
// weeklyPayload / projectsPayload）。式が 4 つある限りドリフトが再発する（#25 はその症状だった）。
// SOURCE で「供給の式が 1 箇所だけ」を固定し、実動作で 3 経路が同じ集合を返すことを固定する。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { authFetch } from "./helpers/token.mjs";
import { useKanban, seedBoard } from "./helpers/board.mjs";

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

const tf = (input, init) => authFetch(input, init);

const SRC = fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url));
const SOURCE = readFileSync(SRC, "utf8");


const occurrences = (haystack, needle) => {
	const out = [];
	for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + 1)) out.push(i);
	return out;
};

// トップレベルの関数本体（閉じ括弧は行頭の "}"）。SOURCE pin の切り出しはここだけが知る。
const bodyOf = (name) => {
	const start = SOURCE.indexOf(`function ${name}(`);
	if (start < 0) throw new Error(`function ${name} が無い`);
	const end = SOURCE.indexOf("\n}\n", start);
	if (end < 0) throw new Error(`function ${name} の終わりが見つからない`);
	return SOURCE.slice(start, end);
};

// --- 1: 供給の式は allRollupCards() の 1 箇所だけ -----------------------------------
await check("listProjectBoards() の呼び出しは allRollupCards() の中の 1 回だけ", () => {
	const calls = occurrences(SOURCE, ".listProjectBoards()");
	assert.equal(calls.length, 1, `listProjectBoards() の呼び出しが ${calls.length} か所ある（式がドリフトする）`);
	const body = bodyOf("allRollupCards");
	const inside = SOURCE.indexOf(body);
	assert.ok(calls[0] >= inside && calls[0] < inside + body.length, "listProjectBoards() が allRollupCards の外にある");
});

await check("readBoard(GLOBAL_JSON) は allRollupCards() の中だけ", () => {
	const reads = occurrences(SOURCE, "readBoard(GLOBAL_JSON)");
	assert.equal(reads.length, 1, `readBoard(GLOBAL_JSON) が ${reads.length} か所ある`);
	const body = bodyOf("allRollupCards");
	const inside = SOURCE.indexOf(body);
	assert.ok(reads[0] >= inside && reads[0] < inside + body.length, "readBoard(GLOBAL_JSON) が allRollupCards の外にある");
});

// --- 2: 4 経路すべてがその 1 関数から供給を受ける --------------------------------------
for (const name of ["storeWeekly", "aggregateGlobal", "weeklyPayload", "projectsPayload"]) {
	await check(`${name}() の本体が allRollupCards() を使う`, () => {
		assert.match(bodyOf(name), /allRollupCards\(\)/, `${name}() が独自の供給式を持っている`);
	});
}

await check("週次（storeWeekly / weeklyPayload）は projectBoardsOf で GLOBAL 残骸を落とす", () => {
	// 週次の引数は「プロジェクトボードだけ」。GLOBAL 残骸が混ざると slug "" の行が生える。
	for (const name of ["storeWeekly", "weeklyPayload"]) {
		assert.match(
			bodyOf(name),
			/weeklySummary\(projectBoardsOf\(allRollupCards\(\)\)/,
			`${name}() が projectBoardsOf を通していない`,
		);
	}
});

// --- 3: 実動作: 3 経路が同じ集合を返す ------------------------------------------------
const HOME_DIR = join(tmpdir(), "kb-rollup-src-home");
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
const BASE = `http://127.0.0.1:${process.env.KANBAN_PORT}`;

const { createJiti } = createRequire(import.meta.url)(
	process.env.KANBAN_JITI ?? createRequire(import.meta.url).resolve("jiti"),
);
const mod = await createJiti(import.meta.url).import(SRC);
useKanban(mod);

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

// GLOBAL 残骸 1 枚 + プロジェクト 2 ボード。全カードに blocked を付ける: /api/projects の
// blockers は scope/sid を運ぶので、供給元が同じかどうかを 1 枚ずつ突き合わせられる。
const blocked = "x";
seedBoard(`${KB}/global.json`, { cards: [{ id: 1, text: "g1", col: "todo", project: "legacy", blocked }], nextId: 2 });
seedBoard(`${KB}/projects/alpha.json`, {
	cards: [
		{ id: 1, text: "a1", col: "todo", project: "alpha-p", blocked },
		{ id: 2, text: "a2", col: "done", project: "alpha-p", blocked },
	],
	nextId: 3,
});
seedBoard(`${KB}/projects/beta.json`, { cards: [{ id: 1, text: "b1", col: "doing", project: "beta-p", blocked }], nextId: 2 });

await check("aggregateGlobal(): GLOBAL 残骸が先、以降 slug 昇順・id 昇順", async () => {
	const j = await (await tf(`${BASE}/api/kanban`)).json();
	assert.deepEqual(j.global.cards.map((c) => `${c.sid}:${c.id}`), [":1", "alpha:1", "alpha:2", "beta:1"]);
});

await check("aggregateGlobal() と projectsPayload() は同じ 3 枚を返す", async () => {
	const agg = await (await tf(`${BASE}/api/kanban`)).json();
	const proj = await (await tf(`${BASE}/api/projects`)).json();
	// projectsPayload はボード基準なので GLOBAL 残骸（sid 無し）は数えない。
	// 同じ供給を見ていることを確かめるため、aggregate 側もボードのカードだけに絞る。
	const fromAgg = agg.global.cards
		.filter((c) => c.sid !== "")
		.map((c) => `project:${c.sid}:${c.id}`)
		.sort();
	const fromProj = proj.projects
		.flatMap((p) => p.blockers)
		.map((b) => `${b.scope}:${b.sid}:${b.id}`)
		.sort();
	assert.deepEqual(fromProj, fromAgg, `供給経路で差がある: projects=${JSON.stringify(fromProj)} agg=${JSON.stringify(fromAgg)}`);
	assert.equal(fromAgg.length, 3);
});

await check("weeklyPayload().current は GLOBAL 残骸を数えない", async () => {
	const j = await (await tf(`${BASE}/api/weekly`)).json();
	const cur = j.current;
	assert.deepEqual(cur.projects.map((p) => p.slug), ["alpha", "beta"], "GLOBAL 残骸がボード slug \"\" として混ざっている");
	assert.equal(cur.totals.blocked, 3, `blocked に GLOBAL 残骸が入っている: ${JSON.stringify(cur.totals)}`);
});


console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
// poll timer は session_start を踏んでいないので未生成。HTTP サーバだけが残るので明示終了。
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
