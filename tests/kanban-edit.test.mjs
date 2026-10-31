// kanban ツール `edit` の自己検証。フレームワーク無しで `node tests/kanban-edit.test.mjs`。
// 対象: action "edit"（本文の差し替え）。規則は /api/rename と同一 —
// text.trim() で空ならエラー（ボードを書かない）/ stampMove を呼ばない（movedAt・movedBy 据え置き）/
// 対象が無ければエラー（黙って作らない）/ scope は move・remove と同じ解決。
// HOME と KANBAN_PORT を差し替えるので、本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { authFetch } from "./helpers/token.mjs";
import { readBoardAt, seedBoard, useKanban } from "./helpers/board.mjs";

const HOME_DIR = "/tmp/kb-edit-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
process.env.HOME = HOME_DIR;
// Windows: os.homedir() prefers USERPROFILE over HOME, so keep them in step or the
// server writes its token to the real profile and this test reads a missing file.
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

const require = createRequire(import.meta.url);
const { createJiti } = require(
	process.env.KANBAN_JITI ?? createRequire(import.meta.url).resolve("jiti"),
);
const jiti = createJiti(import.meta.url);
const target = process.env.KANBAN_TS ?? fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url));
const mod = await jiti.import(target);
useKanban(mod);

const HOME = `${HOME_DIR}/.pi/kanban`;
const SESSION_DIR = `${HOME}/sessions`;
const API_BASE = `http://127.0.0.1:${process.env.KANBAN_PORT}`;
const tf = (input, init) => authFetch(input, init);

const board = (sid) => readBoardAt(`${SESSION_DIR}/${sid}.json`);
const readGlobal = () => readBoardAt(`${HOME}/global.json`);
const writeSession = (sid, b) => seedBoard(`${SESSION_DIR}/${sid}.json`, b);
const writeGlobal = (b) => seedBoard(`${HOME}/global.json`, b);

const ctxFor = (sid) => ({
	hasUI: false,
	isIdle: () => true,
	ui: { notify() {}, setWidget() {} },
	sessionManager: { getSessionId: () => sid, getEntries: () => [] },
});

const handlers = new Map();
const registered = [];
const commands = new Map();
const pi = {
	registerCommand(name, spec) {
		commands.set(name, spec);
	},
	registerTool(spec) {
		registered.push(spec);
	},
	appendEntry() {},
	on(ev, fn) {
		handlers.set(ev, fn);
	},
	sendUserMessage() {},
};
mod.default(pi);
const tool = registered.find((s) => s.name === "kanban");
assert.ok(tool, "kanban ツールが登録されている");

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

const run = (sid, params) => tool.execute("c", params, undefined, undefined, ctxFor(sid));

// 固定の movedAt / movedBy を持つカードを用意する（据え置きを実測するため）。
const STAMP_AT = Date.parse("2026-10-17T20:00:00.000Z");
const seed = (sid, cards, nextId = 9) => writeSession(sid, { cards, nextId });
const stampCard = (id, text, extra = {}) => ({
	id,
	text,
	col: "doing",
	movedAt: STAMP_AT,
	movedBy: "owner-session",
	...extra,
});

await check("edit: 本文が差し替わる（id + text + scope）", async () => {
	const SID = "edit-basic";
	seed(SID, [stampCard(1, "before")]);
	const r = await run(SID, { action: "edit", id: 1, text: "after" });
	assert.ok(!r.isError, r.content[0].text);
	const c = board(SID).cards.find((x) => x.id === 1);
	assert.equal(c.text, "after");
	assert.equal(r.details.scope, "session");
});

await check("edit: movedAt / movedBy は据え置き（stampMove を呼ばない）", async () => {
	const SID = "edit-stamp";
	seed(SID, [stampCard(1, "before")]);
	const r = await run(SID, { action: "edit", id: 1, text: "after" });
	assert.ok(!r.isError, r.content[0].text);
	const c = board(SID).cards.find((x) => x.id === 1);
	assert.equal(c.movedAt, STAMP_AT, "movedAt が動いた");
	assert.equal(c.movedBy, "owner-session", "movedBy が移った");
});

await check("edit: 前後の空白は落とす（/api/rename と同じ trim）", async () => {
	const SID = "edit-trim";
	seed(SID, [stampCard(1, "before")]);
	const r = await run(SID, { action: "edit", id: 1, text: "  padded body\n\n" });
	assert.ok(!r.isError, r.content[0].text);
	assert.equal(board(SID).cards.find((x) => x.id === 1).text, "padded body");
});

await check('edit: 空文字 / 空白のみはエラーでボードが変わらない', async () => {
	const SID = "edit-empty";
	seed(SID, [stampCard(1, "keep")]);
	for (const text of ["", "   ", "\n\t "]) {
		const r = await run(SID, { action: "edit", id: 1, text });
		assert.ok(r.isError, `空 text ${JSON.stringify(text)} が通った`);
	}
	const r2 = await run(SID, { action: "edit", id: 1 });
	assert.ok(r2.isError, "text 省略が通った");
	assert.equal(board(SID).cards.find((x) => x.id === 1).text, "keep");
	assert.equal(board(SID).cards.find((x) => x.id === 1).movedAt, STAMP_AT);
});

await check("edit: 存在しない id はエラーでボードが変わらない（カードも作らない）", async () => {
	const SID = "edit-missing";
	seed(SID, [stampCard(1, "keep")]);
	const r = await run(SID, { action: "edit", id: 99, text: "ghost" });
	assert.ok(r.isError, "存在しない id が通った");
	assert.match(r.content[0].text, /no card with id 99/);
	const b = board(SID);
	assert.equal(b.cards.length, 1);
	assert.equal(b.nextId, 9, "nextId を進めた");
	assert.equal(b.cards[0].text, "keep");
	const r2 = await run(SID, { action: "edit", text: "no-id" });
	assert.ok(r2.isError, "id 省略が通った");
	assert.equal(board(SID).cards.length, 1);
});

await check("edit: scope=global は global ボードのカードを書き換える（session は無傷）", async () => {
	const SID = "edit-global";
	writeGlobal({ cards: [{ id: 7, text: "g-before", col: "todo" }], nextId: 8 });
	seed(SID, [stampCard(7, "s-before")]);
	const r = await run(SID, { action: "edit", id: 7, text: "g-after", scope: "global" });
	assert.ok(!r.isError, r.content[0].text);
	assert.equal(readGlobal().cards.find((x) => x.id === 7).text, "g-after");
	assert.equal(board(SID).cards.find((x) => x.id === 7).text, "s-before", "session 側が書き換わった");
	// scope 省略は session（move / remove と同じ既定）。global の #7 はもう触らない。
	const r2 = await run(SID, { action: "edit", id: 7, text: "s-after" });
	assert.ok(!r2.isError, r2.content[0].text);
	assert.equal(board(SID).cards.find((x) => x.id === 7).text, "s-after");
	assert.equal(readGlobal().cards.find((x) => x.id === 7).text, "g-after");
});

await check("edit: details.cards は書き換え後のボードを返す", async () => {
	const SID = "edit-details";
	seed(SID, [stampCard(1, "before")]);
	const r = await run(SID, { action: "edit", id: 1, text: "after" });
	assert.equal(r.details.cards.find((x) => x.id === 1).text, "after");
});

// GUI 反映: refresh はサーバを経由しないので、サーバの読み取り (/api/kanban) で
// ディスク上の本文が新しくなっていることを実測する（同一プロセス・同一 HOME）。
await check("edit: サーバ経由の /api/kanban に反映される（refresh 経路）", async () => {
	const SID = "edit-gui";
	seed(SID, [stampCard(1, "before")]);
	handlers.get("session_start")({}, ctxFor(SID));
	const r = await run(SID, { action: "edit", id: 1, text: "gui-after" });
	assert.ok(!r.isError, r.content[0].text);
	let body = null;
	for (let i = 0; i < 100; i++) {
		const res = await tf(`${API_BASE}/api/kanban?scope=session&sid=${SID}`);
		if (res.status === 200) {
			body = await res.json();
			break;
		}
		await new Promise((r2) => setTimeout(r2, 50));
	}
	assert.ok(body, "/api/kanban が 200 を返さない（サーバ未起動）");
	const card = body.session.cards.find((x) => x.id === 1);
	assert.equal(card.text, "gui-after");
	assert.equal(card.movedAt, STAMP_AT, "/api/kanban 側で movedAt が動いた");
});

// KANBAN_HELP に 1 行載っていること（人が /kanban help で見つけられる）。
await check("KANBAN_HELP に edit の行がある", async () => {
	const notes = [];
	const cmd = commands.get("kanban");
	assert.ok(cmd, "/kanban コマンドが登録されていない");
	await cmd.handler("help", { ...ctxFor("edit-help"), ui: { notify: (t) => notes.push(t), setWidget() {} } });
	const help = notes.join("\n");
	assert.match(help, /kanban ツール action="edit" <id>/);
	// `/kanban edit` は実在しない（parseKanbanArgs ではカード追加扱い）。help で導くなら罠になる。
	assert.doesNotMatch(help, /\/kanban edit/);
});

for (const f of failures) console.error(`FAIL ${f}`);
console.log(`${passed} passed, ${failures.length} failed`);
// poll timer は session_start を踏むので動いている。HTTP サーバごと明示終了。
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
