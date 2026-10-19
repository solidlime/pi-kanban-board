// #23: /serve の Host ヘッダから serve-host.json を学習する経路の自己検証。
// フレームワーク無しで `node tests/kanban-host-learn.test.mjs`。HOME と KANBAN_PORT を
// 差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer as netServer } from "node:net";
import http from "node:http";
import { hostname } from "node:os";
import { createRequire } from "node:module";
import { authFetch, tokenHeader } from "./helpers/token.mjs";

// #83b: HTTP routes need the server token now; tf = fetch + the kb_token cookie.
const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-host-learn-home";
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

const HOST_JSON = `${HOME_DIR}/.pi/kanban/serve-host.json`;
const SITE = `${HOME_DIR}/workspace/site`;
const readHost = () => {
	try {
		return JSON.parse(readFileSync(HOST_JSON, "utf8"));
	} catch {
		return null;
	}
};
const hostText = () => {
	try {
		return readFileSync(HOST_JSON, "utf8");
	} catch {
		return "";
	}
};

// Host を指定して /serve に投げる (fetch は Host を差し替えられない)
function hostRequest(path, host, method = "GET", body) {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ host: "127.0.0.1", port: PORT, path, method, headers: { Host: host, Cookie: tokenHeader() } },
			(res) => {
				let raw = "";
				res.on("data", (c) => (raw += c));
				res.on("end", () => resolve({ status: res.statusCode, body: raw }));
			},
		);
		req.on("error", reject);
		if (body !== undefined) req.write(body);
		req.end();
	});
}

// 生のヘッダを送る (空 Host / obs-fold は http.request では作れない)
function rawHead(head) {
	return new Promise((resolve, reject) => {
		const sock = connect(PORT, "127.0.0.1", () => sock.write(head));
		let raw = "";
		sock.on("data", (c) => (raw += c));
		sock.on("error", reject);
		sock.on("close", () => resolve({ status: Number(/HTTP\/1\.[01] (\d{3})/.exec(raw)?.[1]), raw }));
		setTimeout(() => sock.destroy(), 400).unref();
	});
}

// 学習前の `serve add` はフォールバック + hint になる
const firstAdd = await call({ action: "add", path: SITE });
const id = firstAdd.details.id;
const urlText = (res) => res.content.map((c) => c.text).join("\n");

check("8a 未学習の serve add は hint 行を返す", () => {
	assert.equal(readHost(), null, "まだ学習していない");
	assert.match(urlText(firstAdd), /^hint: open http:\/\/[^/]+:\d+\/serve\/ once in your browser so the board learns your host\.$/m);
});

// --- 6: /api/* では学習しない --------------------------------------------------
{
	const res = await hostRequest("/api/kanban", "evil.example");
	check("6 /api/kanban は Host を学習しない", () => {
		assert.equal(res.status, 200);
		assert.equal(readHost(), null);
	});
}

// --- 5: 不正な Host は保存しない・500 にしない ---------------------------------
{
	const empty = await rawHead(`GET /serve/ HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n`);
	const traversal = await hostRequest("/serve/", "../../etc");
	const space = await hostRequest("/serve/", "bad host");
	const folded = await rawHead(`GET /serve/ HTTP/1.1\r\nHost: a\r\n Host: b\r\nConnection: close\r\n\r\n`);
	check("5 空/../../etc/空白/改行入り Host は学習せず 500 でもない", () => {
		for (const r of [empty, traversal, space, folded]) assert.notEqual(r.status, 500, JSON.stringify(r));
		assert.equal(readHost(), null, hostText());
	});
}

// --- 1: 一覧ページの Host から学習する -----------------------------------------
{
	const res = await hostRequest("/serve/", "myhost.ts.net:8789");
	check("1 GET /serve/ の Host から hostname を学習 (PORT は落とす)", () => {
		assert.equal(res.status, 200);
		assert.equal(readHost()?.host, "myhost.ts.net", hostText());
	});
}

// --- 7 / 8b: 学習後は serve add の URL に効き、hint は消える --------------------
{
	const add = await call({ action: "add", path: SITE });
	const url = new URL(add.details.url);
	check("7 学習したホストが serve add の URL になる", () => {
		assert.equal(url.hostname, "myhost.ts.net", add.details.url);
		assert.equal(url.port, String(PORT), add.details.url);
		assert.match(add.content[0].text, /^http:\/\/myhost\.ts\.net:\d+\/serve\/[0-9a-f]{16}\/$/);
	});
	check("8b 学習済みの serve add に hint は出ない", () => {
		assert.doesNotMatch(urlText(add), /hint:/);
	});
	const list = await call({ action: "list" });
	check("8b 学習済みの serve list にも hint は出ない", () => {
		assert.doesNotMatch(urlText(list), /hint:/);
		assert.equal(list.details.entries.find((e) => e.id === id).url, add.details.url);
	});
}

// --- 2 / 9: 個別配信の Host でも上書き学習し、配信は壊れない --------------------
{
	writeFileSync(`${SITE}/hello.txt`, "hello");
	const before = await hostRequest(`/serve/${id}/`, "10.0.0.5:8789");
	check("2 GET /serve/<id>/ の Host でも学習する", () => {
		assert.equal(before.status, 200);
		assert.equal(readHost()?.host, "10.0.0.5", hostText());
	});
	const file = await hostRequest(`/serve/${id}/hello.txt`, "10.0.0.5:8789");
	check("9 学習後も配信は壊れない (本文と Content-Type)", () => {
		assert.equal(file.status, 200);
		assert.equal(file.body, "hello");
		assert.match(file.body, /^hello$/);
	});
}

// --- 3: _inbox への POST でも学習する -----------------------------------------
{
	mkdirSync(`${SITE}/_inbox`, { recursive: true });
	const res = await hostRequest(`/serve/${id}/_inbox/x.txt`, "myhost.ts.net", "POST", "x");
	check("3 POST /serve/<id>/_inbox/<name> の Host でも学習する", () => {
		assert.equal(res.status, 200, res.body);
		assert.equal(readHost()?.host, "myhost.ts.net", hostText());
	});
}

// --- 4: コンテナ ID は学習しない (フォールバックと同じ値) ----------------------
{
	const keep = hostText();
	const res = await hostRequest("/serve/", hostname());
	check("4 os.hostname() (コンテナ ID) は学習しない", () => {
		assert.equal(res.status, 200);
		assert.equal(hostText(), keep);
	});
}

// --- 3': 別ポート付き Host も名前だけを保存し、発行 URL は我々のポートになる ------
{
	const res = await hostRequest("/serve/", "proxy.example:9000");
	const add = await call({ action: "add", path: SITE });
	check("3' Host のポートは落として名前だけ学習する", () => {
		assert.equal(res.status, 200);
		assert.equal(readHost()?.host, "proxy.example", hostText());
		assert.equal(new URL(add.details.url).host, `proxy.example:${PORT}`, add.details.url);
	});
}

// --- 未学習 (ホスト未報告 + allowlist の baseUrl) では hint を出さない ---------
{
	rmSync(HOST_JSON, { force: true });
	writeFileSync(`${HOME_DIR}/.pi/kanban/serve-allow.json`, JSON.stringify({ baseUrl: "http://km.example:9000" }));
	const add = await call({ action: "add", path: SITE });
	check("8c baseUrl 明示時は未学習でも hint を出さない", () => {
		assert.equal(new URL(add.content[0].text).host, "km.example:9000");
		assert.doesNotMatch(urlText(add), /hint:/);
	});
	rmSync(`${HOME_DIR}/.pi/kanban/serve-allow.json`, { force: true });
}

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
