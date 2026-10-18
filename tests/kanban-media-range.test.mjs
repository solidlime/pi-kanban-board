// /api/media の HTTP Range 対応と、/serve との共通コア化を固定する自己検証。
// フレームワーク無しで `node tests/kanban-media-range.test.mjs`。HOME と KANBAN_PORT を
// 差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer as netServer } from "node:net";
import http from "node:http";
import { createRequire } from "node:module";

const HOME_DIR = "/tmp/kb-media-range-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/media`, { recursive: true });
mkdirSync(`${HOME_DIR}/workspace/site`, { recursive: true });
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
function check(name, fn) {
	try {
		fn();
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
for (let i = 0; i < 40; i++) {
	try {
		if ((await fetch(`http://127.0.0.1:${PORT}/api/kanban`)).ok) break;
	} catch {
		// まだ listen していない
	}
	await new Promise((r) => setTimeout(r, 100));
}

const base = `http://127.0.0.1:${PORT}`;
const CONTENT = "0123456789abcdefghijklmnopqrstuv"; // 32 bytes
writeFileSync(`${HOME_DIR}/.pi/kanban/media/clip.png`, CONTENT);
const MEDIA_URL = `${base}/api/media/clip.png`;

// --- 1: bytes=0-3 -> 206 + Content-Range + 4 bytes ----------------------------
{
	const res = await fetch(MEDIA_URL, { headers: { Range: "bytes=0-3" } });
	const body = await res.text();
	check("media bytes=0-3 は 206 + Content-Range + 4 バイト", () => {
		assert.equal(res.status, 206);
		assert.equal(res.headers.get("content-range"), `bytes 0-3/${CONTENT.length}`);
		assert.equal(body, "0123");
	});
	check("media 206 に Accept-Ranges: bytes", () =>
		assert.equal(res.headers.get("accept-ranges"), "bytes"));
}

// --- 2: bytes=5- -> 206 で末尾まで -------------------------------------------
{
	const res = await fetch(MEDIA_URL, { headers: { Range: "bytes=5-" } });
	const body = await res.text();
	check("media bytes=5- は 206 + 末尾まで", () => {
		assert.equal(res.status, 206);
		assert.equal(res.headers.get("content-range"), `bytes 5-${CONTENT.length - 1}/${CONTENT.length}`);
		assert.equal(body, CONTENT.slice(5));
	});
}

// --- 3: 範囲外 -> 416 + bytes */size -----------------------------------------
{
	const res = await fetch(MEDIA_URL, { headers: { Range: "bytes=999999-" } });
	check("media 範囲外は 416 + Content-Range: bytes */size", () => {
		assert.equal(res.status, 416);
		assert.equal(res.headers.get("content-range"), `bytes */${CONTENT.length}`);
	});
	check("media 416 に Accept-Ranges: bytes", () =>
		assert.equal(res.headers.get("accept-ranges"), "bytes"));
}

// --- 4: Accept-Ranges は 200 にも付く -----------------------------------------
{
	const res = await fetch(MEDIA_URL);
	check("media 200 に Accept-Ranges: bytes", () => {
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("accept-ranges"), "bytes");
	});
}

// --- 6: Range 無し 200 の Content-Type / Cache-Control が従来通り -------------
{
	const res = await fetch(MEDIA_URL);
	check("media 200 の Content-Type は image/png", () =>
		assert.equal(res.headers.get("content-type"), "image/png"));
	check("media 200 の Cache-Control は no-store（従来維持）", () =>
		assert.equal(res.headers.get("cache-control"), "no-store"));
}

// --- 5: HEAD が 405 でない ----------------------------------------------------
{
	const res = await fetch(MEDIA_URL, { method: "HEAD" });
	const body = await res.text();
	check("media HEAD は 405 でない (200) + Accept-Ranges + Content-Length", () => {
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("accept-ranges"), "bytes");
		assert.equal(res.headers.get("content-length"), String(CONTENT.length));
		assert.equal(body, "");
	});
}
{
	const res = await fetch(MEDIA_URL, { method: "HEAD", headers: { Range: "bytes=0-3" } });
	check("media HEAD + Range は 206 ヘッダのみ", () => {
		assert.equal(res.status, 206);
		assert.equal(res.headers.get("content-range"), `bytes 0-3/${CONTENT.length}`);
	});
}

// --- 7/8: /serve も同じコアを通り、Range と B4 Cache-Control が退行しない ------
const serve = tools.get("serve");
assert.ok(serve, "serve ツールが registerTool されている");
const call = (args) => serve.execute("t", args, null, () => {});
writeFileSync(`${HOME_DIR}/workspace/site/clip.txt`, CONTENT);
writeFileSync(`${HOME_DIR}/workspace/site/data.json`, '{"a":1}');
const add = await call({ action: "add", path: `${HOME_DIR}/workspace/site` });
const id = add.details.id;
{
	const res = await fetch(`${base}/serve/${id}/clip.txt`, { headers: { Range: "bytes=0-3" } });
	const body = await res.text();
	check("serve 共通化後も 206 + Content-Range", () => {
		assert.equal(res.status, 206);
		assert.equal(res.headers.get("content-range"), `bytes 0-3/${CONTENT.length}`);
		assert.equal(body, "0123");
		assert.equal(res.headers.get("accept-ranges"), "bytes");
	});
}
{
	const res = await fetch(`${base}/serve/${id}/clip.txt`, { headers: { Range: "bytes=999999-" } });
	check("serve 416 も退行しない", () => {
		assert.equal(res.status, 416);
		assert.equal(res.headers.get("content-range"), `bytes */${CONTENT.length}`);
		assert.equal(res.headers.get("accept-ranges"), "bytes");
	});
}
{
	const json = await fetch(`${base}/serve/${id}/data.json`);
	const txt = await fetch(`${base}/serve/${id}/clip.txt`);
	check("serve B4: .json は no-store", () => assert.equal(json.headers.get("cache-control"), "no-store"));
	check("serve B4: 非 HTML/JSON は max-age", () =>
		assert.match(txt.headers.get("cache-control"), /max-age/));
}

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
