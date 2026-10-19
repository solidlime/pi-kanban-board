// kanban serve (ローカルパス HTTP 配信) の自己検証。フレームワーク無しで
// `node tests/kanban-serve.test.mjs`。HOME と KANBAN_PORT を差し替えるので本番の
// ~/.pi/kanban と 8789 には触れない。D の7項目 + B1/B2/B4/B6/A4/A9 を実測で固定する。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as netServer } from "node:net";
import http from "node:http";
import { createRequire } from "node:module";
import { resolve as resolvePath } from "node:path";
import { authFetch, tokenHeader } from "./helpers/token.mjs";

// #83b: HTTP routes need the server token now; tf = fetch + the kb_token cookie.
const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-serve-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
mkdirSync(`${HOME_DIR}/workspace/site/segments`, { recursive: true });
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

// --- server 起動（このテスト専用ポート） --------------------------------------
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

const serve = tools.get("serve");
assert.ok(serve, "serve ツールが registerTool されている");
const call = (args) => serve.execute("t", args, null, () => {});
const base = `http://127.0.0.1:${PORT}`;
const SITE = `${HOME_DIR}/workspace/site`;

// 生のパスを送る (fetch は URL を正規化して `..` を消してしまう)
function rawGet(path, extraHeaders = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ host: "127.0.0.1", port: PORT, path, method: "GET", headers: { Cookie: tokenHeader(), ...extraHeaders } },
			(res) => {
				let body = "";
				res.on("data", (c) => (body += c));
				res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
			},
		);
		req.on("error", reject);
		req.end();
	});
}

const CONTENT = "0123456789abcdefghijklmnopqrstuv"; // 32 bytes
writeFileSync(`${SITE}/segments/clip.txt`, CONTENT);

// --- D1 / A3 / A4 / C1: add が URL を返し、再登録で同じ URL ---------------------
const add = await call({ action: "add", path: SITE });
const id = add.details.id;
const reAdd = await call({ action: "add", path: SITE });
check("D1 add が成功し URL を返す", () => {
	assert.equal(add.details.ok, true, JSON.stringify(add.details));
	assert.match(add.content[0].text, new RegExp(`^http://[^/]+:${PORT}/serve/[0-9a-f]{16}/$`));
	assert.equal(add.content[0].text, add.details.url);
});
check("A4 同じパスの再登録は同じ id/URL", () => {
	assert.equal(reAdd.details.id, id);
});
check("id は sha256(absPath) の先頭16hex", () =>
	assert.equal(id, createHash("sha256").update(SITE).digest("hex").slice(0, 16)));

// --- C2: 失敗は成功と区別できる ------------------------------------------------
const badAdd = await call({ action: "add", path: `${HOME_DIR}/workspace/does-not-exist` });
check("C2 存在しないパスは isError で返る", () => {
	assert.equal(badAdd.isError, true);
	assert.equal(badAdd.details.ok, false);
});

// --- D5 / A10: allowlist 外は 403 ---------------------------------------------
mkdirSync(`${HOME_DIR}/.hidden-dir`, { recursive: true });
const denied = await call({ action: "add", path: `${HOME_DIR}/.hidden-dir` });
check("D5 allowlist 外の登録は 403 + isError", () => {
	assert.equal(denied.details.ok, false);
	assert.equal(denied.details.status, 403, JSON.stringify(denied.details));
	assert.equal(denied.isError, true);
});

// --- D2 / A7: index.html の無いディレクトリは一覧が出る ------------------------
{
	const res = await tf(`${base}/serve/${id}/`);
	const html = await res.text();
	check("D2 一覧 HTML が 200 で返る", () => assert.equal(res.status, 200));
	check("D2 一覧に segments/ が入る", () => {
		assert.match(html, /href="segments\/"/);
		assert.match(res.headers.get("content-type"), /^text\/html/);
	});
}
// A7: index.html があればそれを返す
mkdirSync(`${SITE}/withindex`, { recursive: true });
writeFileSync(`${SITE}/withindex/index.html`, "<h1>INDEX</h1>");
{
	const res = await tf(`${base}/serve/${id}/withindex/`);
	const html = await res.text();
	check("A7 index.html があればそれを返す", () => {
		assert.equal(res.status, 200);
		assert.equal(html, "<h1>INDEX</h1>");
	});
}
// A7: /serve/<id> はディレクトリなら末尾スラッシュへリダイレクト
{
	const res = await tf(`${base}/serve/${id}`, { redirect: "manual" });
	check("A7 /serve/<id> は 301 で末尾スラッシュへ", () => {
		assert.equal(res.status, 301);
		assert.equal(res.headers.get("location"), `/serve/${id}/`);
	});
}

// --- D3 / B1: Range -----------------------------------------------------------
{
	const res = await tf(`${base}/serve/${id}/segments/clip.txt`, {
		headers: { Range: "bytes=0-3" },
	});
	const body = await res.text();
	check("D3 bytes=0-3 は 206 + Content-Range", () => {
		assert.equal(res.status, 206);
		assert.equal(res.headers.get("content-range"), `bytes 0-3/${CONTENT.length}`);
		assert.equal(res.headers.get("accept-ranges"), "bytes");
		assert.equal(body, "0123");
	});
}
{
	const res = await tf(`${base}/serve/${id}/segments/clip.txt`, {
		headers: { Range: "bytes=5-" },
	});
	const body = await res.text();
	check("D3 bytes=5- は 206 + 末尾まで", () => {
		assert.equal(res.status, 206);
		assert.equal(res.headers.get("content-range"), `bytes 5-${CONTENT.length - 1}/${CONTENT.length}`);
		assert.equal(body, CONTENT.slice(5));
	});
}
{
	const res = await tf(`${base}/serve/${id}/segments/clip.txt`, {
		headers: { Range: "bytes=100-200" },
	});
	check("D3 範囲外は 416 + bytes */size", () => {
		assert.equal(res.status, 416);
		assert.equal(res.headers.get("content-range"), `bytes */${CONTENT.length}`);
	});
}
{
	const res = await tf(`${base}/serve/${id}/segments/clip.txt`, {
		headers: { Range: "bytes=-4" },
	});
	const body = await res.text();
	check("B1 bytes=-4 は末尾4バイト", () => {
		assert.equal(res.status, 206);
		assert.equal(body, CONTENT.slice(-4));
	});
}

// --- B4: Cache-Control --------------------------------------------------------
{
	writeFileSync(`${SITE}/segments/data.json`, '{"a":1}');
	const res = await tf(`${base}/serve/${id}/segments/data.json`);
	check("B4 .json は no-store", () => assert.equal(res.headers.get("cache-control"), "no-store"));
	const html = await tf(`${base}/serve/${id}/`);
	check("B4 HTML 一覧は no-store", () => assert.equal(html.headers.get("cache-control"), "no-store"));
	const mp4 = await tf(`${base}/serve/${id}/segments/clip.txt`);
	check("B4 非 HTML/JSON は max-age", () => assert.match(mp4.headers.get("cache-control"), /max-age/));
	check("B3 text/plain に charset", () =>
		assert.equal(mp4.headers.get("content-type"), "text/plain; charset=utf-8"));
}

// --- B6: HEAD は 405 でない ---------------------------------------------------
{
	const res = await tf(`${base}/serve/${id}/segments/clip.txt`, { method: "HEAD" });
	check("B6 HEAD は 200 (405 でない)", () => {
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("accept-ranges"), "bytes");
		assert.equal(res.headers.get("content-length"), String(CONTENT.length));
	});
}

// --- D4 / B2: パストラバーサル -------------------------------------------------
{
	// `new URL` eats a bare `../`, so the reachable traversal vector is an encoded
	// separator; a literal `..` is normalized away before it reaches the handler.
	const res = await tf(`${base}/serve/${id}/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc/passwd`);
	check("D4 エンコードされた .. は 403", () =>
		assert.equal(res.status, 403, `${res.status} body=${res.statusText}`));
	const raw = await rawGet(`/serve/${id}/../serve.json`);
	check("D4 生の .. は 403/404", () => assert.ok([403, 404].includes(raw.status), `got ${raw.status}`));
}
{
	symlinkSync(HOME_DIR, `${SITE}/escape`);
	const res = await tf(`${base}/serve/${id}/escape/.hidden-dir/`);
	check("B2 シンボリックリンク脱出は 403", () => assert.equal(res.status, 403));
	const res2 = await tf(`${base}/serve/${id}/escape/`);
	check("B2 外を指すシンボリックリンク自体も 403", () => assert.equal(res2.status, 403));
}

// --- D6 / A2: 参照であってコピーでない ----------------------------------------
{
	writeFileSync(`${SITE}/segments/after.txt`, "added later");
	const got = await tf(`${base}/serve/${id}/segments/after.txt`);
	const body = await got.text();
	check("D6 登録後に足したファイルが同じ URL で取れる", () => {
		assert.equal(got.status, 200);
		assert.equal(body, "added later");
	});
}

// --- D7 / A7b: ディレクトリ一覧 JSON ------------------------------------------
{
	const res = await tf(`${base}/serve/${id}/segments/?list=json`);
	const list = await res.json();
	check("D7 ?list=json は JSON 配列", () => {
		assert.equal(res.status, 200);
		assert.match(res.headers.get("content-type"), /^application\/json/);
		assert.ok(Array.isArray(list), `not an array: ${JSON.stringify(list)}`);
	});
	const after = list.find((e) => e.name === "after.txt");
	check("D7 JSON 一覧に追加ファイルが入る (name/type/size/mtime)", () => {
		assert.ok(after, `after.txt missing: ${JSON.stringify(list)}`);
		assert.equal(after.type, "file");
		assert.equal(after.size, "added later".length);
		assert.equal(typeof after.mtime, "number");
	});
	const rootList = await (await tf(`${base}/serve/${id}/?list=json`)).json();
	check("D7 JSON 一覧にディレクトリ種別が入る", () => {
		assert.ok(rootList.some((e) => e.type === "dir"), JSON.stringify(rootList));
	});
	const accept = await tf(`${base}/serve/${id}/segments/`, {
		headers: { Accept: "application/json" },
	});
	const acceptList = await accept.json();
	check("D7 Accept: application/json でも JSON", () => assert.ok(Array.isArray(acceptList)));
}

// --- A5 / A6 / C3 / A8 / A9: ツールの list/remove と登録一覧ページ ------------
{
	const listed = await call({ action: "list" });
	check("A5 list に登録が入る", () => {
		assert.equal(listed.details.ok, true);
		assert.ok(listed.details.entries.some((e) => e.id === id), JSON.stringify(listed.details));
	});
	const page = await tf(`${base}/serve`);
	const html = await page.text();
	check("A8 /serve の一覧ページに id が出る", () => {
		assert.equal(page.status, 200);
		assert.match(html, new RegExp(id));
	});
	// A9: ディスクから消したパスは一覧から外れる
	const goneDir = `${HOME_DIR}/workspace/gone`;
	mkdirSync(goneDir, { recursive: true });
	const goneAdd = await call({ action: "add", path: goneDir });
	rmSync(goneDir, { recursive: true, force: true });
	const page2 = await (await tf(`${base}/serve`)).text();
	check("A9 消えたパスは一覧に出ない", () => assert.doesNotMatch(page2, new RegExp(goneAdd.details.id)));
	const listed2 = await call({ action: "list" });
	check("A9 list からも消える", () =>
		assert.ok(!listed2.details.entries.some((e) => e.id === goneAdd.details.id)));
	// A6: id でもパスでも解除できる
	const rmById = await call({ action: "remove", id });
	check("A6 remove(id) が成功", () => assert.equal(rmById.details.ok, true));
	const missing = await call({ action: "remove", id });
	check("A6/C2 未登録の remove は isError", () => {
		assert.equal(missing.details.ok, false);
		assert.equal(missing.isError, true);
	});
	const rmByPath = await call({ action: "remove", path: `${HOME_DIR}/workspace/gone` });
	check("A6 remove(path) で消えたパスも解除できる", () => assert.equal(rmByPath.details.ok, true));
	const afterRemove = await tf(`${base}/serve/${id}/`);
	check("A6 解除後は 404", () => assert.equal(afterRemove.status, 404));
	// 元に戻して他テストと干渉させない
	await call({ action: "add", path: SITE });
}

// --- #34: 手書きの短い id も解除できる (id 完全一致 > path 分岐) ------------------
{
	// serveRemove() は以前 `/^[0-9a-f]{16}$/` で id か path かを判定していたので、
	// 16桁hex でない id は path 分岐に落ち serveIdFor(resolve("short1")) のハッシュに
	// 化けて「実在するのに解除できない」状態だった。#34 の修正後はレジストリ内の
	// 完全一致が常に勝つ。ここはレジストリに手書き id を直接置いて固定する。
	const registry = `${HOME_DIR}/.pi/kanban/serve.json`;
	const SHORT_ID = "short1";
	const before = JSON.parse(readFileSync(registry, "utf8"));
	writeFileSync(
		registry,
		JSON.stringify({ entries: [...before.entries, { id: SHORT_ID, path: SITE }] }, null, 2),
	);
	const hashOfShort = createHash("sha256").update(resolvePath(SHORT_ID)).digest("hex").slice(0, 16);
	check("#34 前提: short1 は 16桁hex でも path のハッシュでもない", () => {
		assert.doesNotMatch(SHORT_ID, /^[0-9a-f]{16}$/);
		assert.notEqual(SHORT_ID, hashOfShort);
	});
	const shortServed = await tf(`${base}/serve/${SHORT_ID}/segments/clip.txt`);
	check("#34 手書き id の URL は配信される", () => assert.equal(shortServed.status, 200));
	const shortRemove = await rawGet(`/api/serve?action=remove&id=${SHORT_ID}&sid=regress`);
	const shortBody = JSON.parse(shortRemove.body);
	check("#34 手書きの短い id は /api/serve?action=remove で解除できる", () => {
		assert.equal(shortRemove.status, 200, `got ${shortRemove.status} body=${shortRemove.body}`);
		assert.equal(shortBody.ok, true);
	});
	check("#34 解除されたのは short1 そのもの (path ハッシュではない)", () => {
		assert.equal(shortBody.id, SHORT_ID);
		assert.notEqual(shortBody.id, hashOfShort);
	});
	const shortAfter = await tf(`${base}/serve/${SHORT_ID}/segments/clip.txt`);
	check("#34 解除後は手書き id の URL が 404", () => assert.equal(shortAfter.status, 404));
	check("#34 レジストリからは short1 だけが消え、16桁hex の既存登録は残る", () => {
		const now = JSON.parse(readFileSync(registry, "utf8"));
		assert.ok(!now.entries.some((e) => e.id === SHORT_ID), JSON.stringify(now.entries));
		assert.ok(now.entries.some((e) => e.id === id), JSON.stringify(now.entries));
	});
}

// --- B5: 相対パスのフェッチが http 越しに成立 ---------------------------------
{
	const rel = await tf(`${base}/serve/${id}/segments/data.json`);
	const txt = await tf(`${base}/serve/${id}/segments/clip.txt`);
	check("B5 相対パス相当の http 取得が動く", () => {
		assert.equal(rel.status, 200);
		assert.equal(txt.status, 200);
	});
}

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
