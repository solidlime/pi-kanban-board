// serve の期限（既定7日 / permanent / 410 / sweep）の自己検証。
// フレームワーク無しで `node tests/kanban-serve-expiry.test.mjs`。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as netServer } from "node:net";
import { createRequire } from "node:module";
import { authFetch } from "./helpers/token.mjs";

// #83b: HTTP routes need the server token now; tf = fetch + the kb_auth cookie.
const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-serve-expiry-home";
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
const mod = await jiti.import(new URL("../extensions/kanban.ts", import.meta.url).pathname);

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

const SITE = `${HOME_DIR}/workspace/site`;
const PAGE = `${SITE}/page.html`;
writeFileSync(PAGE, "<h1>page</h1>");
const SERVE_JSON = `${HOME_DIR}/.pi/kanban/serve.json`;
const entriesOnDisk = () => JSON.parse(readFileSync(SERVE_JSON, "utf8")).entries;
const DAY = 24 * 60 * 60 * 1000;
const OLD = new Date(Date.now() - 8 * DAY).toISOString();
const FRESH = new Date().toISOString();

// --- 0. 起動時 sweep: 期限切れは mod.default 時点で serve.json から消える ---------
const START_ID = "aaaaaaaaaaaaaaaa";
writeFileSync(
	SERVE_JSON,
	JSON.stringify({ entries: [{ id: START_ID, path: PAGE, createdAt: OLD }] }),
);

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
const testHook = mod.default(pi).__test;
for (let i = 0; i < 40; i++) {
	try {
		if ((await tf(`http://127.0.0.1:${PORT}/api/kanban`)).ok) break;
	} catch {
		// まだ listen していない
	}
	await new Promise((r) => setTimeout(r, 100));
}

const base = `http://127.0.0.1:${PORT}`;
const serve = tools.get("serve");
const call = (args) => serve.execute("t", args, null, () => {});

check("起動時 sweep が期限切れを実削除する", () => {
	const now = entriesOnDisk();
	assert.ok(!now.some((e) => e.id === START_ID), JSON.stringify(now));
});

// --- 1. 4 種類のエントリを用意 ------------------------------------------------
const EXPIRED_ID = "1111111111111111";
const FRESH_ID = "2222222222222222";
const PERM_ID = "3333333333333333";
const NOCT_ID = "4444444444444444"; // createdAt 無し = 触らない
writeFileSync(
	SERVE_JSON,
	JSON.stringify({
		entries: [
			{ id: EXPIRED_ID, path: PAGE, createdAt: OLD },
			{ id: FRESH_ID, path: PAGE, createdAt: FRESH },
			{ id: PERM_ID, path: PAGE, createdAt: OLD, permanent: true },
			{ id: NOCT_ID, path: PAGE },
		],
	}),
);

const get = async (p) => {
	const res = await tf(`${base}${p}`);
	return { status: res.status, body: await res.text() };
};

const expired = await get(`/serve/${EXPIRED_ID}`);
check("期限切れは 410 Gone", () => {
	assert.equal(expired.status, 410, `got ${expired.status} body=${expired.body}`);
	const parsed = JSON.parse(expired.body);
	assert.equal(parsed.ok, false);
	assert.equal(parsed.error, "expired");
});
{
	const r = await get(`/serve/${FRESH_ID}`);
	check("期限内は 200", () => assert.equal(r.status, 200, `got ${r.status}`));
}
{
	const r = await get(`/serve/${PERM_ID}`);
	check("permanent は createdAt が古くても 200", () => assert.equal(r.status, 200, `got ${r.status}`));
}
{
	const r = await get(`/serve/${NOCT_ID}`);
	check("createdAt 無しは期限なしで 200", () => assert.equal(r.status, 200, `got ${r.status}`));
}
{
	const r = await get(`/serve/ffffffffffffffff`);
	check("未登録は 404（410 と区別）", () => assert.equal(r.status, 404, `got ${r.status}`));
}
{
	const res = await tf(`${base}/serve/${EXPIRED_ID}/_inbox/x.txt`, {
		method: "POST",
		body: "hello",
	});
	check("_inbox POST も期限切れは 410", () => assert.equal(res.status, 410, `got ${res.status}`));
}

// --- 2. 一覧系は期限切れを隠す ------------------------------------------------
{
	const listed = await call({ action: "list" });
	const ids = (listed.details?.entries ?? []).map((e) => e.id);
	check("serve list は期限切れを出さない", () => {
		assert.ok(!ids.includes(EXPIRED_ID), ids.join(","));
		assert.ok(ids.includes(FRESH_ID));
		assert.ok(ids.includes(PERM_ID));
		assert.ok(ids.includes(NOCT_ID));
	});
}

{
	const dash = await (await tf(`${base}/api/dashboard`)).json();
	check("dashboard の serve は期限切れも残し permanent/expiresAt を返す", () => {
		const e = dash.serve.find((s) => s.id === EXPIRED_ID);
		assert.ok(e, "期限切れが dashboard から消えている");
		const p = dash.serve.find((s) => s.id === PERM_ID);
		assert.equal(p.permanent, true);
		assert.equal(p.expiresAt, "");
		const f = dash.serve.find((s) => s.id === FRESH_ID);
		assert.equal(f.permanent, false);
		assert.equal(f.expiresAt, new Date(Date.parse(FRESH) + 7 * DAY).toISOString());
		const n = dash.serve.find((s) => s.id === NOCT_ID);
		assert.equal(n.expiresAt, "");
	});
	check("dashboard の残り時間表示に permanent / expiresAt を使う実装がある", () => {
		// 実ファイル側は表示文字列を含む（vm 無しでも template の欠落を検出する）
		const html = readFileSync(`${HOME_DIR}/.pi/kanban/dashboard.html`, "utf8");
		for (const frag of ['"永久"', '"期限切れ"', 'serveLeft(v, nowMs)', 'action: "permanent"']) {
			assert.ok(html.includes(frag), `dashboard.html に ${frag} が無い`);
		}
	});
}

// --- 3. /api/serve の永久トグル ----------------------------------------------
{
	const on = await tf(`${base}/api/serve?action=permanent&id=${FRESH_ID}&value=1`);
	const body = await on.json();
	check("action=permanent&value=1 で permanent:true", () => {
		assert.equal(on.status, 200, `got ${on.status}`);
		assert.equal(body.ok, true);
		assert.equal(body.permanent, true);
		assert.equal(entriesOnDisk().find((e) => e.id === FRESH_ID).permanent, true);
	});
	const off = await tf(`${base}/api/serve?action=permanent&id=${FRESH_ID}&value=0`);
	{
		const b = await off.json();
		check("value=0 で permanent が消える", () => {
			assert.equal(off.status, 200, `got ${off.status}`);
			assert.equal(b.permanent, false);
			assert.equal(entriesOnDisk().find((e) => e.id === FRESH_ID).permanent, undefined);
		});
	}
	{
		const r = await tf(`${base}/api/serve?action=permanent&id=ffffffffffffffff&value=1`);
		check("未登録 id の permanent は 404", () => assert.equal(r.status, 404, `got ${r.status}`));
	}
}

// --- 4. serve ツール add の permanent ----------------------------------------
{
	const other = `${SITE}/perm.html`;
	writeFileSync(other, "p");
	const added = await call({ action: "add", path: other, permanent: true });
	check("serve add permanent=true がエントリに載る", () => {
		assert.equal(added.isError, undefined, JSON.stringify(added));
		const e = entriesOnDisk().find((x) => x.id === added.details.id);
		assert.ok(e, "登録されていない");
		assert.equal(e.permanent, true);
		assert.equal(typeof e.createdAt, "string");
	});
	// 同じパスの再 add（permanent 無し）は既存 permanent を落とさない
	const again = await call({ action: "add", path: other });
	check("同じパスの再 add は permanent を保持する", () => {
		assert.equal(again.details.id, added.details.id);
		assert.equal(entriesOnDisk().find((x) => x.id === again.details.id).permanent, true);
	});
}

// --- 5. sweep は期限切れだけを消し、createdAt 無しと permanent は残す ----------
check("sweepServe は期限切れだけ実削除する", () => {
	testHook.sweepServe();
	const now = entriesOnDisk();
	assert.ok(!now.some((e) => e.id === EXPIRED_ID), "期限切れが残っている");
	for (const id of [FRESH_ID, PERM_ID, NOCT_ID]) {
		assert.ok(now.some((e) => e.id === id), `${id} を消してしまった`);
	}
});

// --- 6. 期限切れでも remove はできる（掃除経路を塞がない） ---------------------
{
	writeFileSync(
		SERVE_JSON,
		JSON.stringify({ entries: [{ id: EXPIRED_ID, path: PAGE, createdAt: OLD }] }),
	);
	const r = await tf(`${base}/api/serve?action=remove&id=${EXPIRED_ID}`);
	check("期限切れエントリの remove は 200", () => assert.equal(r.status, 200, `got ${r.status}`));
}

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
