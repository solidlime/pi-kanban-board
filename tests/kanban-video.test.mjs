// 動画アップロード（mp4/webm）と 8MB/64MB の拡張子別上限、動画の配信を固定する自己検証。
// フレームワーク無しで `node tests/kanban-video.test.mjs`。HOME と KANBAN_PORT を
// 差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as netServer } from "node:net";
import http from "node:http";
import { createRequire } from "node:module";
import { authFetch, tokenHeader } from "./helpers/token.mjs";

// #83b: HTTP routes need the server token now; tf = fetch + the kb_auth cookie.
const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-video-home";
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
		if ((await tf(`http://127.0.0.1:${PORT}/api/kanban`)).ok) break;
	} catch {
		// まだ listen していない
	}
	await new Promise((r) => setTimeout(r, 100));
}

const base = `http://127.0.0.1:${PORT}`;

/** Raw POST: the server answers 413 before the whole body lands, so write errors are ignored. */
function post(path, body) {
	return new Promise((resolve) => {
		const req = http.request(
			{
				host: "127.0.0.1",
				port: PORT,
				path,
				method: "POST",
				headers: { "content-length": body.length, Cookie: tokenHeader() },
			},
			(res) => {
				let data = "";
				res.on("data", (d) => {
					data += d;
				});
				res.on("end", () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
			},
		);
		req.on("error", () => {}); // 413 mid-stream: the response matters, not the write
		req.write(body);
		req.end();
	});
}

const MB = 1024 * 1024;

// --- 1: mp4 は 8MB 超（9MB）でも 200 ------------------------------------------
{
	const res = await post("/api/upload?scope=global&ext=mp4", Buffer.alloc(9 * MB, 0x11));
	let card;
	try {
		card = JSON.parse(res.body).card;
	} catch {
		card = undefined;
	}
	check("mp4 9MB のアップロードは 200", () =>
		assert.equal(res.status, 200, `status=${res.status} body=${res.body.slice(0, 200)}`));
	check("mp4 9MB のカードは .mp4 を指す", () => assert.match(card.img, /\.mp4$/));
	check("mp4 の新規カード text は (video)", () => assert.equal(card.text, `#${card.id} (video)`));
}

// --- 2: webm も 200 ----------------------------------------------------------
{
	const res = await post("/api/upload?scope=global&ext=webm", Buffer.alloc(9 * MB, 0x12));
	const card = res.status === 200 ? JSON.parse(res.body).card : undefined;
	check("webm 9MB のアップロードは 200", () =>
		assert.equal(res.status, 200, `status=${res.status} body=${res.body.slice(0, 200)}`));
	check("webm 9MB のカードは .webm を指す", () => assert.match(card.img, /\.webm$/));
}

// --- 3: 画像は 9MB で 413（8MB 上限が変わっていない） -------------------------
{
	const res = await post("/api/upload?scope=global&ext=png", Buffer.alloc(9 * MB, 0x13));
	check("png 9MB は 413（画像の上限は 8MB のまま）", () =>
		assert.equal(res.status, 413, `status=${res.status} body=${res.body.slice(0, 200)}`));
	check("png の 413 文言に 8MB が出る", () => assert.match(res.body, /8MB/));
}

// --- 4: 動画は 65MB で 413（64MB 上限） --------------------------------------
{
	const res = await post("/api/upload?scope=global&ext=mp4", Buffer.alloc(65 * MB, 0x14));
	check("mp4 65MB は 413（動画の上限は 64MB）", () =>
		assert.equal(res.status, 413, `status=${res.status} body=${res.body.slice(0, 200)}`));
	check("mp4 の 413 文言に 64MB が出る", () => assert.match(res.body, /64MB/));
}

// --- 5: 未知拡張子は 415 のまま -----------------------------------------------
{
	const res = await post("/api/upload?scope=global&ext=exe", Buffer.alloc(16, 0x15));
	check(".exe は 415 のまま", () =>
		assert.equal(res.status, 415, `status=${res.status} body=${res.body.slice(0, 200)}`));
}

// --- 6/7: /api/media の動画 Content-Type と Range -----------------------------
const CLIP = "0123456789abcdefghijklmnopqrstuv"; // 32 bytes
writeFileSync(`${HOME_DIR}/.pi/kanban/media/clip.mp4`, CLIP);
const MEDIA_URL = `${base}/api/media/clip.mp4`;
{
	const res = await tf(MEDIA_URL);
	check("media の mp4 は Content-Type: video/mp4", () =>
		assert.equal(res.headers.get("content-type"), "video/mp4"));
}
{
	const res = await tf(MEDIA_URL, { headers: { Range: "bytes=0-3" } });
	const body = await res.text();
	check("media の mp4 は Range で 206 + Content-Range", () => {
		assert.equal(res.status, 206);
		assert.equal(res.headers.get("content-range"), `bytes 0-3/${CLIP.length}`);
		assert.equal(body, "0123");
	});
}
writeFileSync(`${HOME_DIR}/.pi/kanban/media/clip.webm`, CLIP);
{
	const res = await tf(`${base}/api/media/clip.webm`);
	check("media の webm は Content-Type: video/webm", () =>
		assert.equal(res.headers.get("content-type"), "video/webm"));
}

// --- 8: /serve の配信でも動画の Content-Type が正しい --------------------------
const serve = tools.get("serve");
assert.ok(serve, "serve ツールが registerTool されている");
const call = (args) => serve.execute("t", args, null, () => {});
writeFileSync(`${HOME_DIR}/workspace/site/clip.mp4`, CLIP);
const add = await call({ action: "add", path: `${HOME_DIR}/workspace/site` });
const serveId = add.details.id;
{
	const res = await tf(`${base}/serve/${serveId}/clip.mp4`);
	check("serve の mp4 は Content-Type: video/mp4", () =>
		assert.equal(res.headers.get("content-type"), "video/mp4"));
	check("serve の mp4 も Accept-Ranges: bytes（B1 退行なし）", () =>
		assert.equal(res.headers.get("accept-ranges"), "bytes"));
}
{
	const res = await tf(`${base}/serve/${serveId}/clip.mp4`, { headers: { Range: "bytes=4-7" } });
	const body = await res.text();
	check("serve の mp4 も Range で 206", () => {
		assert.equal(res.status, 206);
		assert.equal(res.headers.get("content-range"), `bytes 4-7/${CLIP.length}`);
		assert.equal(body, "4567");
	});
}

// --- 10: dashboard の描画分岐（静的検証。 #84 でテンプレートは 1 枚） ---------
{
	const src = readFileSync(SRC, "utf8");
	check("動画は <video> 要素で描画する（img では再生できない）", () =>
		assert.match(src, /createElement\("video"\)/));
	check("<video> に controls / preload=metadata が付き、autoplay は無い", () => {
		const block = (src.match(/im = document\.createElement\("video"\);[\s\S]{0,200}/) ?? [""])[0];
		assert.ok(block.length > 0, "video 生成ブロックが無い");
		assert.match(block, /im\.controls = true/);
		assert.match(block, /im\.preload = "metadata"/);
		assert.ok(!/autoplay/i.test(block), `autoplay が付いている: ${block}`);
	});
	check("<img> 経路も残っている（画像は今のまま）", () =>
		assert.match(src, /createElement\("img"\)/));
	check("動画の拡張子分岐が mp4/webm を見ている", () => {
		assert.match(src, /mediaExt === "mp4" \|\| mediaExt === "webm"/);
	});
}

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
