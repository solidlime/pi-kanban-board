// #20: カードの会話リンク（Card.sessionId / Card.commit）。
// フレームワーク無しで `node tests/kanban-link.test.mjs`。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
// 契約: どちらも書き込み境界で正規化する。session は [A-Za-z0-9._:@-] 以外を落として 128 文字。
// commit は 7〜40 桁の hex を小文字化して保存し、非空で形式が違えば 400（黙って捨てない）。
// 空 = キーごと削除。リンクは張らない（表示だけ）。
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { authFetch } from "./helpers/token.mjs";
import { readBoardAt, seedBoard, useKanban } from "./helpers/board.mjs";

const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-link-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
mkdirSync(`${HOME_DIR}/workspace`, { recursive: true });
process.env.HOME = HOME_DIR;
// Windows: os.homedir() prefers USERPROFILE over HOME, so keep them in step.
process.env.USERPROFILE = HOME_DIR;
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

const tools = {};
const pi = {
	registerCommand() {},
	registerTool(t) {
		tools[t.name] = t;
	},
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

const SID = "link-session";
const KANBAN = `${HOME_DIR}/.pi/kanban`;
const PROJ_BOARD = `${KANBAN}/projects/${mod.projectSlugOf(process.cwd())}.json`;
const boardOf = () => readBoardAt(PROJ_BOARD);
const cardNamed = (text) => boardOf().cards.find((c) => c.text === text);

// --- 1. 純関数 -----------------------------------------------------------------
await check("normalizeSessionId: trim / URL 危険文字の除去 / 128 文字切捨て / 非文字列は \"\"", () => {
	assert.equal(mod.SESSION_MAX, 128);
	assert.equal(mod.normalizeSessionId("  aB3._:@-  "), "aB3._:@-");
	// URL のクエリ区切りは落とす（そのまま載せると別のパラメータになる）
	assert.equal(mod.normalizeSessionId("s?x=1&y=2#z"), "sx1y2z");
	assert.equal(mod.normalizeSessionId("/etc/passwd"), "etcpasswd");
	assert.equal(mod.normalizeSessionId("日本語"), "");
	assert.equal(mod.normalizeSessionId("a".repeat(200)), "a".repeat(128));
	for (const v of [undefined, null, 42, {}, [], true]) {
		assert.equal(mod.normalizeSessionId(v), "", `${JSON.stringify(v)} が空にならない`);
	}
});

await check("normalizeCommit: 7〜40 桁 hex だけ通し、小文字化する", () => {
	assert.equal(mod.normalizeCommit("ABCDEF1"), "abcdef1");
	assert.equal(mod.normalizeCommit("  abc1234  "), "abc1234");
	assert.equal(mod.normalizeCommit("a".repeat(40)), "a".repeat(40));
	// 短すぎ / 長すぎ / 非 hex はすべて ""
	assert.equal(mod.normalizeCommit("abcdef"), "");
	assert.equal(mod.normalizeCommit("a".repeat(41)), "");
	assert.equal(mod.normalizeCommit("ghijklm"), "");
	assert.equal(mod.normalizeCommit("abc 123"), "");
	for (const v of [undefined, null, 42, {}, [], true]) {
		assert.equal(mod.normalizeCommit(v), "", `${JSON.stringify(v)} が空にならない`);
	}
});

// --- 2. 書き込み経路（HTTP） -----------------------------------------------------

await check("/api/add?session&commit → 保存（commit は小文字化）", async () => {
	const r = await tf(`${BASE}/api/add?scope=project&text=with+link&session=abc-123&commit=ABCDEF12`);
	assert.equal(r.status, 200, `status ${r.status}`);
	const c = cardNamed("with link");
	assert.equal(c.sessionId, "abc-123");
	assert.equal(c.commit, "abcdef12");
});

await check("/api/add（session/commit なし）→ キーが存在しない（後方互換）", async () => {
	const r = await tf(`${BASE}/api/add?scope=project&text=no+link`);
	assert.equal(r.status, 200);
	const c = cardNamed("no link");
	assert.ok(!("sessionId" in c), "sessionId キーが生えた");
	assert.ok(!("commit" in c), "commit キーが生えた");
});

await check("/api/add?session=（空）だけなら 400 にならない", async () => {
	const r = await tf(`${BASE}/api/add?scope=project&text=empty+session&session=`);
	assert.equal(r.status, 200, `status ${r.status}`);
	assert.ok(!("sessionId" in cardNamed("empty session")), "空指定で sessionId が生えた");
});

await check("/api/add?commit=<不正> → 400 かつカードが作られない", async () => {
	const before = boardOf().cards.length;
	const r = await tf(`${BASE}/api/add?scope=project&text=bad+commit&commit=abcdef`);
	assert.equal(r.status, 400, `status ${r.status}`);
	assert.match(String((await r.json()).error ?? ""), /commit/, "400 の理由が commit でない");
	assert.equal(boardOf().cards.length, before, "400 なのにカードが増えた");
	assert.equal(cardNamed("bad commit"), undefined, "不正 commit のカードが作られた");
});

await check("/api/add?session=<正規化不能> → 400 かつカードが作られない", async () => {
	const before = boardOf().cards.length;
	const r = await tf(BASE + "/api/add?scope=project&text=bad+session&session=" + encodeURIComponent("日本語"));
	assert.equal(r.status, 400, `status ${r.status}`);
	assert.match(String((await r.json()).error ?? ""), /session/, "400 の理由が session でない");
	assert.equal(boardOf().cards.length, before, "400 なのにカードが増えた");
});

// 空白だけは「無指定」ではなくタイポ。project / session と同じ扱いにする（無言で捨てない）。
await check("/api/add?commit=%20%20 → 400 かつカードが作られない", async () => {
	const before = boardOf().cards.length;
	const r = await tf(`${BASE}/api/add?scope=project&text=blank+commit&commit=%20%20`);
	assert.equal(r.status, 400, `status ${r.status}`);
	assert.match(String((await r.json()).error ?? ""), /commit/, "400 の理由が commit でない");
	assert.equal(boardOf().cards.length, before, "400 なのにカードが増えた");
	assert.equal(cardNamed("blank commit"), undefined, "空白 commit のカードが作られた");
});

await check("/api/add?session=%20%20 → 400 かつカードが作られない", async () => {
	const before = boardOf().cards.length;
	const r = await tf(`${BASE}/api/add?scope=project&text=blank+session&session=%20%20`);
	assert.equal(r.status, 400, `status ${r.status}`);
	assert.match(String((await r.json()).error ?? ""), /session/, "400 の理由が session でない");
	assert.equal(boardOf().cards.length, before, "400 なのにカードが増えた");
});

await check("/api/add?commit=%20abc1234%20 → 200 かつ commit は abc1234（前後の空白は落とす）", async () => {
	const r = await tf(`${BASE}/api/add?scope=project&text=padded+commit&commit=%20abc1234%20`);
	assert.equal(r.status, 200, `status ${r.status}`);
	assert.equal(cardNamed("padded commit").commit, "abc1234");
});

const linkId = () => cardNamed("with link").id;

await check("/api/schedule?session=（空）→ sessionId キーが消える", async () => {
	const r = await tf(`${BASE}/api/schedule?scope=project&id=${linkId()}&session=`);
	assert.equal(r.status, 200, `status ${r.status}`);
	assert.ok(!("sessionId" in cardNamed("with link")), "空指定で sessionId が残った");
});

await check("/api/schedule?session=xyz → 設定できる（at/blocked/project なしでも 400 にしない）", async () => {
	const r = await tf(`${BASE}/api/schedule?scope=project&id=${linkId()}&session=xyz`);
	assert.equal(r.status, 200, `status ${r.status}`);
	assert.equal(cardNamed("with link").sessionId, "xyz");
});

await check("/api/schedule?commit=のみ → 200 で text が変わらない", async () => {
	const r = await tf(`${BASE}/api/schedule?scope=project&id=${linkId()}&commit=deadbeef`);
	assert.equal(r.status, 200, `status ${r.status}`);
	const c = cardNamed("with link");
	assert.equal(c.commit, "deadbeef");
	assert.equal(c.text, "with link", "commit だけの変更で text が変わった");
});

await check("/api/schedule?commit=<不正> → 400 かつ commit は変わらない", async () => {
	const before = cardNamed("with link").commit;
	const r = await tf(`${BASE}/api/schedule?scope=project&id=${linkId()}&commit=zzz`);
	assert.equal(r.status, 400, `status ${r.status}`);
	assert.equal(cardNamed("with link").commit, before, "400 なのに commit が変わった");
});

await check("/api/schedule?commit=%20%20 → 400 かつ commit は変わらない", async () => {
	const before = cardNamed("with link").commit;
	const r = await tf(`${BASE}/api/schedule?scope=project&id=${linkId()}&commit=%20%20`);
	assert.equal(r.status, 400, `status ${r.status}`);
	assert.match(String((await r.json()).error ?? ""), /commit/, "400 の理由が commit でない");
	assert.equal(cardNamed("with link").commit, before, "400 なのに commit が変わった");
});

await check("/api/schedule?id のみ（session も commit も無い）→ 400 のまま", async () => {
	const r = await tf(`${BASE}/api/schedule?scope=project&id=${linkId()}`);
	assert.equal(r.status, 400, `status ${r.status}`);
});

await check("?fields=sessionId,commit → その 2 列だけが返る", async () => {
	// 射影の前に両方を持たせる
	await tf(`${BASE}/api/schedule?scope=project&id=${linkId()}&session=zzz`);
	const r = await tf(`${BASE}/api/kanban?scope=project&fields=sessionId,commit`);
	assert.equal(r.status, 200);
	const j = await r.json();
	const hit = j.project.cards.filter((c) => c.commit === "deadbeef");
	assert.equal(hit.length, 1, "commit が射影から落ちている");
	assert.deepEqual(Object.keys(hit[0]).sort(), ["commit", "sessionId"], "射影が他のキーも返している");
	assert.equal(hit[0].sessionId, "zzz");
	assert.equal(j.project.cards.length, boardOf().cards.length, "射影でカードが減った");
});

// 配置制約: 上の ?fields= テストが commit === "deadbeef" を要求するので、その後ろに置く。
await check("/api/schedule?commit=（空）→ commit キーが消える", async () => {
	const r = await tf(`${BASE}/api/schedule?scope=project&id=${linkId()}&commit=`);
	assert.equal(r.status, 200, `status ${r.status}`);
	assert.ok(!("commit" in cardNamed("with link")), "空指定で commit が残った");
});

await check("/api/add?commit=（空）→ 400 にならず commit キーが無い", async () => {
	const r = await tf(`${BASE}/api/add?scope=project&text=empty+commit&commit=`);
	assert.equal(r.status, 200, `status ${r.status}`);
	assert.ok(!("commit" in cardNamed("empty commit")), "空指定で commit が生えた");
});

// --- 3. ツール -------------------------------------------------------------------
await check("tool add/edit: session/commit を正規化して付け、text を消さずに消せる", async () => {
	const tool = tools.kanban;
	assert.ok(tool, "kanban tool が登録されていない");
	const ctx = { sessionManager: { getSessionId: () => SID } };
	seedBoard(PROJ_BOARD, { cards: [], nextId: 1 });
	const add = await tool.execute(
		"c1",
		{ action: "add", scope: "project", text: "tool link", session: "S-1", commit: "AABBCC1" },
		null,
		null,
		ctx,
	);
	assert.ok(!add.isError, JSON.stringify(add).slice(0, 300));
	const card = readBoardAt(PROJ_BOARD).cards.find((c) => c.text === "tool link");
	assert.ok(card, "tool add でカードが作られていない");
	assert.equal(card.sessionId, "S-1");
	assert.equal(card.commit, "aabbcc1", "tool add が commit を小文字化していない");
	// formatCard: commit は 7 桁で出て、sessionId は出ない（TUI が長い ID で埋まらない）
	const line = add.content[0].text;
	assert.ok(line.includes("aabbcc1"), `formatCard に commit が無い: ${line}`);
	assert.ok(!line.includes("S-1"), `formatCard に sessionId が出ている: ${line}`);
	const edit = await tool.execute("c2", { action: "edit", scope: "project", id: card.id, commit: "" }, null, null, ctx);
	assert.ok(!edit.isError, JSON.stringify(edit).slice(0, 300));
	const after = readBoardAt(PROJ_BOARD).cards.find((c) => c.id === card.id);
	assert.ok(!("commit" in after), "空指定で commit が残った");
	assert.equal(after.text, "tool link", "commit だけの edit で text が消えた");
	assert.equal(after.sessionId, "S-1", "commit の edit で sessionId が消えた");
});

await check("tool edit: session だけの edit も通る（text 必須にしない）", async () => {
	const tool = tools.kanban;
	const ctx = { sessionManager: { getSessionId: () => SID } };
	const card = readBoardAt(PROJ_BOARD).cards.find((c) => c.text === "tool link");
	const edit = await tool.execute("c3", { action: "edit", scope: "project", id: card.id, session: "S-2" }, null, null, ctx);
	assert.ok(!edit.isError, JSON.stringify(edit).slice(0, 300));
	assert.equal(readBoardAt(PROJ_BOARD).cards.find((c) => c.id === card.id).sessionId, "S-2");
});

await check("tool add: commit='  ' は fail かつカードが増えない", async () => {
	const tool = tools.kanban;
	const ctx = { sessionManager: { getSessionId: () => SID } };
	const before = readBoardAt(PROJ_BOARD).cards.length;
	const add = await tool.execute("c5", { action: "add", scope: "project", text: "blank tool", commit: "  " }, null, null, ctx);
	assert.equal(add.isError, true, JSON.stringify(add).slice(0, 200));
	assert.ok(JSON.stringify(add).includes("commit must be"), "理由が返っていない");
	assert.equal(readBoardAt(PROJ_BOARD).cards.length, before, "fail なのにカードが増えた");
});

await check("tool edit: commit='  ' は fail かつ commit が消えない", async () => {
	const tool = tools.kanban;
	const ctx = { sessionManager: { getSessionId: () => SID } };
	const id = readBoardAt(PROJ_BOARD).cards.find((c) => c.text === "tool link").id;
	await tool.execute("c6", { action: "edit", scope: "project", id, commit: "deadbe2" }, null, null, ctx);
	const edit = await tool.execute("c7", { action: "edit", scope: "project", id, commit: "  " }, null, null, ctx);
	assert.equal(edit.isError, true, "空白 commit が通った");
	assert.equal(readBoardAt(PROJ_BOARD).cards.find((c) => c.id === id).commit, "deadbe2", "fail なのに commit が消えた");
});

await check("tool add: 不正な commit は fail（無言で無視しない）", async () => {
	const tool = tools.kanban;
	const ctx = { sessionManager: { getSessionId: () => SID } };
	const before = readBoardAt(PROJ_BOARD).cards.length;
	const add = await tool.execute("c4", { action: "add", scope: "project", text: "bad tool", commit: "nope" }, null, null, ctx);
	assert.equal(add.isError, true, "fail なのに isError でない: " + JSON.stringify(add).slice(0, 200));
	assert.ok(JSON.stringify(add).includes("commit must be"), "理由が返っていない");
	assert.equal(readBoardAt(PROJ_BOARD).cards.length, before, "fail なのにカードが増えた");
});

// --- 結果 -----------------------------------------------------------------------
if (failures.length > 0) {
	console.error(`FAIL ${failures.length} / ${passed + failures.length}`);
	for (const f of failures) console.error(`  - ${f}`);
}
if (!failures.length) console.log(`ok ${passed} checks (kanban-link)`);
setTimeout(() => process.exit(failures.length ? 1 : 0), 100);
