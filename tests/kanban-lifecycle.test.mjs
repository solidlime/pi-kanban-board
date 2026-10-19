// #64/#66: HTTP サーバのライフサイクルと同一性。各シナリオは子プロセスで隔離
// （モジュールスコープの状態を1プロセス1回しか作れないため）。HOME と KANBAN_PORT を
// 差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as netServer } from "node:net";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import http from "node:http";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const JITI = "/root/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.cjs";
const WORK = "/tmp/kb-lifecycle";
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

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

const freePort = () =>
	new Promise((resolve) => {
		const s = netServer();
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	});

/**
 * One isolated child: fresh HOME, patched node:http before the module is imported,
 * and the result handed back as JSON on stdout.
 */
function runScenario({ home, port, patch, waitFor }) {
	const harness = `${home}/harness.mjs`;
	mkdirSync(`${home}/.pi/kanban/sessions`, { recursive: true });
	mkdirSync(`${home}/workspace`, { recursive: true });
	writeFileSync(
		harness,
		`import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const http = require("node:http");
const stats = { createServer: 0 };
if (${patch ? "true" : "false"}) {
	http.createServer = function () {
		stats.createServer += 1;
		const err = new Error("bind says no");
		err.code = "EACCES";
		const fake = {
			once() { return fake; },
			on() { return fake; },
			off() { return fake; },
			close() {},
			listen() { setImmediate(() => fake.__emit("error", err)); return fake; },
			__emit(ev, arg) { if (ev === "error") fake.__onError && fake.__onError(arg); },
			__onError: null,
		};
		const realOnce = fake.once;
		fake.once = function (ev, fn) { if (ev === "error") fake.__onError = fn; return realOnce.call(fake, ev, fn); };
		return fake;
	};
}
const { createJiti } = require(${JSON.stringify(JITI)});
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(${JSON.stringify(`${ROOT}/extensions/kanban.ts`)});
const pi = {
	registerCommand() {},
	registerTool() {},
	appendEntry() {},
	on() {},
	sendUserMessage() {},
};
mod.default(pi);
// #83b: /api/** needs the token. The server wrote it under this scenario's HOME, so wrap
// fetch once instead of threading the cookie through every scenario's waitFor snippet.
const { readFileSync } = require("node:fs");
const TOK = readFileSync(process.env.HOME + "/.pi/kanban/token", "utf8").trim();
const plainFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
	const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
	if (!headers.has("cookie")) headers.set("Cookie", "kb_token=" + TOK);
	return plainFetch(input, { ...init, headers });
};
${waitFor}
console.log("__RESULT__" + JSON.stringify(out));
process.exit(0);
`,
	);
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [harness], {
			env: { ...process.env, HOME: home, KANBAN_PORT: String(port) },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		child.on("exit", (code) => {
			const idx = stdout.indexOf("__RESULT__");
			const result = idx === -1 ? null : JSON.parse(stdout.slice(idx + 10).split("\n")[0]);
			const logFile = `${home}/.pi/kanban/server.log`;
			resolve({
				code,
				result,
				stdout,
				stderr,
				log: existsSync(logFile) ? readFileSync(logFile, "utf8") : "",
			});
		});
	});
}

const PKG_VERSION = JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8")).version;

// --- A. 正常起動: identity を返す --------------------------------------------
{
	const home = `${WORK}/ok`;
	const port = await freePort();
	const waitFor = `
const out = {};
for (let i = 0; i < 60; i++) {
	try {
		const r = await fetch("http://127.0.0.1:${port}/api/selftest", { method: "POST" });
		if (r.ok) { out.selftest = await r.json(); break; }
	} catch {}
	await new Promise((r) => setTimeout(r, 100));
}
out.dashboard = await (await fetch("http://127.0.0.1:${port}/api/dashboard")).json();
out.pid = process.pid;
out.pkgVersion = ${JSON.stringify(PKG_VERSION)};`;
	const r = await runScenario({ home, port, patch: false, waitFor });

	await check("#66 /api/selftest は identity{version,startedAt,pid} を返す", () => {
		assert.equal(r.code, 0, r.stderr);
		const id = r.result?.selftest?.identity;
		assert.ok(id, `identity が無い: ${JSON.stringify(r.result?.selftest)}`);
		assert.equal(typeof id.version, "string");
		assert.equal(typeof id.startedAt, "number");
		assert.ok(id.startedAt > 0, "startedAt が listen 前のまま");
		assert.equal(typeof id.pid, "number");
	});
	await check("#66 identity.version は package.json と一致する", () => {
		assert.equal(r.result.selftest.identity.version, PKG_VERSION);
	});
	await check("#66 identity.pid はサーバ自身の pid（表示専用の値）", () => {
		assert.equal(r.result.selftest.identity.pid, r.result.pid);
	});
	await check("#66 /api/dashboard は version と startedAt を返す", () => {
		assert.equal(r.result.dashboard.version, PKG_VERSION, "version が無い");
		assert.equal(typeof r.result.dashboard.startedAt, "number");
		assert.ok(r.result.dashboard.startedAt > 0, "startedAt が 0");
	});
}

// --- B. EACCES は 1 回で打ち切り、KANBAN_PORT の不正値は 8789 に落とす --------
{
	const home = `${WORK}/eacces`;
	const r = await runScenario({
		home,
		port: "not-a-port",
		patch: true,
		waitFor: "const out = { stats, sleep: await new Promise((res) => setTimeout(() => res(1), 1200)) };",
	});

	await check("#64 EACCES はリトライせず 1 回で止まる（4 回叩かない）", () => {
		assert.equal(r.code, 0, r.stderr);
		assert.equal(r.result.stats.createServer, 1, `createServer 呼び出し: ${r.result.stats.createServer}`);
	});
	await check("#64 EACCES のログは原因と netsh の確認手順を示す", () => {
		assert.match(r.log, /EACCES/, r.log);
		assert.match(r.log, /netsh int ipv4 show excludedportrange protocol=tcp/, r.log);
		assert.doesNotMatch(r.log, /attempt 2\/4/, `リトライしている: ${r.log}`);
	});
	await check("#66 KANBAN_PORT が非数値なら 8789 にフォールバックし警告する", () => {
		assert.match(r.stderr, /KANBAN_PORT="not-a-port" is not a port/, r.stderr);
		assert.match(r.log, /0\.0\.0\.0:8789/, `既定ポートを使っていない: ${r.log}`);
	});
}

// --- C. 版が違うサーバは reuse せず stale にする -----------------------------
{
	const home = `${WORK}/stale`;
	const port = await freePort();
	const squat = http.createServer((req, res) => {
		if (req.url === "/api/selftest") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true, checks: [], identity: { version: "0.0.1", startedAt: 1, pid: 1 } }));
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ cards: [] }));
	});
	await new Promise((resolve) => squat.listen(port, "127.0.0.1", resolve));
	const r = await runScenario({
		home,
		port,
		patch: false,
		waitFor: "const out = {}; await new Promise((res) => setTimeout(res, 1500));",
	});
	squat.close();

	await check("#66 版が違うサーバは reuse せず stale と記録する", () => {
		assert.equal(r.code, 0, r.stderr);
		assert.match(r.log, /refusing to reuse stale server/, r.log);
		assert.match(r.log, /expected v[\d.]+, got v0\.0\.1/, r.log);
		assert.doesNotMatch(r.log, /reusing it/, `reuse してしまった: ${r.log}`);
	});
}

// --- D. footer と状態型に stale / fatal がある -------------------------------
{
	const src = readFileSync(`${ROOT}/extensions/kanban.ts`, "utf8");
	await check("#66 apiState の型に stale / fatal がある", () => {
		assert.match(src, /let apiState: [^=]*"stale"[^=]*"fatal"/);
	});
	await check("#66 footer は stale を STALE、fatal を PORT BLOCKED と出す", () => {
		assert.match(src, /apiState === "stale"\s*\?\s*" STALE"/);
		assert.match(src, /apiState === "fatal"\s*\?\s*" PORT BLOCKED"/);
	});
}

console.log(`${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length === 0 ? 0 : 1);
