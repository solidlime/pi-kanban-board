// #83b: the board listener is on 0.0.0.0 and every route used to be open. This file pins
// the replacement: a 64-hex token in ~/.pi/kanban/token (0600), `GET /?token=` swapping it
// for an HttpOnly cookie and 303-ing to the bare path, and `/api/*` + `/serve/*` refusing
// anything without it.
//
// Each scenario runs in a child process: `ensureToken` caches in module scope and the HTTP
// server binds once per process, so "restart" has to mean a real process.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as netServer } from "node:net";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const JITI = "/root/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.cjs";
const WORK = "/tmp/kb83b-token-home";
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
 * One isolated child. `body` runs after the module is imported and has `mod`, `pi`,
 * `tools` (registerTool captures), `home` and `out`; it prints `__RESULT__<json>` and exits.
 * `mode: "serve"` instead waits for the listener and idles until killed, so the parent can
 * talk HTTP to a real server.
 */
function runHarness({ home, port, body, keepAlive }) {
	const harness = `${home}/harness-${port}-${keepAlive ? "srv" : "one"}.mjs`;
	mkdirSync(`${home}/.pi/kanban/sessions`, { recursive: true });
	writeFileSync(
		harness,
		`import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { createJiti } = require(${JSON.stringify(JITI)});
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(${JSON.stringify(`${ROOT}/extensions/kanban.ts`)});
const tools = new Map();
const commands = new Map();
const pi = {
  registerCommand(name, spec) { commands.set(name, spec); },
  registerTool(spec) { tools.set(spec.name, spec); },
  appendEntry() {},
  on() {},
  sendUserMessage() {},
};
mod.default(pi);
const home = ${JSON.stringify(home)};
const port = ${port};
const readTokenFromDisk = () => readFileSync(home + "/.pi/kanban/token", "utf8").trim();
${
	keepAlive
		? `for (let i = 0; i < 400; i++) {
  try {
    const r = await fetch("http://127.0.0.1:" + port + "/api/kanban", { headers: { Cookie: "kb_auth=" + readTokenFromDisk() } });
    if (r.ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 25));
}
console.log("__READY__");
setInterval(() => {}, 1 << 30);`
		: `const out = {};
${body}
console.log("__RESULT__" + JSON.stringify(out));
process.exit(0);`
}`,
	);
	const child = spawn(process.execPath, [harness], {
		env: { ...process.env, HOME: home, KANBAN_PORT: String(port) },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (d) => (stdout += d));
	child.stderr.on("data", (d) => (stderr += d));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`harness timeout\n${stdout}\n${stderr}`)), 30_000);
		const done = (value) => {
			clearTimeout(timer);
			resolve(value);
		};
		if (keepAlive) {
			const poll = setInterval(() => {
				if (!stdout.includes("__READY__")) return;
				clearInterval(poll);
				done({ child, stdout, stderr, stop: () => stop(child) });
			}, 25);
			child.on("exit", (code) => {
				if (stdout.includes("__READY__")) return;
				clearInterval(poll);
				reject(new Error(`harness exited ${code} before ready\n${stdout}\n${stderr}`));
			});
		} else {
			child.on("exit", (code) => {
				const idx = stdout.indexOf("__RESULT__");
				done({ code, stderr, result: idx === -1 ? null : JSON.parse(stdout.slice(idx + 10).split("\n")[0]) });
			});
		}
	});
}

const stop = (child) =>
	new Promise((resolve) => {
		if (child.exitCode !== null) return resolve();
		child.on("exit", resolve);
		child.kill("SIGKILL");
	});

const tokenPath = (home) => `${home}/.pi/kanban/token`;
const mode = (p) => statSync(p).mode & 0o777;

/** A fresh isolated HOME with a running server, plus the token it generated. */
async function boot(homeName, { preToken } = {}) {
	const home = `${WORK}/${homeName}`;
	rmSync(home, { recursive: true, force: true });
	mkdirSync(`${home}/.pi/kanban/sessions`, { recursive: true });
	// #11: a hand-made 0644 file must be corrected, not trusted.
	if (preToken !== undefined) writeFileSync(tokenPath(home), `${preToken}\n`, { mode: 0o644 });
	const port = await freePort();
	const srv = await runHarness({ home, port, body: "", keepAlive: true });
	return { home, port, token: readFileSync(tokenPath(home), "utf8").trim(), srv, base: `http://127.0.0.1:${port}` };
}

// --- 1. startup creates the token, 0600 ---------------------------------------
const A = await boot("a");
await check("1. 起動時に ~/.pi/kanban/token が 0600 で生成される", () => {
	assert.equal(mode(tokenPath(A.home)), 0o600, `mode=${mode(tokenPath(A.home)).toString(8)}`);
	assert.match(A.token, /^[0-9a-f]{64}$/);
});
await check("1b. server.log にトークンが書かれていない", () => {
	const log = existsSync(`${A.home}/.pi/kanban/server.log`)
		? readFileSync(`${A.home}/.pi/kanban/server.log`, "utf8")
		: "";
	assert.ok(!log.includes(A.token), "トークンがログに漏れている");
});
await check("1c. 起動が2回目の ensureToken でも同じトークン（再生成しない）", async () => {
	const again = await fetch(`${A.base}/api/dashboard`, { headers: { Cookie: `kb_auth=${A.token}` } });
	assert.equal(again.status, 200);
	assert.equal(readFileSync(tokenPath(A.home), "utf8").trim(), A.token);
});
await check("1d. ~/.pi/kanban は 0700（#85: ディレクトリごと閉じる）", () => {
	assert.equal(mode(`${A.home}/.pi/kanban`), 0o700, `mode=${mode(`${A.home}/.pi/kanban`).toString(8)}`);
});

// --- 2/3. GET /?token= --------------------------------------------------------
await check("2. GET /?token=<正> は 303 + Set-Cookie + Location: /", async () => {
	const r = await fetch(`${A.base}/?token=${A.token}`, { redirect: "manual" });
	assert.equal(r.status, 303, `status=${r.status}`);
	assert.equal(r.headers.get("location"), "/", "クエリ無しの / へ飛ばすこと");
	const cookie = r.headers.get("set-cookie") ?? "";
	assert.match(cookie, new RegExp(`kb_auth=${A.token}`));
	assert.match(cookie, /HttpOnly/i);
	assert.match(cookie, /SameSite=Lax/i);
	assert.match(cookie, /Path=\//);
	assert.match(cookie, /Max-Age=2592000/, "#85: 30日");
	assert.ok(!/Secure/i.test(cookie), "http で使うので Secure は付けない");
	assert.equal(await r.text(), "", "本文は空");
});
await check("3. GET /?token=<誤> は 401", async () => {
	const r = await fetch(`${A.base}/?token=${"0".repeat(64)}`, { redirect: "manual" });
	assert.equal(r.status, 401, `status=${r.status}`);
});

// --- 4/5/6/7. /api/dashboard --------------------------------------------------
const dash = (headers) => fetch(`${A.base}/api/dashboard`, { headers, redirect: "manual" });
await check("4. GET /api/dashboard トークン無し → 401", async () => {
	const r = await dash();
	assert.equal(r.status, 401, `status=${r.status}`);
	assert.equal((await r.json()).error, "unauthorized");
});
await check("5. GET /api/dashboard?token=<正> → 200", async () => {
	const r = await fetch(`${A.base}/api/dashboard?token=${A.token}`);
	assert.equal(r.status, 200, `status=${r.status}`);
});
await check("6. Cookie: kb_auth=<正> → 200", async () => {
	const r = await dash({ Cookie: `kb_auth=${A.token}` });
	assert.equal(r.status, 200, `status=${r.status}`);
});
await check("7. Cookie: kb_auth=<誤> → 401", async () => {
	const r = await dash({ Cookie: `kb_auth=${"1".repeat(64)}` });
	assert.equal(r.status, 401, `status=${r.status}`);
});
await check("7b. 長さの違うトークンも 401（timingSafeEqual の早期 return 側）", async () => {
	const r = await dash({ Cookie: `kb_auth=${A.token.slice(0, 32)}` });
	assert.equal(r.status, 401, `status=${r.status}`);
});
await check("7c. 別名の Cookie は無視される", async () => {
	const r = await dash({ Cookie: `token=${A.token}` });
	assert.equal(r.status, 401, `status=${r.status}`);
});

// --- 8/9. no token leaks ------------------------------------------------------
await check("8. 401 の本文にトークン値が含まれない", async () => {
	const bodies = [
		await (await dash()).text(),
		await (await fetch(`${A.base}/api/dashboard?token=${"2".repeat(64)}`)).text(),
		await (await fetch(`${A.base}/?token=${"3".repeat(64)}`, { redirect: "manual" })).text(),
		await (await fetch(`${A.base}/api/add?text=x&scope=global`)).text(),
	];
	for (const b of bodies) assert.ok(!b.includes(A.token), `本文にトークン: ${b}`);
});
await check("9. Cookie 無しの GET / も 200 でダッシュボードを配る（#85: 入口だから）", async () => {
	const r = await fetch(`${A.base}/`, { redirect: "manual" });
	assert.equal(r.status, 200, `status=${r.status}`);
	assert.match(r.headers.get("content-type") ?? "", /text\/html/);
	assert.equal(r.headers.get("set-cookie"), null, "Cookie 無しの / は Cookie を配らない");
	const body = await r.text();
	// ログイン導線はページ内の JS(authFail) が出す。生の値はどこにも無い。
	assert.match(body, /id="banner"/);
	assert.match(body, /function authFail\(\)/);
	assert.match(body, /\/kanban url/);
	assert.ok(!body.includes(A.token), "ページにトークンが埋まっている");
});

// #80-⑩: a cross-origin page must not be able to frame the board and overlay its own
// controls — a clickjacked move/remove is a write the user never made. The token gate
// does not help here because the browser attaches the cookie to the frame's own loads.
await check("9b. GET / は他オリジンのフレームに載せない（#80-⑩）", async () => {
	const r = await fetch(`${A.base}/`, { redirect: "manual" });
	assert.equal(r.status, 200);
	assert.equal(r.headers.get("x-frame-options"), "SAMEORIGIN");
	assert.match(r.headers.get("content-security-policy") ?? "", /frame-ancestors 'self'/);
});

// --- protected surface --------------------------------------------------------
await check("10. 無認証で届く端点は無い（/api/*, /serve/*）", async () => {
	const paths = [
		"/api/kanban",
		"/api/sessions",
		"/api/modes?scope=global",
		"/api/selftest",
		"/api/add?text=x&scope=global",
		"/api/serve",
		"/serve/",
		"/serve/1/x.png",
		"/api/media/nope.png",
	];
	for (const p of paths) {
		const r = await fetch(`${A.base}${p}`, { redirect: "manual" });
		assert.equal(r.status, 401, `${p} -> ${r.status}`);
	}
	const post = await fetch(`${A.base}/api/selftest`, { method: "POST" });
	assert.equal(post.status, 401, `POST /api/selftest -> ${post.status}`);
});
await check("10b. 認証が通れば従来どおり（Origin ゲートは内側に残っている）", async () => {
	const r = await fetch(`${A.base}/api/add?text=auth_ok&scope=global`, {
		headers: { Cookie: `kb_auth=${A.token}` },
	});
	assert.equal(r.status, 200, `status=${r.status}`);
	const evil = await fetch(`${A.base}/api/add?text=evil&scope=global`, {
		headers: { Cookie: `kb_auth=${A.token}`, Origin: "http://evil.example" },
	});
	assert.equal(evil.status, 403, `cross-origin -> ${evil.status}`);
});

// --- 11. 0644 -> 0600 ---------------------------------------------------------
{
	const old = "a".repeat(64);
	const B = await boot("perm", { preToken: old });
	await check("11. 0644 のトークンファイルは起動時に 0600 へ是正される", () => {
		assert.equal(mode(tokenPath(B.home)), 0o600, `mode=${mode(tokenPath(B.home)).toString(8)}`);
	});
	await check("11b. 中身は書き換えない（既存トークンを尊重する）", () => {
		assert.equal(B.token, old);
		const r = fetch(`${B.base}/api/dashboard`, { headers: { Cookie: `kb_auth=${old}` } });
		return r.then((x) => assert.equal(x.status, 200));
	});
	await B.srv.stop();
}

// --- 12. delete + restart -----------------------------------------------------
{
	const C = await boot("rotate");
	const oldToken = C.token;
	await C.srv.stop();
	rmSync(tokenPath(C.home));
	const srv2 = await runHarness({ home: C.home, port: C.port, body: "", keepAlive: true });
	const newToken = readFileSync(tokenPath(C.home), "utf8").trim();
	await check("12. トークン削除＋再起動で新しいトークンが生成される", () => {
		assert.match(newToken, /^[0-9a-f]{64}$/);
		assert.notEqual(newToken, oldToken, "同じトークンが再生された");
		assert.equal(mode(tokenPath(C.home)), 0o600);
	});
	await check("12b. 古いトークンは 401、新しいトークンは 200", async () => {
		const stale = await fetch(`http://127.0.0.1:${C.port}/api/dashboard`, {
			headers: { Cookie: `kb_auth=${oldToken}` },
		});
		assert.equal(stale.status, 401, `stale -> ${stale.status}`);
		const fresh = await fetch(`http://127.0.0.1:${C.port}/api/dashboard`, {
			headers: { Cookie: `kb_auth=${newToken}` },
		});
		assert.equal(fresh.status, 200, `fresh -> ${fresh.status}`);
	});
	await srv2.stop();
}

// --- 13. the `kanban` tool's url action --------------------------------------
{
	const home = `${WORK}/tool`;
	rmSync(home, { recursive: true, force: true });
	const r = await runHarness({
		home,
		port: await freePort(),
		body: `const spec = tools.get("kanban");
out.actions = spec.parameters.properties.action.anyOf.map((t) => t.const);
out.res = await spec.execute("t1", { action: "url" }, undefined, undefined, {
  sessionManager: { getSessionId: () => "sid1", getSessionName: () => undefined, getEntries: () => [] },
  ui: { notify() {}, setWidget() {} },
});`,
	});
	await check("13. kanban ツールの url アクションが ?token= 付き URL を返す", () => {
		assert.equal(r.code, 0, r.stderr);
		assert.ok(r.result.actions.includes("url"), `actions=${JSON.stringify(r.result.actions)}`);
		const text = r.result.res.content[0].text;
		const tok = readFileSync(tokenPath(home), "utf8").trim();
		assert.match(text, /^http:\/\/[^/]+:\d+\/\?token=[0-9a-f]{64}$/, `url=${text}`);
		assert.ok(text.endsWith(`?token=${tok}`), `URL のトークンが実ファイルと違う: ${text}`);
	});
}

// --- 14. /kanban url command -------------------------------------------------
{
	const home = `${WORK}/cmd`;
	rmSync(home, { recursive: true, force: true });
	const r = await runHarness({
		home,
		port: await freePort(),
		body: `const notes = [];
const cmds = [...commands.keys()];
await commands.get("kanban").handler("url", { sessionManager: { getSessionId: () => "sid1", getSessionName: () => undefined, getEntries: () => [] }, ui: { notify(m) { notes.push(m); }, setWidget() {} } });
out.cmds = cmds;
out.notes = notes;`,
	});
	await check("14. /kanban url がトークン付き URL を ctx.ui.notify で出す", () => {
		assert.equal(r.code, 0, r.stderr);
		assert.ok(r.result.cmds.includes("kanban"), `commands=${JSON.stringify(r.result.cmds)}`);
		const tok = readFileSync(tokenPath(home), "utf8").trim();
		const line = r.result.notes.find((n) => n.includes("?token="));
		assert.ok(line, `notify=${JSON.stringify(r.result.notes)}`);
		assert.ok(line.includes(`?token=${tok}`), `通知のトークンが実ファイルと違う: ${line}`);
	});
}

await A.srv.stop();

for (const f of failures) console.log(`  FAIL ${f}`);
console.log(`kanban-token-auth: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
