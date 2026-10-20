// #67 phase A (認証なしで今すぐ閉じられる穴) の自己検証。フレームワーク無しで
// `node tests/kanban-security-phaseA.test.mjs`。HOME と KANBAN_PORT を差し替えるので
// 本番の ~/.pi/kanban と 8789 には触れない。
// 固定するもの: (1) /serve の能動型 MIME 降格 + attachment + nosniff / (2) 書き込み系の
// cross-origin 門前払い（ヘッダ無しは通す）/ (3) /api/kanban の sid 規則 / (4) 死んだルート。
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer as netServer } from "node:net";
import http from "node:http";
import { createRequire } from "node:module";
import { authFetch, tokenHeader } from "./helpers/token.mjs";

// #83b: HTTP routes need the server token now; tf = fetch + the kb_auth cookie.
const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-security-phaseA-home";
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

/**
 * http.request 直叩き。fetch はヘッダを足すので、無ヘッダの再現にはこちらを使う。
 * #83b: 既定でトークンを付ける。付けないと全部 401 で止まり、このファイルが試したい
 * Origin / MIME ゲートに届かない。認証そのものを試す箇所だけ `{ noToken: true }`。
 */
function send(method, path, { headers = {}, body, noToken = false } = {}) {
	if (!noToken && !headers.Cookie && !headers.cookie) headers = { ...headers, Cookie: tokenHeader() };
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

writeFileSync(`${SITE}/x.html`, "<script>alert(1)</script>");
writeFileSync(`${SITE}/x.svg`, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
writeFileSync(`${SITE}/x.js`, "alert(1)");
writeFileSync(`${SITE}/x.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
writeFileSync(`${SITE}/x.txt`, "plain note");

// --- 1. 能動型 MIME は落ちる ---------------------------------------------------
for (const name of ["x.html", "x.svg", "x.js"]) {
	const res = await send("GET", `/serve/${id}/${name}`);
	await checkAsync(`${name} は text/plain に降格`, async () => {
		assert.equal(res.status, 200, `status=${res.status} body=${res.body}`);
		assert.equal((res.headers["content-type"] ?? "").split(";")[0], "text/plain");
	});
	await checkAsync(`${name} は Content-Disposition: attachment`, async () =>
		assert.equal(res.headers["content-disposition"], "attachment"));
	await checkAsync(`${name} に X-Content-Type-Options: nosniff`, async () =>
		assert.equal(res.headers["x-content-type-options"], "nosniff"));
}

{
	// 元から text/plain のファイルは降格されていないので attachment は付かない。
	const res = await send("GET", `/serve/${id}/x.txt`);
	await checkAsync("x.txt は text/plain のまま attachment 無し", async () => {
		assert.equal(res.headers["content-type"], "text/plain; charset=utf-8");
		assert.equal(res.headers["content-disposition"], undefined);
		assert.equal(res.body, "plain note");
	});
}

// --- 2. 画像は壊さない ---------------------------------------------------------
{
	const res = await send("GET", `/serve/${id}/x.png`);
	await checkAsync("x.png は image/png のまま", async () =>
		assert.equal(res.headers["content-type"], "image/png"));
	await checkAsync("x.png に attachment は付かない", async () =>
		assert.equal(res.headers["content-disposition"], undefined));
	await checkAsync("x.png にも nosniff は付く", async () =>
		assert.equal(res.headers["x-content-type-options"], "nosniff"));
}
{
	// 一覧・レジストリ・エラー応答も /serve 配下なら nosniff。
	const listing = await send("GET", `/serve/${id}/`);
	const missing = await send("GET", `/serve/${id}/nope.png`);
	const registry = await send("GET", `/serve/`);
	for (const [label, res] of [
		["一覧", listing],
		["404", missing],
		["レジストリ", registry],
	]) {
		await checkAsync(`/serve ${label} 応答にも nosniff`, async () =>
			assert.equal(res.headers["x-content-type-options"], "nosniff"));
	}
}

// --- 3. _inbox POST の cross-origin 門前払い -----------------------------------
const NOTE = JSON.stringify({ take: 1 });
{
	const res = await send("POST", `/serve/${id}/_inbox/cross.json`, {
		headers: { "Content-Type": "application/octet-stream", "Sec-Fetch-Site": "cross-site" },
		body: NOTE,
	});
	await checkAsync("Sec-Fetch-Site: cross-site の _inbox POST は 403", async () =>
		assert.equal(res.status, 403, `status=${res.status} body=${res.body}`));
}
{
	// #68: same-site は許可する（同一ホスト別ポートの右パネルが送る値）。cross-site だけが
	// 攻撃の印なので、線はそこに引く。
	const res = await send("POST", `/serve/${id}/_inbox/samesite.json`, {
		headers: { "Content-Type": "application/octet-stream", "Sec-Fetch-Site": "same-site", Origin: `http://127.0.0.1:${PORT}` },
		body: NOTE,
	});
	await checkAsync("same-site（同一ホスト別ポート）の _inbox POST は許可", async () => {
		assert.equal(res.status, 200, `status=${res.status} body=${res.body}`);
		assert.equal(JSON.parse(res.body).ok, true);
	});
}
{
	const res = await send("POST", `/serve/${id}/_inbox/ok.json`, {
		headers: { "Content-Type": "application/octet-stream", "Sec-Fetch-Site": "same-origin" },
		body: NOTE,
	});
	await checkAsync("Sec-Fetch-Site: same-origin の _inbox POST は通る", async () => {
		assert.equal(res.status, 200, `status=${res.status} body=${res.body}`);
		assert.equal(JSON.parse(res.body).ok, true);
	});
}
{
	const res = await send("POST", `/serve/${id}/_inbox/probe.json`, {
		headers: { "Content-Type": "application/octet-stream" },
		body: NOTE,
	});
	await checkAsync("Sec-Fetch-Site 無しの _inbox POST は通る (curl / 別 pi を壊さない)", async () => {
		assert.equal(res.status, 200, `status=${res.status} body=${res.body}`);
		assert.equal(JSON.parse(res.body).ok, true);
	});
}
{
	// Origin だけ嘘をつくブラウザ（Sec-Fetch-Site を送らない古い実装）も弾く。
	const res = await send("POST", `/serve/${id}/_inbox/origin.json`, {
		headers: {
			"Content-Type": "application/octet-stream",
			Origin: "http://evil.example",
			Host: `127.0.0.1:${PORT}`,
		},
		body: NOTE,
	});
	await checkAsync("Host と合わない Origin の _inbox POST は 403", async () =>
		assert.equal(res.status, 403, `status=${res.status} body=${res.body}`));
}

// --- 4. /api/host の cross-origin 門前払い -------------------------------------
{
	const res = await send("POST", "/api/host", {
		headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" },
		body: JSON.stringify({ host: "evil.example" }),
	});
	await checkAsync("Sec-Fetch-Site: cross-site の /api/host は 403", async () =>
		assert.equal(res.status, 403, `status=${res.status} body=${res.body}`));
}
{
	const res = await send("POST", "/api/host", {
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ host: "nas.local:8789" }),
	});
	await checkAsync("Sec-Fetch-Site 無しの /api/host は通る", async () => {
		assert.equal(res.status, 200, `status=${res.status} body=${res.body}`);
		assert.equal(JSON.parse(res.body).host, "nas.local:8789");
	});
}

// --- 5. /api/kanban の sid 規則 ------------------------------------------------
{
	const res = await send("GET", "/api/kanban?scope=session");
	await checkAsync("scope=session で sid 無しは 400", async () =>
		assert.equal(res.status, 400, `status=${res.status} body=${res.body}`));
}
{
	// 別セッションのボードが sid 無しで読めないこと（旧 activeSessionId フォールバックの再発防止）。
	const other = "other-session-sid";
	mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
	writeFileSync(
		`${HOME_DIR}/.pi/kanban/sessions/${other}.json`,
		JSON.stringify({ cards: [{ id: 1, text: "secret-other", col: "todo" }], nextId: 2 }),
	);
	const bare = await send("GET", "/api/kanban");
	const leak = await send("GET", `/api/kanban?sid=${other}`);
	await checkAsync("sid 無しの /api/kanban は他セッションのボードを返さない", async () => {
		assert.equal(bare.status, 200, `status=${bare.status}`);
		const j = JSON.parse(bare.body);
		assert.equal(j.sessionId, null);
		assert.doesNotMatch(bare.body, /secret-other/);
		// 明示した sid なら当然読める（GET は読み取りなので許可）。
		assert.equal(leak.status, 200);
		assert.match(leak.body, /secret-other/);
	});
}
{
	const res = await send("GET", "/api/kanban?scope=global");
	await checkAsync("scope=global は sid 無しでも 200", async () => {
		assert.equal(res.status, 200, `status=${res.status} body=${res.body}`);
		assert.equal(JSON.parse(res.body).ok, true);
	});
}

// --- 6. 死んだルート -----------------------------------------------------------
{
	const res = await send("GET", "/api/kanban.html");
	// #84: the template is gone, so the 404 branch went with it. A stale caller now falls
	// through to the board gate (400, sid required) — still "not served", which is all the
	// #83 generation probe needs.
	await checkAsync("/api/kanban.html は 404 ではなくボードゲートの 400", async () =>
		assert.equal(res.status, 400, `status=${res.status} body=${res.body.slice(0, 80)}`));
	check("KANBAN_HTML 定数は消えている（#84 の削除対象）", () => {
		assert.equal(typeof mod.KANBAN_HTML, "undefined");
	});
}

// --- 7. probeServer を壊していない (ヘッダ無し POST /api/selftest) --------------
{
	const res = await send("POST", "/api/selftest");
	await checkAsync("ヘッダ無し POST /api/selftest は 200 (probeServer 経路)", async () => {
		assert.equal(res.status, 200, `status=${res.status} body=${res.body.slice(0, 120)}`);
		assert.equal(JSON.parse(res.body).ok, true);
	});
	// probeServer 本体も叩いて identity が読めることまで見る。
	const probe = await mod.probeServer?.();
	if (probe !== undefined) {
		check("probeServer() が reachable を返す", () => assert.equal(probe.reachable, true));
	}
}

// --- 8. CORS ヘッダ ------------------------------------------------------------
{
	// #68: preflight も同じ判定。別ホストは 403（中身も CORS ヘッダも返さない）、
	// 同一ホストだけが 204 + reflect。攻撃元 Origin は別ホストそのもの。
	const evil = await send("OPTIONS", "/api/kanban", {
		headers: { Origin: "http://nas.local:8789", "Access-Control-Request-Method": "POST" },
	});
	await checkAsync("別ホストのプリフライトは 403 で CORS を許可しない", async () => {
		assert.equal(evil.status, 403, `status=${evil.status}`);
		assert.equal(evil.headers["access-control-allow-origin"], undefined);
	});
	const same = await send("OPTIONS", "/api/kanban", {
		headers: { Origin: base, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
	});
	await checkAsync("same-host のプリフライトは 204 + reflect", async () => {
		assert.equal(same.status, 204);
		assert.equal(same.headers["access-control-allow-origin"], base);
		assert.match(same.headers.vary ?? "", /Origin/i);
	});
	await checkAsync("Allow-Methods に POST が入っている", async () =>
		assert.match(same.headers["access-control-allow-methods"] ?? "", /POST/));
	await checkAsync("Access-Control-Max-Age が 600", async () =>
		assert.equal(same.headers["access-control-max-age"], "600"));
	await checkAsync("Allow-Headers に Content-Type が入っている", async () =>
		assert.match(same.headers["access-control-allow-headers"] ?? "", /Content-Type/i));
}

// --- 9. #68 段階0: provenance gate の回帰 --------------------------------------
// 経路リストは本体の isWritePath を写さず、ここに明示的に列挙する。本体の集合から
// 漏れた経路を将来追加したとき、この表を更新し忘れれば「攻撃が 200 で返る」で落ちる。
const WRITE_ROUTES = [
	`add?text=atk&col=todo&scope=session&sid=s1`,
	`move?id=1&col=done&scope=session&sid=s1`,
	`remove?id=1&scope=session&sid=s1`,
	`rename?id=1&text=atk&scope=session&sid=s1`,
	`modes?key=doingLoop&value=on&scope=session&sid=s1`,
	`interval?min=30&scope=session&sid=s1`,
	`stuck?n=3&scope=session&sid=s1`,
	`maxloops?n=5&scope=session&sid=s1`,
	`resume?scope=global`,
	`priority?id=1&priority=high&scope=session&sid=s1`,
	`schedule?id=1&at=2030-01-01T00:00:00Z&scope=session&sid=s1`,
];
for (const route of WRITE_ROUTES) {
	const res = await send("GET", `/api/${route}`, {
		// #83b: トークンは付ける。付けないと 401 で止まり、この表が試したい Origin ゲートに届かない。
		headers: { Origin: "http://evil.example", "Sec-Fetch-Site": "same-site", Host: `127.0.0.1:${PORT}`, Cookie: tokenHeader() },
	});
	const name = route.split("?")[0];
	// #80-⑥: GET の書き込みは Sec-Fetch-Site が same-origin でない時点で 405（Origin ゲートの
	// 手前）。表の主眼は「200 で攻撃が通らない」なので、止める層が 403 から 405 に変わった。
	await checkAsync(`GET /api/${name} は cross-origin で 403/405（200 にならない）`, async () => {
		assert.equal(res.status === 403 || res.status === 405, true, `status=${res.status} body=${res.body}`);
		assert.equal(JSON.parse(res.body).ok, false);
	});
}
for (const path of ["/api/upload?scope=session&sid=s1&col=todo&ext=png", "/api/selftest"]) {
	const res = await send("POST", path, {
		headers: {
			Origin: "http://evil.example",
			"Sec-Fetch-Site": "same-site",
			Host: `127.0.0.1:${PORT}`,
			"Content-Type": "application/octet-stream",
			Cookie: tokenHeader(),
		},
		body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
	});
	await checkAsync(`POST ${path.split("?")[0]} は cross-origin で 403`, async () =>
		assert.equal(res.status, 403, `status=${res.status} body=${res.body}`));
}
{
	// Origin: null は比較するホストを持たない。以前は素通りしていた穴。
	const res = await send("GET", `/api/add?text=nullorigin&col=todo&scope=session&sid=s1`, {
		headers: { Origin: "null", "Sec-Fetch-Site": "same-site", Cookie: tokenHeader() },
	});
	// #80-⑥: same-site の GET 書き込みは 405 が先。どちらにせよ 200 にはならない。
	await checkAsync("Origin: null の書き込みは 405/403", async () => {
		assert.equal(res.status === 403 || res.status === 405, true, `status=${res.status} body=${res.body}`);
	});
}
{
	// #83b: the "header-less GET is 200" line is gone. It used to protect the agent path,
	// but the agent's `kanban` tool never speaks HTTP (it builds a Card and calls
	// writeBoard in-process), and `probeServer` now presents the token. With no such
	// caller left, a header-less request is exactly the attack: LAN-reachable curl.
	const res = await send("GET", `/api/add?text=agent_ok&col=todo&scope=session&sid=s1`, { noToken: true });
	await checkAsync("ヘッダ無し・トークン無しの書き込みは 401", async () => {
		assert.equal(res.status, 401, `status=${res.status} body=${res.body}`);
		assert.equal(JSON.parse(res.body).error, "unauthorized");
	});
	const ok = await send("GET", `/api/add?text=agent_ok&col=todo&scope=session&sid=s1`, {
		headers: { Cookie: tokenHeader() },
	});
	await checkAsync("トークン付きのヘッダ無し Origin 書き込みは 200（多層防御の内側は従来通り）", async () => {
		assert.equal(ok.status, 200, `status=${ok.status} body=${ok.body}`);
		assert.equal(JSON.parse(ok.body).ok, true);
	});
}
{
	// 読み取り側に ACAO を漏らさない。登録エントリは絶対パスなので、ここが漏れると
	// 任意のページが ~/workspace 配下を読める。
	const res = await send("GET", "/serve/", { headers: { Origin: "http://evil.example", Cookie: tokenHeader() } });
	await checkAsync("/serve/ GET は別ホストの Origin に ACAO を付けない", async () => {
		assert.equal(res.status, 200, `status=${res.status}`);
		assert.equal(res.headers["access-control-allow-origin"], undefined);
		assert.match(res.headers.vary ?? "", /Origin/i);
	});
}

// --- 結果 ---------------------------------------------------------------------
for (const f of failures) console.log(`  FAIL ${f}`);
console.log(`kanban-security-phaseA: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
