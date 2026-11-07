// #60/#64: interactive 添付（アンケート html）の双方向。iframe は origin null で cookie を
// 持たないので、/api/ehr はトークン無しでも答える（Host ゲートは残る）。
// POST で 1 レコード追記 / GET で一覧 / value 128KB / レコード 50 件 cap。
// #64: 旧 /api/quiz は alias として同じ handler に届き、書き込みは新キー ehr:<id> に載る。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { createServer as netServer } from "node:net";
import { createRequire } from "node:module";
import { authFetch } from "./helpers/token.mjs";
import { useKanban } from "./helpers/board.mjs";
import { settleMigration, useMigrate } from "./helpers/migrate.mjs";

const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-quiz-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
process.env.HOME = HOME_DIR;
process.env.USERPROFILE = process.env.HOME;

const PORT = await new Promise((resolve) => {
	const s = netServer();
	s.listen(0, "127.0.0.1", () => {
		const { port } = s.address();
		s.close(() => resolve(port));
	});
});
process.env.KANBAN_PORT = String(PORT);

const require = createRequire(import.meta.url);
const { createJiti } = require(process.env.KANBAN_JITI ?? createRequire(import.meta.url).resolve("jiti"));
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url)));
useKanban(mod);
useMigrate(mod);
await settleMigration();

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
const eq = (a, b) => assert.deepEqual(a, b);

const commands = new Map();
const tools = new Map();
mod.default({
	registerCommand(name, def) {
		commands.set(name, def);
	},
	registerTool(def) {
		tools.set(def.name, def);
	},
	appendEntry() {},
	on() {},
	sendUserMessage() {},
});
for (let i = 0; i < 40; i++) {
	try {
		if ((await tf(`http://127.0.0.1:${PORT}/api/kanban`)).ok) break;
	} catch {
		// まだ listen していない
	}
	await new Promise((r) => setTimeout(r, 100));
}

const base = `http://127.0.0.1:${PORT}/api/ehr`;
const legacyBase = `http://127.0.0.1:${PORT}/api/quiz`;
const post = (id, key, value, init = {}) =>
	tf(`${base}?id=${id}&key=${encodeURIComponent(key)}&value=${encodeURIComponent(value)}`, {
		method: "POST",
		...init,
	});

// --- 1: POST -> GET roundtrip ---------------------------------------------------
{
	const r = await post(7, "q1", JSON.stringify({ q1: "yes" }));
	const body = await r.json();
	check("POST: 200 と ok/count", () => {
		assert.equal(r.status, 200);
		assert.equal(body.ok, true);
		assert.equal(body.count, 1);
	});
	const g = await tf(`${base}?id=7`);
	const rows = await g.json();
	check("GET: JSON 配列で 1 件", () => {
		assert.equal(g.status, 200);
		assert.equal(Array.isArray(rows), true);
		assert.equal(rows.length, 1);
	});
	check("GET: レコードは {at,key,value}", () => {
		assert.equal(typeof rows[0].at, "number");
		assert.equal(rows[0].key, "q1");
		assert.equal(JSON.parse(rows[0].value).q1, "yes");
	});
}

// --- 2: key フィルタ ------------------------------------------------------------
{
	await post(7, "q2", "second");
	const all = await (await tf(`${base}?id=7`)).json();
	const only = await (await tf(`${base}?id=7&key=q2`)).json();
	check("GET: key 無しは全件", () => eq(all.length, 2));
	check("GET: key=q2 は 1 件だけ", () => {
		assert.equal(only.length, 1);
		assert.equal(only[0].value, "second");
	});
	const other = await (await tf(`${base}?id=8`)).json();
	check("GET: 別カードは空配列", () => eq(other, []));
}

// --- 3: value 128KB 上限（canvas の dataURL が届く大きさ） -----------------------
{
	const big = "x".repeat(131073);
	const r = await post(9, "q", big);
	check("128KB 超: 413", () => assert.equal(r.status, 413));
	const ok = await post(9, "q", "x".repeat(131072));
	check("128KB ちょうど: 200", () => assert.equal(ok.status, 200));
}

// --- 4: 50 件 cap（古いものから落ちる） -----------------------------------------
{
	for (let i = 0; i < 55; i++) await post(10, "q", `v${i}`);
	const rows = await (await tf(`${base}?id=10`)).json();
	check("cap: 50 件に抑えられる", () => eq(rows.length, 50));
	check("cap: 最新が残る", () => eq(rows[rows.length - 1].value, "v54"));
	check("cap: 最古が落ちる", () => eq(rows[0].value, "v5"));
}

// --- 5: CORS（origin null の iframe から読めること） ---------------------------
{
	const g = await fetch(`${base}?id=7`, { headers: { Origin: "null" } });
	check("CORS/GET: Origin null でもトークン無しで 200", () => assert.equal(g.status, 200));
	check("CORS/GET: Access-Control-Allow-Origin: *", () =>
		eq(g.headers.get("access-control-allow-origin"), "*"),
	);
	const p = await fetch(`${base}?id=7&key=q1&value=v`, { method: "POST", headers: { Origin: "null" } });
	check("CORS/POST: Origin null の追記が通る", () => assert.equal(p.status, 200));
	check("CORS/POST: Access-Control-Allow-Origin: *", () =>
		eq(p.headers.get("access-control-allow-origin"), "*"),
	);
	const o = await fetch(base, { method: "OPTIONS", headers: { Origin: "null" } });
	check("CORS/OPTIONS: 204 + allow-origin/methods", () => {
		assert.equal(o.status, 204);
		assert.equal(o.headers.get("access-control-allow-origin"), "*");
		assert.match(String(o.headers.get("access-control-allow-methods")), /POST/);
	});
}

// --- 6: 入力検証 ---------------------------------------------------------------
{
	const bad = await tf(`${base}?id=x&key=q&value=v`, { method: "POST" });
	check("id が数値でない: 400", () => assert.equal(bad.status, 400));
	const noValue = await tf(`${base}?id=7&key=q`, { method: "POST" });
	check("value 無し: 400", () => assert.equal(noValue.status, 400));
	const noKey = await tf(`${base}?id=7&value=v`, { method: "POST" });
	check("key 無し: 400", () => assert.equal(noKey.status, 400));
}

// --- 7: #64 alias（旧 /api/quiz で POST → 新 /api/ehr で読める） -------------------
{
	const r = await tf(`${legacyBase}?id=11&key=old&value=via-alias`, { method: "POST" });
	check("alias: /api/quiz POST は 200", () => assert.equal(r.status, 200));
	const rows = await (await tf(`${base}?id=11&key=old`)).json();
	check("compat: alias で書いた回答が /api/ehr GET で読める", () => {
		assert.equal(rows.length, 1);
		assert.equal(rows[0].value, "via-alias");
	});
	const viaAlias = await (await tf(`${legacyBase}?id=11`)).json();
	check("alias: GET も同じ handler（同じ 1 件）", () => assert.equal(viaAlias.length, 1));
	const o = await fetch(legacyBase, { method: "OPTIONS", headers: { Origin: "null" } });
	check("alias: OPTIONS も CORS を返す", () =>
		eq(o.headers.get("access-control-allow-origin"), "*"),
	);
}

// --- 8: #64 旧 meta key `quiz:<id>` の read fallback ------------------------------
{
	// 改名前のレコードは meta に `quiz:<id>` で残っている。直接その 1 行だけを書く。
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(`${HOME_DIR}/.pi/kanban/boards.sqlite`);
	const legacy = [{ at: 1700000000000, key: "q", value: "before-rename" }];
	db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)").run("quiz:12345", JSON.stringify(legacy));
	db.close();
	const rows = await (await tf(`${base}?id=12345&key=q`)).json();
	check("fallback: 新キーが無い時は旧 quiz:<id> を読む", () => {
		assert.equal(rows.length, 1);
		assert.equal(rows[0].value, "before-rename");
	});
	// 追記すると新キーに載り、以後は新キーが優先される。
	await post(12345, "q", "after-rename");
	const merged = await (await tf(`${base}?id=12345&key=q`)).json();
	check("fallback: 追記は旧レコードを引き継いで新キーへ", () => {
		assert.equal(merged.length, 2);
		assert.equal(merged[0].value, "before-rename");
		assert.equal(merged[1].value, "after-rename");
	});
	const db2 = new DatabaseSync(`${HOME_DIR}/.pi/kanban/boards.sqlite`);
	const stored = db2.prepare("SELECT v FROM meta WHERE k = 'ehr:12345'").get();
	db2.close();
	check("fallback: 書き込み先は ehr:<id>", () => assert.ok(stored && String(stored.v).includes("after-rename")));
}

for (const f of failures) console.log(`FAIL ${f}`);
console.log(`passed=${passed} failed=${failures.length}`);
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
