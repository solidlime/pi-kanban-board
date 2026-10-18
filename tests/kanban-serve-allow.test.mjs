// #19 / #20: serve add の拒否コードと baseUrl。フレームワーク無しで
// `node tests/kanban-serve-allow.test.mjs`。HOME と KANBAN_PORT を差し替えるので
// 本番の ~/.pi/kanban と 8789 には触れない。
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as netServer } from "node:net";
import { hostname } from "node:os";
import http from "node:http";
import { createRequire } from "node:module";

const HOME_DIR = "/tmp/kb-serve-allow-home";
const OUTSIDE = "/tmp/kb-serve-allow-outside"; // 隔離 HOME の外 = allowlist 外
rmSync(HOME_DIR, { recursive: true, force: true });
rmSync(OUTSIDE, { recursive: true, force: true });
const KANBAN_DIR = `${HOME_DIR}/.pi/kanban`;
const SITE = `${HOME_DIR}/workspace/site`;
mkdirSync(`${KANBAN_DIR}/sessions`, { recursive: true });
mkdirSync(SITE, { recursive: true });
mkdirSync(`${OUTSIDE}/dir`, { recursive: true });
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

const serve = tools.get("serve");
assert.ok(serve, "serve ツールが registerTool されている");
const call = (args) => serve.execute("t", args, null, () => {});
const base = `http://127.0.0.1:${PORT}`;
const ALLOW_JSON = `${KANBAN_DIR}/serve-allow.json`;
const HOST_JSON = `${KANBAN_DIR}/serve-host.json`;
const writeAllow = (obj) => writeFileSync(ALLOW_JSON, JSON.stringify(obj));

// --- #19: allowlist 外は 403、存在しないは 404 --------------------------------
// serve-allow.json 無し = 既定 allowlist (~/workspace と ~/.pi/kanban)
const outside = await call({ action: "add", path: `${OUTSIDE}/dir` });
const inside = await call({ action: "add", path: SITE });
const missingIn = await call({ action: "add", path: `${HOME_DIR}/workspace/nope` });
const missingOut = await call({ action: "add", path: `${OUTSIDE}/nope` });

check("19-1 allowlist 外の実在パスは 403", () => {
	assert.equal(outside.isError, true, JSON.stringify(outside.details));
	assert.equal(outside.details.status, 403, JSON.stringify(outside.details));
});
check("19-2 存在しないパスは 404 (allowlist 内)", () => {
	assert.equal(missingIn.details.ok, false);
	assert.equal(missingIn.details.status, 404, JSON.stringify(missingIn.details));
});
check("19-2b 存在しない allowlist 外パスも 403 (判定順: allowlist が先)", () => {
	assert.equal(missingOut.details.ok, false);
	assert.equal(missingOut.details.status, 403, JSON.stringify(missingOut.details));
});
check("19-3 allowlist 内の実在パスは成功", () => {
	assert.equal(inside.details.ok, true, JSON.stringify(inside.details));
	assert.match(inside.content[0].text, /\/serve\/[0-9a-f]{16}\/$/);
});
check("19-4 403 本文は allowlist と読め、404 本文と異なる", () => {
	const denied = outside.content[0].text;
	const notFound = missingIn.content[0].text;
	assert.match(denied, /allowlist/i, denied);
	assert.doesNotMatch(denied, /not found/, denied);
	assert.match(notFound, /not found/i, notFound);
	assert.notEqual(denied, notFound);
});

// --- #20: baseUrl -------------------------------------------------------------
const ID = inside.details.id;
const urlHost = (u) => new URL(u).host;
const fallback = `${hostname()}:${PORT}`;

const defaultList = await call({ action: "list" });
check("20-5 baseUrl 未設定なら従来どおりホスト名", () => {
	const row = defaultList.details.entries.find((e) => e.id === ID);
	assert.ok(row, JSON.stringify(defaultList.details));
	assert.equal(urlHost(row.url), fallback, row.url);
});

writeAllow({ baseUrl: "http://km.example:9000" });
const customAdd = await call({ action: "add", path: SITE });
const customList = await call({ action: "list" });
check("20-6 baseUrl 設定時はその URL が返る (add)", () => {
	assert.equal(customAdd.content[0].text, `http://km.example:9000/serve/${ID}/`);
	assert.equal(customAdd.details.url, customAdd.content[0].text);
});
check("20-6b baseUrl 設定時は list も同じホスト", () => {
	const row = customList.details.entries.find((e) => e.id === ID);
	assert.equal(row.url, `http://km.example:9000/serve/${ID}/`, row.url);
});

writeAllow({ baseUrl: "http://km.example:9000/" });
const trailing = await call({ action: "list" });
writeAllow({ baseUrl: "km.example:9000" });
const schemeless = await call({ action: "list" });
writeAllow({ baseUrl: "http://km.example:9000///" });
const manySlash = await call({ action: "list" });
check("20-7 末尾スラッシュは正規化", () => {
	assert.equal(trailing.details.entries.find((e) => e.id === ID).url, `http://km.example:9000/serve/${ID}/`);
	assert.equal(manySlash.details.entries.find((e) => e.id === ID).url, `http://km.example:9000/serve/${ID}/`);
});
check("20-7b scheme 無しは http:// を補う", () => {
	assert.equal(schemeless.details.entries.find((e) => e.id === ID).url, `http://km.example:9000/serve/${ID}/`);
});

writeAllow({ baseUrl: "http://" });
const badScheme = await call({ action: "list" });
writeAllow({ baseUrl: "ftp://km.example:9000" });
const badProto = await call({ action: "list" });
writeAllow({ baseUrl: 42 });
const badType = await call({ action: "list" });
check("20-7c 不正な baseUrl は警告してフォールバック", () => {
	for (const [label, res] of [
		["empty host", badScheme],
		["ftp", badProto],
		["number", badType],
	]) {
		const row = res.details.entries.find((e) => e.id === ID);
		assert.equal(urlHost(row.url), fallback, `${label}: ${row.url}`);
	}
});
writeAllow({ roots: [SITE], baseUrl: "http://km.example:9000" });
const both = await call({ action: "list" });
const bothDenied = await call({ action: "add", path: `${HOME_DIR}/workspace/nope` });
check("20-7e roots 指定時は allowlist も上書きされる", () => {
	assert.equal(both.details.entries.find((e) => e.id === ID).url, `http://km.example:9000/serve/${ID}/`);
	assert.equal(bothDenied.details.status, 403, JSON.stringify(bothDenied.details));
});

// --- 20-8: /serve HTML と list が同じホスト ----------------------------------
{
	const html = await (await fetch(`${base}/serve`)).text();
	const hrefs = [...html.matchAll(/href="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
	const page = await call({ action: "list" });
	check("20-8 /serve HTML と list が同じホスト", () => {
		assert.ok(hrefs.length > 0, `no absolute href in /serve html: ${html.slice(0, 300)}`);
		const row = page.details.entries.find((e) => e.id === ID);
		assert.ok(row, JSON.stringify(page.details));
		assert.equal(urlHost(hrefs[0]), urlHost(row.url), `html=${hrefs[0]} list=${row.url}`);
		assert.equal(urlHost(hrefs[0]), "km.example:9000", hrefs[0]);
	});
}

// --- #20 追加: 学習した Host (env > baseUrl > 学習 > hostname) -------------------
rmSync(ALLOW_JSON, { force: true });
rmSync(HOST_JSON, { force: true });
const beforeLearn = await call({ action: "list" });
check("20-9 学習前は os.hostname() にフォールバック", () => {
	assert.equal(urlHost(beforeLearn.details.entries.find((e) => e.id === ID).url), fallback);
});

// POST /api/host を生の http で叩く (body と status をそのまま見る)
function postHost(body) {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ host: "127.0.0.1", port: PORT, path: "/api/host", method: "POST",
				headers: { "Content-Type": "application/json" } },
			(res) => {
				let raw = "";
				res.on("data", (c) => (raw += c));
				res.on("end", () => resolve({ status: res.statusCode, body: raw }));
			},
		);
		req.on("error", reject);
		req.end(body);
	});
}
const readHostFile = () => {
	try {
		return readFileSync(HOST_JSON, "utf8");
	} catch {
		return null;
	}
};

await postHost(JSON.stringify({ host: "myhost.ts.net" }));
const afterReport = await call({ action: "add", path: SITE });
const reportedUrl = new URL(afterReport.content[0].text);
check("20-11 POST /api/host のホストが serve add の URL になる", () => {
	assert.equal(reportedUrl.hostname, "myhost.ts.net", afterReport.content[0].text);
	assert.equal(reportedUrl.port, String(PORT));
	assert.match(readHostFile(), /"host":"myhost.ts.net"/);
});

// #22: 127.0.0.1 / localhost はブラウザから実際に見えた値なので記録する
const loopback = await postHost(JSON.stringify({ host: "127.0.0.1" }));
check("20-12 127.0.0.1 は記録される", () => {
	assert.equal(loopback.status, 200, loopback.body);
	assert.match(readHostFile(), /"host":"127\.0\.0\.1"/);
});
const loopAdd = await call({ action: "add", path: SITE });
const loopUrl = new URL(loopAdd.content[0].text);
check("20-12a 学習した 127.0.0.1 が serve add の URL になる", () => {
	assert.equal(loopUrl.hostname, "127.0.0.1", loopAdd.content[0].text);
	assert.equal(loopUrl.port, String(PORT), loopAdd.content[0].text);
});
const localhost = await postHost(JSON.stringify({ host: "localhost" }));
check("20-12b localhost も記録される", () => {
	assert.equal(localhost.status, 200, localhost.body);
	assert.match(readHostFile(), /"host":"localhost"/);
});

// コンテナ ID の拒否は残る (フォールバックと同一で、ブラウザからは到達できない)
const keep = readHostFile();
const container = await postHost(JSON.stringify({ host: hostname() }));
check("20-12c コンテナ ID は記録しない", () => {
	assert.equal(container.status, 400, container.body);
	assert.equal(readHostFile(), keep);
});

const empty = await postHost(JSON.stringify({ host: "" }));
const traversal = await postHost(JSON.stringify({ host: "../../etc" }));
const huge = await postHost(JSON.stringify({ host: "a".repeat(300) }));
check("20-12b 不正な host は 400、記録しない", () => {
	for (const r of [empty, traversal, huge]) assert.equal(r.status, 400, r.body);
	assert.equal(readHostFile(), keep);
});

writeAllow({ baseUrl: "http://km.example:9000" });
const overReport = await call({ action: "list" });
check("20-13 serve-allow.json の baseUrl は報告された host より優先", () => {
	assert.equal(urlHost(overReport.details.entries.find((e) => e.id === ID).url), "km.example:9000");
});

process.env.KANBAN_BASE_URL = "http://env.example:9000";
const overEnv = await call({ action: "list" });
check("20-14 KANBAN_BASE_URL は baseUrl より優先", () => {
	assert.equal(urlHost(overEnv.details.entries.find((e) => e.id === ID).url), "env.example:9000");
});
delete process.env.KANBAN_BASE_URL;

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
