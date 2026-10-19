// #66-security 止血3点の回帰テスト。HOME と KANBAN_PORT を差し替えるので
// 本番の ~/.pi/kanban と 8789 には触れない。
//   (c) 既定 allowlist から KANBAN_DIR を外した（明示追加なら従来通り）
//   (d) GET /api/serve?del=1 は実ファイルを消さない
//   (e) selftest の detail に sid を出さない
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as netServer } from "node:net";
import { createRequire } from "node:module";
import { authFetch } from "./helpers/token.mjs";

// #83b: HTTP routes need the server token now; tf = fetch + the kb_token cookie.
const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-security-home";
rmSync(HOME_DIR, { recursive: true, force: true });
const KANBAN_DIR = `${HOME_DIR}/.pi/kanban`;
const WORKSPACE = `${HOME_DIR}/workspace`;
mkdirSync(`${KANBAN_DIR}/sessions`, { recursive: true });
mkdirSync(WORKSPACE, { recursive: true });
process.env.HOME = HOME_DIR;

const PORT = await new Promise((resolve) => {
	const s = netServer();
	s.listen(0, "127.0.0.1", () => {
		const { port } = s.address();
		s.close(() => resolve(port));
	});
});
process.env.KANBAN_PORT = String(PORT);

const require = createRequire(import.meta.url);
const { createJiti } = require(
	"/root/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.cjs",
);
const jiti = createJiti(import.meta.url);
const SRC = new URL("../extensions/kanban.ts", import.meta.url).pathname;
const mod = await jiti.import(SRC);

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

const tools = new Map();
const pi = {
	registerCommand() {},
	registerTool(def) {
		tools.set(def.name, def);
	},
	appendEntry() {},
	on() {},
	sendUserMessage() {},
};
mod.default(pi);

const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 60; i++) {
	try {
		if ((await tf(`${base}/api/kanban`)).ok) break;
	} catch {
		// まだ listen していない
	}
	await new Promise((r) => setTimeout(r, 100));
}

const serve = tools.get("serve");
assert.ok(serve, "serve ツールが registerTool されている");
const call = (args) => serve.execute("t", args, null, () => {});
const ALLOW_JSON = `${KANBAN_DIR}/serve-allow.json`;

// --- (c) KANBAN_DIR は既定 allowlist ではない -------------------------------
const globalJson = `${KANBAN_DIR}/global.json`;
writeFileSync(globalJson, JSON.stringify({ cards: [], nextId: 1 }));
const boardDir = await call({ action: "add", path: KANBAN_DIR });
const sessionsDir = await call({ action: "add", path: `${KANBAN_DIR}/sessions` });
const workspaceAdd = await call({ action: "add", path: WORKSPACE });

await check("(c) 既定 allowlist は ~/workspace のみ: ~/.pi/kanban は 403", () => {
	assert.equal(boardDir.isError, true, JSON.stringify(boardDir.details));
	assert.equal(boardDir.details.status, 403, JSON.stringify(boardDir.details));
	assert.equal(sessionsDir.details.status, 403, JSON.stringify(sessionsDir.details));
});
await check("(c) ~/workspace は従来通り登録できる", () => {
	assert.ok(workspaceAdd.details.id, JSON.stringify(workspaceAdd.details));
});
await check("(c) serve-allow.json で明示すれば ~/.pi/kanban も配信できる", async () => {
	writeFileSync(ALLOW_JSON, JSON.stringify({ roots: [KANBAN_DIR] }));
	const added = await call({ action: "add", path: KANBAN_DIR });
	assert.ok(added.details.id, JSON.stringify(added.details));
	assert.match(added.content[0].text, /\/serve\/[0-9a-f]{16}\/$/);
	const body = await (await tf(`${base}/serve/${added.details.id}/global.json`)).text();
	assert.match(body, /"cards"/, `配信内容: ${body}`);
	rmSync(ALLOW_JSON, { force: true });
});

// --- (d) del=1 は実ファイルを消さない ---------------------------------------
{
	writeFileSync(ALLOW_JSON, JSON.stringify({ roots: [WORKSPACE] }));
	const keep = `${WORKSPACE}/keep.html`;
	writeFileSync(keep, "<h1>keep</h1>");
	const added = await call({ action: "add", path: keep });
	assert.ok(added.details.id, JSON.stringify(added.details));
	const id = added.details.id;

	const res = await tf(`${base}/api/serve?action=remove&id=${id}&del=1`);
	await check("(d) GET /api/serve?del=1 は登録解除だけ行う（200）", () => {
		assert.equal(res.status, 200);
	});
	await check("(d) del=1 でも実ファイルは残る", () => {
		assert.ok(existsSync(keep), "HTTP GET 経由でファイルが消えた");
		assert.match(readFileSync(keep, "utf8"), /keep/);
	});
	await check("(d) 登録は外れている（/serve/<id>/ は 404）", async () => {
		const after = await tf(`${base}/serve/${id}/keep.html`);
		assert.equal(after.status, 404);
	});
}

// --- (e) selftest は sid を漏らさない ---------------------------------------
await check("(e) /api/selftest の detail に 32桁 hex の sid が無い", async () => {
	const j = await (await tf(`${base}/api/selftest`, { method: "POST" })).json();
	const detail = JSON.stringify(j.checks);
	assert.doesNotMatch(detail, /[0-9a-f]{32}/i, `sid らしき hex: ${detail}`);
});

console.log(`${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length === 0 ? 0 : 1);
