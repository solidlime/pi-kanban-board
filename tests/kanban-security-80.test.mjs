// #80-⑦（/serve レジストリから絶対パスを落とす）と #80-⑪（_inbox の名前・拡張子制限と
// MEDIA_DIR 総量上限）の自己検証。フレームワーク無しで `node tests/kanban-security-80.test.mjs`。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { createServer as netServer } from "node:net";
import http from "node:http";
import { createRequire } from "node:module";
import { authFetch, tokenHeader } from "./helpers/token.mjs";

const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-security-80-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
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
async function checkAsync(name, fn) {
	try {
		await fn();
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
const MEDIA = `${HOME_DIR}/.pi/kanban/media`;

/** http.request 直叩き。トークンは既定で付ける（#83b の gate を通すため）。 */
function send(method, path, { headers = {}, body } = {}) {
	if (!headers.Cookie && !headers.cookie) headers = { ...headers, Cookie: tokenHeader() };
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port: PORT, path, method, headers }, (res) => {
			let out = "";
			res.on("data", (c) => (out += c));
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
		});
		req.on("error", reject);
		if (body !== undefined) req.write(body);
		req.end();
	});
}

const add = await call({ action: "add", path: SITE });
const id = add.details.id;
assert.ok(id, `serve add が id を返す: ${JSON.stringify(add.details)}`);
writeFileSync(`${SITE}/x.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

// --- ⑦ 一覧応答に絶対パスが無い ------------------------------------------------
{
	const res = await tf(`${base}/api/dashboard`);
	const text = await res.text();
	const data = JSON.parse(text);
	await checkAsync("⑦ dashboard の応答に HOME 配下の絶対パスが現れない", async () =>
		assert.ok(!text.includes(HOME_DIR), `絶対パスが漏れている: ${text.slice(0, 200)}`));
	await checkAsync("⑦ serve 行に path フィールドが無い (#80-⑦)", async () => {
		const row = data.serve.find((x) => x.id === id);
		assert.ok(row, "登録した serve 行が無い");
		assert.equal(row.path, undefined, `path=${row.path}`);
	});
	await checkAsync("⑦ 代わりに name (最終セグメント) が乗る", async () => {
		const row = data.serve.find((x) => x.id === id);
		assert.equal(row.name, "site");
	});
}
{
	// /serve のレジストリ HTML も同じ扱い。CORS は same-host Origin を reflect するので、
	// ここが「別ポートのページから列挙できる」面になる。
	const res = await send("GET", "/serve/");
	await checkAsync("⑦ レジストリ HTML に絶対パスが無い", async () => {
		assert.equal(res.status, 200, `status=${res.status}`);
		assert.ok(!res.body.includes(HOME_DIR), "レジストリに絶対パスが漏れている");
	});
	await checkAsync("⑦ レジストリは id と name を出す", async () => {
		assert.ok(res.body.includes(id), "id が出ていない");
		assert.ok(res.body.includes(">site<"), "name が出ていない");
	});
}

// --- ⑪ 名前・拡張子の制限 ------------------------------------------------------
for (const [label, name] of [
	["`..` を含む名前", "../escape"],
	["2 階層の名前", "a/b"],
	["制御文字を含む名前", "bad\u0007name.txt"],
	["129 文字の名前", `${"a".repeat(125)}.txt`],
]) {
	const res = await send("POST", `/serve/${id}/_inbox/${encodeURI(name)}`, { body: "x" });
	await checkAsync(`⑪ ${label} は 400`, async () =>
		assert.equal(res.status, 400, `status=${res.status} body=${res.body}`));
}
for (const name of ["evil.html", "evil.svg", "evil.js", "evil.exe", "evil.sh", "noext"]) {
	const res = await send("POST", `/serve/${id}/_inbox/${name}`, { body: "x" });
	await checkAsync(`⑪ ${name} は 400 (allowlist 外)`, async () => {
		assert.equal(res.status, 400, `status=${res.status} body=${res.body}`);
		assert.ok(!existsSync(`${SITE}/_inbox/${name}`), "拒否したのにファイルが出来ている");
	});
}
{
	const note = JSON.stringify({ take: 1 });
	const res = await send("POST", `/serve/${id}/_inbox/pic.png`, { body: note });
	await checkAsync("⑪ 許可拡張子 (png) の正常な POST は通る", async () => {
		assert.equal(res.status, 200, `status=${res.status} body=${res.body}`);
		assert.ok(existsSync(`${SITE}/_inbox/pic.png`), "ファイルが出来ていない");
	});
	const html = await send("POST", `/serve/${id}/_inbox/UPPER.TXT`, { body: "x" });
	await checkAsync("⑪ 拡張子は小文字化して判定する (.TXT)", async () =>
		assert.equal(html.status, 200, `status=${html.status} body=${html.body}`));
}

// --- ⑪ MEDIA_DIR 総量上限 ------------------------------------------------------
{
	// 上限は 1GiB。実バイトを書かずに埋めるため sparse file を使う（statSync は 1GiB を返す）。
	mkdirSync(MEDIA, { recursive: true });
	const junk = `${MEDIA}/budget-junk.mp4`;
	writeFileSync(junk, "");
	truncateSync(junk, 1024 * 1024 * 1024);
	const res = await send("POST", `/serve/${id}/_inbox/overflow.json`, { body: "{}" });
	await checkAsync("⑪ 総量上限を超える POST は 413", async () => {
		assert.equal(res.status, 413, `status=${res.status} body=${res.body}`);
		assert.ok(!existsSync(`${SITE}/_inbox/overflow.json`), "413 なのにファイルが出来ている");
	});
	rmSync(junk, { force: true });
	const after = await send("POST", `/serve/${id}/_inbox/after.json`, { body: "{}" });
	await checkAsync("⑪ 空になったら再び通る", async () =>
		assert.equal(after.status, 200, `status=${after.status} body=${after.body}`));
}

// --- #86 /api/upload にも総量上限 ----------------------------------------------
{
	// 上限は 1GiB。実バイトを書かずに埋めるため sparse file を使う（statSync は 1GiB を返す）。
	// 小さなボディで確かめるのが肝——単発上限 (8MB/64MB) は関係なく、総量だけで落ちる。
	mkdirSync(MEDIA, { recursive: true });
	const junk = `${MEDIA}/upload-budget-junk.mp4`;
	writeFileSync(junk, "");
	truncateSync(junk, 1024 * 1024 * 1024);
	const res = await send("POST", "/api/upload?ext=png&scope=global", { body: Buffer.from([0x89]) });
	await checkAsync("#86 総量上限を超える /api/upload は 413", async () => {
		assert.equal(res.status, 413, `status=${res.status} body=${res.body}`);
	});
	rmSync(junk, { force: true });
	const after = await send("POST", "/api/upload?ext=png&scope=global", { body: Buffer.from([0x89]) });
	await checkAsync("#86 空になったら /api/upload は再び通る", async () =>
		assert.equal(after.status, 200, `status=${after.status} body=${after.body}`));
}

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
