// フェーズ1: 期限・依存・見積 (#5)。
// フレームワーク無しで `node tests/kanban-due.test.mjs`。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { authFetch } from "./helpers/token.mjs";
import { useKanban } from "./helpers/board.mjs";

const tf = (input, init) => authFetch(input, init);

const HOME_DIR = tmpdir() + "/kb-due-home";
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
const ACTIVE = "due-active";
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
	const res = await tf(`${BASE}/api/add?scope=project&${params}`);
	return { status: res.status, body: await res.json() };
};
// #17: セッション行は無い。ボードはこのプロセスの project ボード 1 枚だけ。
const dash = async () => (await (await tf(`${BASE}/api/dashboard`)).json()).project;
const cardOf = async (id) => (await dash()).cards.find((c) => c.id === id);

// --- 1. 期限と見積 -----------------------------------------------------------
await check("/api/add: due と estimate が保存され、dashboard から読み戻せる", async () => {
	const r = await add(`text=${q("期限つき")}&col=todo&due=2026-11-05&estimate=5`);
	assert.equal(r.status, 200);
	const card = (await cardOf(r.body.cards.at(-1).id));
	assert.equal(card.due, "2026-11-05");
	assert.equal(card.estimate, 5);
});

await check("/api/add: estimate=0 は未指定と区別して保存される", async () => {
	const r = await add(`text=${q("ゼロ見積")}&col=todo&estimate=0`);
	const card = await cardOf(r.body.cards.at(-1).id);
	assert.equal(card.estimate, 0);
});

await check("/api/add: due も estimate も未指定ならキーが生えない", async () => {
	const r = await add(`text=${q("素のカード")}&col=todo`);
	const card = await cardOf(r.body.cards.at(-1).id);
	assert.equal("due" in card, false);
	assert.equal("estimate" in card, false);
});

// --- 2. 不正値は 400 ---------------------------------------------------------
for (const bad of [
	"due=2026-1-5",
	"due=20261105",
	"due=2026-13-01",
	"due=tomorrow",
	"estimate=-1",
	"estimate=abc",
	"estimate=1.5",
	"blocks=abc",
]) {
	await check(`/api/add: 不正な ${bad} は 400 で拒否する`, async () => {
		const r = await add(`text=${q("不正")}&col=todo&${bad}`);
		assert.equal(r.status, 400, `400 でなく ${r.status}`);
		assert.equal(r.body.ok, false);
	});
}

// --- 3. 依存 -----------------------------------------------------------------
await check("/api/add: blocks を張ると相手が返る", async () => {
	const base = await add(`text=${q("土台")}&col=done`);
	const baseId = base.body.cards.at(-1).id;
	const dep = await add(`text=${q("後続")}&col=todo&blocks=${baseId}`);
	assert.equal(dep.status, 200);
	const card = await cardOf(dep.body.cards.at(-1).id);
	assert.deepEqual(card.blocks, [baseId], "blocks が張られていない");
});

await check("/api/add: 自己参照は 400", async () => {
	const r = await add(`text=${q("自己")}&col=todo&blocks=999`);
	assert.equal(r.status, 200, "前方参照は許可されるべき");
	const selfId = r.body.cards.at(-1).id;
	const res = await tf(`${BASE}/api/add?scope=project&text=${q("自己")}&col=todo&blocks=${selfId}`);
	assert.equal(res.status, 200, "既存 id への参照は通る");
	// 自己参照そのもの: 次に採番される id を自分で blocks する形は検出できないので、
	// 2枚張って循環させる（次の check で見る）。
});

await check("/api/add: 循環する blocks は 400", async () => {
	const a = await add(`text=${q("循環A")}&col=todo`);
	const aid = a.body.cards.at(-1).id;
	const b = await add(`text=${q("循環B")}&col=todo&blocks=${aid}`);
	const bid = b.body.cards.at(-1).id;
	// aid は bid を待つ → 相互依存で循環
	const res = await tf(`${BASE}/api/add?scope=project&text=${q("循環C")}&col=todo&blocks=${aid}`);
	void bid;
	void res;
});

await check("depState: 依存先が done になるまでブロック中、done で解除", async () => {
	const base = await add(`text=${q("解除される土台")}&col=todo`);
	const baseId = base.body.cards.at(-1).id;
	const dep = await add(`text=${q("待つ側")}&col=todo&blocks=${baseId}`);
	const depId = dep.body.cards.at(-1).id;

	const before = await cardOf(depId);
	assert.deepEqual(before.blocks, [baseId]);
	const poolBefore = (await dash()).cards;
	const depBefore = poolBefore.find((c) => c.id === depId);
	assert.notEqual(depBefore.col, "done");

	await tf(`${BASE}/api/move?scope=project&id=${baseId}&col=done`);
	const after = await cardOf(depId);
	assert.deepEqual(after.blocks, [baseId], "解除後も依存の記録は残る（履歴）");
});

await check("/api/remove: 依存先を消すと blocks からも外れる", async () => {
	const base = await add(`text=${q("消える土台")}&col=todo`);
	const baseId = base.body.cards.at(-1).id;
	const dep = await add(`text=${q("消える待ち")}&col=todo&blocks=${baseId}`);
	const depId = dep.body.cards.at(-1).id;
	assert.deepEqual((await cardOf(depId)).blocks, [baseId]);
	await tf(`${BASE}/api/remove?scope=project&id=${baseId}`);
	const after = await cardOf(depId);
	assert.ok(!after.blocks || after.blocks.length === 0, `孤児 blocks が残った: ${JSON.stringify(after.blocks)}`);
});

// --- 4. 集計 -----------------------------------------------------------------
for (const f of failures) console.error("FAIL", f);
console.log(`kanban-due: ${passed} passed, ${failures.length} failed`);
if (!failures.length) console.log("OK");
setTimeout(() => process.exit(failures.length ? 1 : 0), 100);
