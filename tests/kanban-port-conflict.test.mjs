// #83: 8789 を握っているのが「古い kanban」なのか「別プロセス」なのかを、起動ログだけで
// 人間が切り分けられること。各シナリオは子プロセスで隔離（モジュールスコープの状態は
// 1プロセス1回しか作れないため）。HOME と KANBAN_PORT を差し替えるので本番の
// ~/.pi/kanban と 8789 には触れない。
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createServer as netServer } from "node:net";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const JITI = process.env.KANBAN_JITI ?? createRequire(import.meta.url).resolve("jiti");
const TMP_ROOT = tmpdir();
const WORK = TMP_ROOT + "/kb-port-conflict";
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

const PKG_VERSION = JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8")).version;

const freePort = () =>
	new Promise((resolve) => {
		const s = netServer();
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	});

/** 8789 を握っている何か。`answer` が (req,res) をそのまま扱う。 */
function squat(port, answer) {
	const srv = http.createServer(answer);
	return new Promise((resolve) =>
		srv.listen(port, "0.0.0.0", () =>
			resolve({ close: () => new Promise((done) => srv.close(done)) }),
		),
	);
}

/**
 * 1 つの隔離プロセス。`body` はモジュール読み込み後に走る子側コードで、`t`（__test フック）、
 * `out`（結果）、`waitLog`（server.log を待つ）が使える。`${}` とバックティックは使えない。
 */
function runScenario({ home, port, body }) {
	const harness = `${home}/harness.mjs`;
	mkdirSync(`${home}/.pi/kanban/sessions`, { recursive: true });
	writeFileSync(
		harness,
		`import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { createJiti } = require(${JSON.stringify(JITI)});
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(${JSON.stringify(`${ROOT}/extensions/kanban.ts`)});
const LOG = ${JSON.stringify(`${home}/.pi/kanban/server.log`)};
const readLog = () => (existsSync(LOG) ? readFileSync(LOG, "utf8") : "");
const waitLog = async (re, ms) => {
  const limit = ms === undefined ? 8000 : ms;
  for (let i = 0; i < limit / 50; i++) {
    if (re.test(readLog())) return readLog();
    await new Promise((r) => setTimeout(r, 50));
  }
  return readLog();
};
const pi = {
  registerCommand() {},
  registerTool() {},
  appendEntry() {},
  on() {},
  sendUserMessage() {},
};
const t = mod.default(pi).__test;
const out = {};
${body}
console.log("__RESULT__" + JSON.stringify(out));
setTimeout(() => process.exit(0), 100);
`,
	);
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [harness], {
			env: { ...process.env, HOME: home, USERPROFILE: home, KANBAN_PORT: String(port) },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		child.on("exit", (code) => {
			const idx = stdout.indexOf("__RESULT__");
			resolve({
				code,
				result: idx === -1 ? null : JSON.parse(stdout.slice(idx + 10).split("\n")[0]),
				stdout,
				stderr,
				log: existsSync(`${home}/.pi/kanban/server.log`)
					? readFileSync(`${home}/.pi/kanban/server.log`, "utf8")
					: "",
			});
		});
	});
}

// --- A. pre-#66 kanban（/api/selftest 404, /api/dashboard 200）----------------
{
	const port = await freePort();
	const s = await squat(port, (req, res) => {
		if (req.url === "/api/selftest") {
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: false, error: "not found" }));
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ cards: [], version: "0.1.0" }));
	});
	const r = await runScenario({
		home: `${join(WORK, "oldkanban")}`,
		port,
		body: `out.log = await waitLog(/refusing to reuse stale server/);
out.probe = await t.probe();
out.state = t.apiState();
// pid を持たない握り手（pre-#66）は「pid 不明」と明示する
await t.decideReuse({ reachable: true, servesDashboard: true });
out.state2 = t.apiState();
out.finalLog = readLog();`,
	});
	await s.close();

	await check("#83 probe: selftest 404 + dashboard 200 は「旧版 kanban が握っている」", () => {
		assert.equal(r.code, 0, r.stderr);
		assert.equal(r.result.probe.reachable, true, `probe: ${JSON.stringify(r.result.probe)}`);
		assert.equal(r.result.probe.servesDashboard, true, `probe: ${JSON.stringify(r.result.probe)}`);
		assert.equal(r.result.probe.version, undefined, "旧版に version は無い");
	});
	await check("#83 旧版を握り手にした listen は stale になる", () => {
		assert.equal(r.result.state, "stale", `apiState: ${r.result.state}`);
		assert.equal(r.result.state2, "stale");
	});
	await check("#83 stale ログは「古い kanban が / を持たない」ことと KANBAN_PORT の逃げ道を示す", () => {
		assert.match(r.log, /refusing to reuse stale server: expected v[\d.]+, got vunknown/, r.log);
		assert.match(r.log, /old kanban/, r.log);
		assert.match(r.log, /not found/, r.log);
		assert.match(r.log, /KANBAN_PORT=8790/, r.log);
	});
	await check("#83 pid を持たない握り手は「pid 不明」と明示する", () => {
		assert.match(r.log, /pid unknown \(pre-#66 kanban reports no pid\)/, r.log);
	});
}

// --- B. 版も pid も名乗る古い kanban -----------------------------------------
{
	const port = await freePort();
	const STARTED = 1700000000000; // 2023-11-14T22:13:20.000Z
	const s = await squat(port, (req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		if (req.url === "/api/selftest") {
			res.end(JSON.stringify({ ok: true, checks: [], identity: { version: "0.0.1", startedAt: STARTED, pid: 424242 } }));
			return;
		}
		res.end(JSON.stringify({ cards: [] }));
	});
	const r = await runScenario({
		home: `${join(WORK, "pidknown")}`,
		port,
		body: `out.log = await waitLog(/refusing to reuse stale server/);
out.state = t.apiState();
out.sinceDecision = (await t.decideReuse({ reachable: true, version: "0.0.1", pid: 424242, startedAt: ${STARTED} }), t.apiState());
out.probe = await t.probe();
out.finalLog = readLog();`,
	});
	await s.close();

	await check("#83 decideReuse: version 不一致は stale", () => {
		assert.equal(r.code, 0, r.stderr);
		assert.equal(r.result.state, "stale", `apiState: ${r.result.state}`);
		assert.equal(r.result.sinceDecision, "stale");
	});
	await check("#83 stale ログは pid と startedAt を出す（どのプロセスを殺すか言える）", () => {
		assert.match(r.log, /got v0\.0\.1, pid 424242 \(started 2023-11-14T22:13:20\.000Z\)/, r.log);
	});
	await check("#83 pid を名乗る握り手は probe にも pid が乗る", () => {
		assert.equal(r.result.probe.pid, 424242, `probe: ${JSON.stringify(r.result.probe)}`);
		assert.equal(r.result.probe.version, "0.0.1");
	});
}

// --- C. kanban ではない何か（selftest も dashboard も 404）-------------------
{
	const port = await freePort();
	const s = await squat(port, (_req, res) => {
		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: false, error: "not found" }));
	});
	const r = await runScenario({
		home: `${join(WORK, "notkanban")}`,
		port,
		body: `out.log = await waitLog(/refusing to reuse stale server/);
out.probe = await t.probe();
out.finalLog = readLog();`,
	});
	await s.close();

	await check("#83 probe: selftest も dashboard も 404 なら kanban ではない", () => {
		assert.equal(r.result.probe.reachable, true);
		assert.equal(r.result.probe.servesDashboard, false, `probe: ${JSON.stringify(r.result.probe)}`);
		// #83b: /api/kanban も /api/kanban.html も 404 なので、kanban の指紋は 1 つも無い
		assert.equal(r.result.probe.servesBoard, false, `probe: ${JSON.stringify(r.result.probe)}`);
		assert.equal(r.result.probe.servesLegacyPanel, false, `probe: ${JSON.stringify(r.result.probe)}`);
	});
	await check("#83 ログは「kanban ではない」と言い、netstat/ss を案内する", () => {
		assert.match(r.log, /not a kanban/, r.log);
		assert.match(r.log, new RegExp(`netstat -ano \\| findstr :${port}`), r.log);
		assert.match(r.log, new RegExp(`ss -tlnp \\| grep ${port}`), r.log);
	});
}

// --- D. 何も答えない握り手 → 4 回失敗して API DOWN + 診断ヒント --------------
{
	const port = await freePort();
	// HTTP を話さない握り手（accept 即切断）。probe は到達不能、bind は EADDRINUSE。
	const s = netServer((sock) => sock.destroy());
	await new Promise((resolve) => s.listen(port, "0.0.0.0", resolve));
	const r = await runScenario({
		home: `${join(WORK, "down")}`,
		port,
		body: `out.log = await waitLog(/API DOWN/);
out.state = t.apiState();`,
	});
	await new Promise((resolve) => s.close(resolve));

	await check("#83 4 回失敗したら API DOWN", () => {
		assert.equal(r.code, 0, r.stderr);
		assert.match(r.log, /API DOWN: no listener on 0\.0\.0\.0:\d+ after 4 attempts/, r.log);
		assert.equal(r.result.state, "down");
	});
	await check("#83 API DOWN のログは netstat と netsh を別行で案内する", () => {
		assert.match(r.log, new RegExp(`netstat -ano \\| findstr :${port}`), r.log);
		assert.match(r.log, /netsh int ipv4 show excludedportrange protocol=tcp/, r.log);
		// 1 行に詰め込まない（フッタが読めなくなる）
		const lines = r.log.split("\n").filter((l) => /diagnostics/.test(l));
		assert.equal(lines.length, 2, `診断行数: ${JSON.stringify(lines)}`);
		for (const l of lines) assert.ok(l.length < 220, `長すぎる: ${l.length}`);
	});
}

// --- F. #83b 古い世代の kanban（/api/kanban 200, /api/kanban.html 200, / と dashboard は 404）
// 8789 の実測そのままの指紋。dashboard 単独で診断すると「kanban ではない」と誤診する。
// 世代を言い当てて「pi-web を再起動しろ」まで案内できること。
{
	const port = await freePort();
	const s = await squat(port, (req, res) => {
		if (req.url === "/api/kanban") {
			res.writeHead(200, { "content-type": "application/json" });
			// 古い世代でも ok と sessionId は返る（実測）。cards も含む。
			res.end(JSON.stringify({ ok: true, sessionId: "sess-1", cards: [{ id: 1, text: "x" }] }));
			return;
		}
		if (req.url === "/api/kanban.html") {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end("<!doctype html><html><head><title>KANBAN</title></head><body></body></html>");
			return;
		}
		// / も /api/dashboard も無い世代
		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: false, error: "not found" }));
	});
	const r = await runScenario({
		home: `${join(WORK, "legacykanban")}`,
		port,
		body: `out.log = await waitLog(/refusing to reuse stale server/);
out.probe = await t.probe();
out.state = t.apiState();`,
	});
	await s.close();

	await check("#83b 古い世代の指紋: board 200 / legacyPanel 200 / dashboard 404", () => {
		assert.equal(r.code, 0, r.stderr);
		assert.equal(r.result.probe.reachable, true, `probe: ${JSON.stringify(r.result.probe)}`);
		assert.equal(r.result.probe.servesBoard, true, `probe: ${JSON.stringify(r.result.probe)}`);
		assert.equal(r.result.probe.servesLegacyPanel, true, `probe: ${JSON.stringify(r.result.probe)}`);
		assert.equal(r.result.probe.servesDashboard, false, `probe: ${JSON.stringify(r.result.probe)}`);
		assert.equal(r.result.state, "stale");
	});
	await check("#83b 古い世代は「kanban だが古い / pi-web 再起動」と診断する（kanban ではない、と言わない）", () => {
		assert.match(r.log, /old kanban/, r.log);
		assert.match(r.log, /再起動/, r.log);
		assert.doesNotMatch(r.log, /not a kanban/, r.log);
	});
	await check("#83b 古い世代の診断は / を開くと not found になる理由まで言う", () => {
		assert.match(r.log, /not found/, r.log);
		assert.match(r.log, /KANBAN_PORT=8790/, r.log);
	});
	await check("#83b 診断行は 1 行 118 字以内に収まる（footer の制約）", () => {
		const lines = r.log.split("\n").filter((l) => /kanban: /.test(l));
		assert.ok(lines.length > 0, r.log);
		for (const l of lines) {
			const body = l.replace(/^.*?kanban: /, "");
			assert.ok(body.length <= 118, `${body.length} 字: ${body}`);
		}
	});
}

// --- G. #83b 現行世代の kanban（/api/kanban 200, /api/dashboard 200, kanban.html 404） --
{
	const port = await freePort();
	const s = await squat(port, (req, res) => {
		if (req.url === "/api/kanban") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true, sessionId: null, global: { cards: [] }, session: { cards: [] }, modes: {} }));
			return;
		}
		if (req.url === "/api/dashboard") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true, html: "<!doctype html>" }));
			return;
		}
		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: false, error: "not found" }));
	});
	const r = await runScenario({
		home: `${join(WORK, "currentkanban")}`,
		port,
		body: `out.log = await waitLog(/refusing to reuse stale server/);
out.probe = await t.probe();
out.state = t.apiState();
// 版を名乗る握り手の経路（identity は指紋を集めないので直接渡す）
await t.decideReuse({ reachable: true, version: "0.0.1", pid: 555 });
out.finalLog = readLog();`,
	});
	await s.close();

	await check("#83b 現行世代の指紋: board 200 / dashboard 200 / legacyPanel 404", () => {
		assert.equal(r.code, 0, r.stderr);
		assert.equal(r.result.probe.servesBoard, true, `probe: ${JSON.stringify(r.result.probe)}`);
		assert.equal(r.result.probe.servesDashboard, true, `probe: ${JSON.stringify(r.result.probe)}`);
		assert.equal(r.result.probe.servesLegacyPanel, false, `probe: ${JSON.stringify(r.result.probe)}`);
	});
	await check("#83b 現行世代は版不一致として version と pid を出す（従来通り）", () => {
		assert.match(r.log, /got v0\.0\.1, pid 555/, r.log);
		assert.doesNotMatch(r.log, /再起動/, r.log);
	});
	await check("#83b 現行世代（dashboard あり・kanban.html なし）は「旧世代」扱いにしない", () => {
		assert.match(r.log, /old kanban: \/api\/dashboard answers, \/ does not/, r.log);
	});
}

// --- E. KANBAN_PORT で別ポートに逃げられる -----------------------------------
{
	const port = await freePort();
	const r = await runScenario({
		home: `${join(WORK, "escape")}`,
		port,
		body: `out.log = await waitLog(/listening on/);
out.probe = await t.probe();
out.state = t.apiState();`,
	});

	await check("#83 KANBAN_PORT の別ポートで listen できる", () => {
		assert.equal(r.code, 0, r.stderr);
		assert.match(r.log, new RegExp(`listening on 0\\.0\\.0\\.0:${port} \\(attempt 1\\)`), r.log);
		assert.equal(r.result.state, "up");
	});
	await check("#83 逃げた先の selftest は自分自身の identity を返す", () => {
		assert.equal(r.result.probe.version, PKG_VERSION, `probe: ${JSON.stringify(r.result.probe)}`);
	});
}

console.log(`${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
