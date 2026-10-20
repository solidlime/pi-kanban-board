// kanban _inbox (serve ページからの書き戻し) の自己検証。フレームワーク無しで
// `node tests/kanban-inbox.test.mjs`。HOME と KANBAN_PORT を差し替えるので本番の
// ~/.pi/kanban と 8789 には触れない。A1-A6 の安全策 + Part B の再発防止を実測で固定する。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as netServer } from "node:net";
import http from "node:http";
import { createRequire } from "node:module";
import { authFetch, tokenHeader } from "./helpers/token.mjs";

// #83b: HTTP routes need the server token now; tf = fetch + the kb_auth cookie.
const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-inbox-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
mkdirSync(`${HOME_DIR}/workspace/site/segments`, { recursive: true });
mkdirSync(`${HOME_DIR}/outside-inbox`, { recursive: true });
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
const INBOX = `${SITE}/_inbox`;

// fetch は URL を正規化して `..` を消してしまうので、生パスは http.request で送る。
function raw(method, path, body) {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ host: "127.0.0.1", port: PORT, path, method, headers: { "Content-Type": "application/octet-stream", Cookie: tokenHeader() } },
			(res) => {
				let out = "";
				res.on("data", (c) => (out += c));
				res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
			},
		);
		req.on("error", (err) => {
			// 413 を返した後の EPIPE は許容（応答自体は受け取れている）
			if (err.code === "EPIPE" || err.code === "ECONNRESET") resolve({ status: 0, body: "" });
			else reject(err);
		});
		if (body !== undefined) req.write(body);
		req.end();
	});
}
const post = (path, body) => raw("POST", path, body);

// --- A1 / A2: 登録と書き込み ---------------------------------------------------
const add = await call({ action: "add", path: SITE });
const id = add.details.id;
assert.ok(id, `serve add が id を返す: ${JSON.stringify(add.details)}`);

rmSync(INBOX, { recursive: true, force: true }); // A2: 無い状態から始める
const NOTE = JSON.stringify({ take: 14, approved: true });
{
	const res = await post(`/serve/${id}/_inbox/a.json`, NOTE);
	await checkAsync("A1 POST は 200 で { ok, name, bytes } を返す（#80-⑦: 絶対パスは返さない）", async () => {
		assert.equal(res.status, 200, `status=${res.status} body=${res.body}`);
		const j = JSON.parse(res.body);
		assert.equal(j.ok, true);
		assert.equal(j.path, undefined, "配信ディレクトリの絶対パスを返してはいけない");
		assert.equal(j.name, "a.json");
		assert.equal(j.bytes, Buffer.byteLength(NOTE));
	});
	await checkAsync("A2 _inbox が無ければサーバが作る (0755)", async () => {
		assert.ok(existsSync(INBOX), "_inbox が無い");
		assert.ok(statSync(INBOX).isDirectory());
	});
	check("A1 保存先は _inbox/<name> で中身が一致", () => {
		assert.equal(readFileSync(`${INBOX}/a.json`, "utf8"), NOTE);
	});
}

// --- A4: 既存 GET で読める（新しい GET を足していない） -----------------------
{
	const res = await tf(`${base}/serve/${id}/_inbox/a.json`);
	const body = await res.text();
	await checkAsync("A4 既存 GET /serve/<id>/_inbox/<name> で内容一致", async () => {
		assert.equal(res.status, 200);
		assert.equal(body, NOTE);
	});
}

// --- A2: 403 / 400 / 404 ------------------------------------------------------
{
	const forbidden = await post(`/serve/${id}/foo.txt`, "x");
	await checkAsync("A2 _inbox 以外への POST は 403", async () =>
		assert.equal(forbidden.status, 403, `status=${forbidden.status} body=${forbidden.body}`));
	const dotdot = await post(`/serve/${id}/_inbox/../escape`, "x");
	await checkAsync("A2 `_inbox/../escape` は 400", async () =>
		assert.equal(dotdot.status, 400, `status=${dotdot.status} body=${dotdot.body}`));
	const nested = await post(`/serve/${id}/_inbox/a/b`, "x");
	await checkAsync("A2 `_inbox/a/b`（2階層）は 400", async () =>
		assert.equal(nested.status, 400, `status=${nested.status} body=${nested.body}`));
	const empty = await post(`/serve/${id}/_inbox/`, "");
	await checkAsync("A2 name 空は 400", async () =>
		assert.equal(empty.status, 400, `status=${empty.status} body=${empty.body}`));
	const dot = await post(`/serve/${id}/_inbox/.`, "");
	await checkAsync("A2 name `.` は 400", async () =>
		assert.equal(dot.status === 400 || dot.status === 403, true, `status=${dot.status} body=${dot.body}`));
	const unknown = await post(`/serve/deadbeefdeadbeef/_inbox/x.json`, "x");
	await checkAsync("A2 未登録 id は 404", async () =>
		assert.equal(unknown.status, 404, `status=${unknown.status} body=${unknown.body}`));
	const put = await raw("PUT", `/serve/${id}/_inbox/a.json`, "x");
	await checkAsync("A2 PUT は 405 + Allow に POST", async () => {
		assert.equal(put.status, 405);
		assert.match(put.headers.allow ?? "", /POST/);
	});
}

// --- A2: サイズ上限 ------------------------------------------------------------
{
	const big = Buffer.alloc(8 * 1024 * 1024 + 1, 0x41);
	const res = await post(`/serve/${id}/_inbox/big.bin`, big);
	await checkAsync("A2 上限超過 (>8MB) は 413", async () =>
		assert.equal(res.status, 413, `status=${res.status} body=${res.body}`));
	check("A2 413 のときファイルは作られない", () => assert.ok(!existsSync(`${INBOX}/big.bin`)));
}

// --- A2: symlink 脱出拒否 -------------------------------------------------------
{
	mkdirSync(`${HOME_DIR}/workspace/evil`, { recursive: true });
	symlinkSync(`${HOME_DIR}/outside-inbox`, `${HOME_DIR}/workspace/evil/_inbox`);
	const evilAdd = await call({ action: "add", path: `${HOME_DIR}/workspace/evil` });
	const evilId = evilAdd.details.id;
	const res = await post(`/serve/${evilId}/_inbox/leak.json`, "leak");
	await checkAsync("A2 _inbox が外を指す symlink なら 403", async () =>
		assert.equal(res.status, 403, `status=${res.status} body=${res.body}`));
	check("A2 脱出先にファイルは書かれていない", () =>
		assert.ok(!existsSync(`${HOME_DIR}/outside-inbox/leak.json`)));
}

// --- A6: nudge の INBOX 行 ------------------------------------------------------
const board = (cards) => ({ cards, nextId: 99 });
{
	const text = mod.renderInjectionText(board([{ id: 1, text: "x", col: "todo" }]));
	await checkAsync("A6 未読があると INBOX 行が出る", async () => {
		assert.ok(text !== null);
		assert.match(text, /^INBOX  1 unread \(site: a\.json\)$/m, text);
	});
	const acked = await call({ action: "ack", id });
	await checkAsync("A5 ack id は成功し件数を返す", async () => {
		assert.equal(acked.details.ok, true, JSON.stringify(acked.details));
		assert.equal(acked.details.acked, 1);
	});
	check("A5 ack はファイルを消さない", () => assert.ok(existsSync(`${INBOX}/a.json`)));
	const after = mod.renderInjectionText(board([{ id: 1, text: "x", col: "todo" }]));
	await checkAsync("A6 ack 後は INBOX 行が消える", async () => {
		assert.ok(after !== null);
		assert.doesNotMatch(after, /INBOX/);
	});
	// 未読 0 のときは行ごと出さない（既存の KANBAN ブロックは不変）
	check("A6 未読 0 のブロックに余分な空行が無い", () => {
		assert.doesNotMatch(after, /\n\n/);
		assert.match(after, /\n=== END KANBAN ===$/);
	});
	// ack 全 entry（引数無し）でも seen が書かれる
	await new Promise((r) => setTimeout(r, 5)); // watermark(ms) と mtime(ms) の同刻を避ける
	await post(`/serve/${id}/_inbox/note.txt`, "second");
	const beforeAll = mod.renderInjectionText(board([{ id: 1, text: "x", col: "todo" }]));
	check("A6 2件目の書き込みで再び未読になる", () => assert.match(beforeAll, /INBOX  1 unread \(site: note\.txt\)/));
	const all = await call({ action: "ack" });
	await checkAsync("A5 ack 引数無しは全 entry を既読化", async () => {
		assert.equal(all.details.ok, true, JSON.stringify(all.details));
		assert.ok(all.details.acked >= 1);
	});
	check("A6 ack 引数無しで INBOX 行が消える", () =>
		assert.doesNotMatch(mod.renderInjectionText(board([{ id: 1, text: "x", col: "todo" }])), /INBOX/));
	// name 指定 ack
	await new Promise((r) => setTimeout(r, 5));
	await post(`/serve/${id}/_inbox/note.txt`, "third");
	const byName = await call({ action: "ack", id, name: "note.txt" });
	check("A5 ack id+name が成功", () => assert.equal(byName.details.ok, true));
	await checkAsync("A5 未登録 id の ack は isError", async () => {
		const bad = await call({ action: "ack", id: "deadbeefdeadbeef" });
		assert.equal(bad.details.ok, false);
		assert.equal(bad.isError, true);
	});
	// watermark の保存先は inbox-seen.json の1ファイルだけ
	check("A5 watermark は inbox-seen.json に { entryId: epochMs }", () => {
		const seen = JSON.parse(readFileSync(`${HOME_DIR}/.pi/kanban/inbox-seen.json`, "utf8"));
		assert.equal(typeof seen[id], "number");
		assert.ok(seen[id] > 0);
	});
}

// --- A7 / A8: 一覧ページの未読数 -----------------------------------------------
{
	await new Promise((r) => setTimeout(r, 5));
	await post(`/serve/${id}/_inbox/fresh.json`, "x");
	const page = await (await tf(`${base}/serve`)).text();
	check("A8 /serve 一覧に未読数が出る", () => assert.match(page, /inbox 1/));
	await call({ action: "ack", id });
	const page2 = await (await tf(`${base}/serve`)).text();
	check("A8 ack 後は未読数が消える", () => assert.doesNotMatch(page2, /inbox \d/));
}

// --- A7/A8: serve ツールの list テキストにも同じ未読数が出る ---------------------
// #23: /serve への書き込みでホストを学習するので、URL は先の add ではなく今の list から取る。
{
	const clean = await call({ action: "list" });
	const SITE_URL = clean.details.entries.find((e) => e.id === id).url;
	const rowOf = (res) => res.content[0].text.split("\n").find((l) => l.startsWith(SITE_URL));
	check("A7 list 未読0 は従来どおり <url>\\t<path>", () => {
		assert.equal(rowOf(clean), `${SITE_URL}\t${SITE}`);
	});
	await new Promise((r) => setTimeout(r, 5)); // watermark(ms) と mtime(ms) の同刻を避ける
	writeFileSync(`${INBOX}/u1.json`, "x");
	writeFileSync(`${INBOX}/u2.json`, "x");
	const unread = await call({ action: "list" });
	check("A7 list 未読2件で (2 unread) が付く", () => {
		assert.equal(rowOf(unread), `${SITE_URL}\t${SITE} (2 unread)`);
	});
	const html = await (await tf(`${base}/serve`)).text();
	check("A7 list の未読数は HTML 一覧と同じ", () => assert.match(html, /inbox 2/));
	await call({ action: "ack", id });
	const acked = await call({ action: "list" });
	check("A7 ack 後に list から未読表記が消える（他書式は不変）", () => {
		assert.equal(rowOf(acked), `${SITE_URL}\t${SITE}`);
		assert.doesNotMatch(acked.content[0].text, /unread/);
	});
}

// --- A6: 3件超は +N more --------------------------------------------------------
{
	await new Promise((r) => setTimeout(r, 5));
	mkdirSync(INBOX, { recursive: true });
	for (const n of ["1.json", "2.json", "3.json", "4.json", "5.json"]) writeFileSync(`${INBOX}/${n}`, "x");
	const line = mod.renderInjectionText(board([{ id: 1, text: "x", col: "todo" }]));
	check("A6 先頭3件 + `+N more`", () => {
		assert.match(line, /INBOX  5 unread \(site: .* \+2 more\)/, line);
	});
	check("A6 既存 KANBAN ブロックの行は不変", () => {
		assert.match(line, /^=== KANBAN \(this session\) ===$/m);
		assert.match(line, /^TODO\s+#1 x$/m);
		assert.match(line, /GUI: open http:\/\/[^\s/]+:\d+\/ in a browser\./);
		// #83b: トークン無しで URL を開いても案内画面だけ。導線の行が生きていることのみ固定する。
		assert.match(line, /^TOKEN: \/kanban url/m);
		assert.ok(!/token=[0-9a-f]{64}/.test(line), "トークン値がプロンプトに埋まってはいけない");
		assert.match(line, /^=== END KANBAN ===$/m);
	});
	await call({ action: "ack", id });
}

// --- Part B: text 欠落カードで throw しない -------------------------------------
check("B text 欠落カードで continuationPrompt が throw しない (doing)", () => {
	const s = mod.continuationPrompt({ id: 7, col: "doing" }, "session");
	assert.equal(typeof s, "string");
	assert.match(s, /#7/);
});
check("B text 欠落カードで continuationPrompt が throw しない (todo/global)", () => {
	assert.equal(typeof mod.continuationPrompt({ id: 7, col: "todo" }, "global"), "string");
	assert.equal(typeof mod.continuationPrompt({ id: 7, col: "todo" }, "session"), "string");
});
check("B text 欠落カードで注入テキスト生成が throw しない", () => {
	const text = mod.renderInjectionText(board([{ id: 7, col: "doing" }]));
	assert.ok(text !== null);
	assert.doesNotMatch(text, /undefined/);
});
check("B 空ボードは null のまま（既存挙動）", () => assert.equal(mod.renderInjectionText(board([])), null));

// --- 既存挙動の不変（/api/* 規約） --------------------------------------------
{
	const api = await tf(`${base}/api/kanban`);
	const j = await api.json();
	await checkAsync("contract GET /api/kanban は ok:true + boards", async () => {
		assert.equal(api.status, 200);
		assert.equal(j.ok, true);
		assert.ok(Array.isArray(j.session.cards) && Array.isArray(j.global.cards));
	});
	const postApi = await raw("POST", "/api/kanban", "x");
	check("contract POST /api/kanban は 405 (POST は upload のみ)", () =>
		assert.equal(postApi.status, 405));
	const opt = await raw("OPTIONS", "/serve/x/_inbox/y");
	check("contract OPTIONS は 204 のまま", () => assert.equal(opt.status, 204));
}

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
