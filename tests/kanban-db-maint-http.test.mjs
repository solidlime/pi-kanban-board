// #13 DB メンテ操作（診断 / VACUUM）の HTTP 面の自己検証 (#011)。
// フレームワーク無しで `node tests/kanban-db-maint-http.test.mjs`。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { authFetch } from "./helpers/token.mjs";
import { useKanban, seedBoard, readBoardAt } from "./helpers/board.mjs";

// #83b: HTTP routes need the server token now; tf = fetch + the kb_auth cookie.
const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-dbmaint-home";
rmSync(HOME_DIR, { recursive: true, force: true });
const KB = `${HOME_DIR}/.pi/kanban`;
mkdirSync(`${KB}/sessions`, { recursive: true });
mkdirSync(`${KB}/media`, { recursive: true });
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
		if ((await tf(`${BASE}/api/kanban`)).ok) break;
	} catch {
		// まだ listen していない
	}
	await new Promise((r) => setTimeout(r, 100));
}

// --- 対象データを用意する -----------------------------------------------------
const GLOBAL = `${KB}/global.json`;
seedBoard(GLOBAL, {
	cards: [
		{ id: 1, text: "a", col: "todo" },
		{ id: 2, text: "b", col: "done" },
	],
	nextId: 3,
});

// --- 405 / 401 ---------------------------------------------------------------
// GET は既存の書き込み GET ゲート（#80-⑥）が 405 で止める。ヘッダ無しの caller は
// そのゲートの対象外（curl/スクリプト）なので、ブラウザ相当の Sec-Fetch-Site を載せる。
await check("GET /api/db/diagnose -> 405", async () => {
	const r = await tf(`${BASE}/api/db/diagnose`, { headers: { "Sec-Fetch-Site": "cross-site" } });
	assert.equal(r.status, 405);
});
await check("GET /api/db/vacuum -> 405", async () => {
	const r = await tf(`${BASE}/api/db/vacuum`, { headers: { "Sec-Fetch-Site": "cross-site" } });
	assert.equal(r.status, 405);
});
await check("token なし POST /api/db/diagnose -> 401", async () => {
	const r = await fetch(`${BASE}/api/db/diagnose`, { method: "POST" });
	assert.equal(r.status, 401);
	await r.arrayBuffer();
});
await check("token なし POST /api/db/vacuum -> 401", async () => {
	const r = await fetch(`${BASE}/api/db/vacuum`, { method: "POST" });
	assert.equal(r.status, 401);
	await r.arrayBuffer();
});

await check("cross-origin POST /api/db/vacuum -> 403", async () => {
	// #13: isWritePath() に足した 2 パスが Origin ゲートの中を通ることを固定する。
	const r = await tf(`${BASE}/api/db/vacuum`, { method: "POST", headers: { Origin: "http://evil.example" } });
	assert.equal(r.status, 403);
	await r.arrayBuffer();
});
await check("cross-origin POST /api/db/diagnose -> 403", async () => {
	const r = await tf(`${BASE}/api/db/diagnose`, { method: "POST", headers: { Origin: "http://evil.example" } });
	assert.equal(r.status, 403);
	await r.arrayBuffer();
});

// --- 診断 --------------------------------------------------------------------
await check("POST /api/db/diagnose -> 200 / integrity ok / pages > 0", async () => {
	const r = await tf(`${BASE}/api/db/diagnose`, { method: "POST" });
	assert.equal(r.status, 200);
	const body = await r.json();
	assert.equal(body.ok, true, JSON.stringify(body));
	assert.equal(body.integrity, "ok");
	assert.ok(body.pages > 0, `pages=${body.pages}`);
	assert.ok(body.pageSize > 0, `pageSize=${body.pageSize}`);
	assert.equal(typeof body.freelist, "number");
	// 件数は dbInfo（ダッシュボードと同じ実装）から来る。
	assert.equal(body.cards, 2, `cards=${body.cards}`);
	assert.ok(body.bytes > 0, `bytes=${body.bytes}`);
	assert.equal(typeof body.file, "string");
});

// --- VACUUM ------------------------------------------------------------------
await check("POST /api/db/vacuum -> 200 / after <= before / カードが残る", async () => {
	const r = await tf(`${BASE}/api/db/vacuum`, { method: "POST" });
	assert.equal(r.status, 200);
	const body = await r.json();
	assert.equal(body.ok, true, JSON.stringify(body));
	assert.ok(body.before > 0, `before=${body.before}`);
	assert.ok(body.after <= body.before, `after=${body.after} before=${body.before}`);
	assert.equal(body.saved, body.before - body.after);
	assert.equal(body.cards, 2, `cards=${body.cards}`);
	assert.deepEqual(
		readBoardAt(GLOBAL).cards.map((c) => c.text),
		["a", "b"],
		"VACUUM でカードが消えた",
	);
});

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
// poll timer は session_start を踏んでいないので未生成。HTTP サーバだけが残るので明示終了。
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
