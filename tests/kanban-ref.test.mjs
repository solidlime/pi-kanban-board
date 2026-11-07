// #56: カード添付の参照型（file:<絶対パス>）と /api/ref の自己検証。
// フレームワーク無しで `node tests/kanban-ref.test.mjs`。HOME と KANBAN_PORT を差し替える
// ので本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer as netServer } from "node:net";
import { createRequire } from "node:module";
import { authFetch } from "./helpers/token.mjs";
import { readBoardAt, seedBoard, useKanban } from "./helpers/board.mjs";
import { settleMigration, useMigrate } from "./helpers/migrate.mjs";

const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-ref-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/media`, { recursive: true });
// allowlist の既定は ~/workspace。inside はその中、outside は外。
mkdirSync(`${HOME_DIR}/workspace/pub`, { recursive: true });
mkdirSync(`${HOME_DIR}/outside`, { recursive: true });
process.env.HOME = HOME_DIR;
process.env.USERPROFILE = process.env.HOME;
// 上限は 1MB に下げて 413 を踏む（読み込み時に確定するので import より前に置く）。
const LIMIT = 1024 * 1024;
process.env.KANBAN_MEDIA_MAX_BYTES = String(LIMIT);

const PORT = await new Promise((r) => {
	const s = netServer();
	s.listen(0, "127.0.0.1", () => {
		const { port } = s.address();
		s.close(() => r(port));
	});
});
process.env.KANBAN_PORT = String(PORT);

const require = createRequire(import.meta.url);
const { createJiti } = require(
	process.env.KANBAN_JITI ?? createRequire(import.meta.url).resolve("jiti"),
);
const jiti = createJiti(import.meta.url);
const SRC = fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url));
const mod = await jiti.import(SRC);
useKanban(mod);
useMigrate(mod);
await settleMigration();

const failures = [];
let passed = 0;
function check(name, fn) {
	try {
		fn();
		passed += 1;
	} catch (err) {
		failures.push(`${name}: ${err.message}`);
	}
}

const MEDIA = `${HOME_DIR}/.pi/kanban/media`;
const boardFile = `${HOME_DIR}/.pi/kanban/projects/${mod.projectSlugOf(process.cwd())}.json`;
const imgOf = (id) => readBoardAt(boardFile).cards.find((c) => c.id === id)?.img;
seedBoard(boardFile, { cards: [{ id: 7, text: "a", col: "todo" }], nextId: 90 });

const commands = new Map();
const tools = new Map();
const pi = {
	registerCommand(name, def) {
		commands.set(name, def);
	},
	registerTool(def) {
		tools.set(def.name, def);
	},
	appendEntry() {},
	on() {},
	sendUserMessage() {},
};
mod.default(pi);
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 40; i++) {
	try {
		if ((await tf(`${base}/api/kanban`)).ok) break;
	} catch {
		// まだ listen していない
	}
	await new Promise((r) => setTimeout(r, 100));
}

// 実体を先に置く（allowlist は realpath で判定される）。
const HTML_ABS = resolve(HOME_DIR, "workspace/pub/page.html");
const PNG_ABS = resolve(HOME_DIR, "workspace/pub/pic.png");
const TXT_ABS = resolve(HOME_DIR, "workspace/pub/note.txt");
const OUT_ABS = resolve(HOME_DIR, "outside/secret.html");
const BIG_ABS = resolve(HOME_DIR, "workspace/pub/big.png");
const MISSING_ABS = resolve(HOME_DIR, "workspace/pub/nope.html");
writeFileSync(HTML_ABS, "<!doctype html><h1>ref</h1>");
writeFileSync(PNG_ABS, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
writeFileSync(TXT_ABS, "plain");
writeFileSync(OUT_ABS, "<h1>secret</h1>");
writeFileSync(BIG_ABS, Buffer.alloc(LIMIT + 1, 0x41));

const refUrl = (abs) => `${base}/api/ref?f=${encodeURIComponent(abs)}`;

// --- 1: allowlist 内の html は sandbox CSP + inline で返る ---------------------
{
	const res = await tf(refUrl(HTML_ABS));
	const body = await res.text();
	check("#56 ref: allowlist 内の html は 200 + text/html", () => {
		assert.equal(res.status, 200, `status=${res.status}`);
		assert.match(res.headers.get("content-type") ?? "", /^text\/html/);
		assert.equal(body.includes("ref"), true);
	});
	check("#56 ref: html は CSP sandbox + inline + X-Frame-Options 無し", () => {
		assert.equal(res.headers.get("content-security-policy"), "sandbox allow-scripts allow-forms");
		assert.equal(res.headers.get("content-disposition"), "inline");
		assert.equal(res.headers.get("x-frame-options"), null);
	});
}

// --- 2: 画像は拡張子どおりの MIME、CSP は付かない -----------------------------
{
	const res = await tf(refUrl(PNG_ABS));
	await res.arrayBuffer();
	check("#56 ref: png は image/png、CSP 無し", () => {
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("content-type"), "image/png");
		assert.equal(res.headers.get("content-security-policy"), null);
	});
}

// --- 3: 未登録拡張子は application/octet-stream -------------------------------
{
	const res = await tf(refUrl(TXT_ABS));
	await res.arrayBuffer();
	check("#56 ref: 未登録拡張子は application/octet-stream", () => {
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("content-type"), "application/octet-stream");
	});
}

// --- 4: allowlist 外は 403（既存の文面を踏襲） --------------------------------
{
	const res = await tf(refUrl(OUT_ABS));
	const body = await res.json();
	check("#56 ref: allowlist 外は 403 outside the serve allowlist", () => {
		assert.equal(res.status, 403);
		assert.match(body.error, /outside the serve allowlist/);
	});
}

// --- 5: allowlist 内でも実体が無ければ 404 -----------------------------------
{
	const res = await tf(refUrl(MISSING_ABS));
	check("#56 ref: 存在しないファイルは 404", () => assert.equal(res.status, 404));
}

// --- 6: 上限超過は 413 -------------------------------------------------------
{
	const res = await tf(refUrl(BIG_ABS));
	check("#56 ref: KANBAN_MEDIA_MAX_BYTES 超過は 413", () => assert.equal(res.status, 413));
}

// --- 7: tool ref -> card.img に file:<abs> を csv 追記（コピーしない） --------
const tool = tools.get("kanban");
assert.ok(tool, "kanban ツールが登録されている");
const SID = "s-ref-test";
const ctx = {
	hasUI: false,
	isIdle: () => true,
	ui: { notify() {}, setWidget() {} },
	sessionManager: { getSessionId: () => SID, getEntries: () => [] },
};
const runTool = (params) => tool.execute("c", { scope: "project", ...params }, undefined, undefined, ctx);
{
	const before = (imgOf(7) ?? "").split(",").filter(Boolean);
	const r = await runTool({ action: "ref", id: 7, image: HTML_ABS });
	check("#56 tool ref: 成功を返す", () => assert.equal(r.isError, undefined, r.content[0].text));
	check("#56 tool ref: card.img に file:<abs> が追記される", () => {
		const now = (imgOf(7) ?? "").split(",").filter(Boolean);
		assert.equal(now.length, before.length + 1);
		assert.equal(now[now.length - 1], `file:${HTML_ABS}`);
	});
	check("#56 tool ref: media/ にコピーしない", () => {
		const names = readdirSync(MEDIA).filter((n) => !n.startsWith("."));
		assert.equal(names.includes("page.html"), false, names.join(","));
	});
}
{
	const r = await runTool({ action: "ref", id: 7, image: PNG_ABS });
	check("#56 tool ref: 2連続で csv が伸びる", () => {
		assert.equal(r.isError, undefined, r.content[0].text);
		const now = (imgOf(7) ?? "").split(",").filter(Boolean);
		assert.equal(now.filter((e) => e.startsWith("file:")).length, 2);
		assert.equal(now[now.length - 1], `file:${PNG_ABS}`);
	});
}
{
	const r = await runTool({ action: "ref", id: 7, image: OUT_ABS });
	check("#56 tool ref: allowlist 外はエラーで書き込まない", () => {
		assert.equal(r.isError, true);
		assert.match(r.content[0].text, /allowlist/);
		assert.equal((imgOf(7) ?? "").includes("secret"), false);
	});
}
{
	const before = imgOf(7);
	const r = await runTool({ action: "ref", id: 7, image: MISSING_ABS });
	check("#56 tool ref: 存在しないパスはエラーで書き込まない", () => {
		assert.equal(r.isError, true);
		assert.equal(imgOf(7), before);
	});
}

// --- 8: 削除時に参照型エントリで media/ を触らない ---------------------------
{
	const res = await tf(`${base}/api/remove?scope=project&id=7`);
	check("#56 remove: 参照型だけのカードも削除できる", () => assert.equal(res.status, 200));
	check("#56 remove: 参照先のファイルは消えない", () => assert.ok(readdirSync(`${HOME_DIR}/workspace/pub`).includes("page.html")));
}

console.log(`${passed} passed, ${failures.length} failed`);
for (const f of failures) console.error(`  FAIL ${f}`);
// The 8789 listener keeps the loop alive; close it by hand like the other HTTP tests.
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
