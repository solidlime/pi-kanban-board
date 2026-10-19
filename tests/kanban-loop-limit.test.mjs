// #67 ループ上限（maxLoops）の回帰テスト。フレームワーク無しで
// `node tests/kanban-loop-limit.test.mjs`.
// 対象: modes.json への保存/既定値/無制限（0）/範囲外の拒否/HTTP 書き込み、
// halted:limit の停止と再開（count のリセット）、両テンプレートの UI。
// HOME と KANBAN_PORT を差し替えるので、本番の ~/.pi/kanban と 8789 には触れない。
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";

const HOME_DIR = "/tmp/kb-loop-limit-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
process.env.HOME = HOME_DIR;
const PORT = await new Promise((resolve) => {
	const s = createServer();
	s.listen(0, "127.0.0.1", () => {
		const { port } = s.address();
		s.close(() => resolve(port));
	});
});
process.env.KANBAN_PORT = String(PORT);
const BASE = `http://127.0.0.1:${PORT}`;

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
// await が要る検証用（check は同期なので、外で取ってから渡す）。
async function get(path) {
	const r = await fetch(`${BASE}${path}`);
	return { status: r.status, body: await r.json() };
}
const rowOf = async (sid) => {
	const { body } = await get("/api/dashboard");
	return body.sessions.find((s) => s.id === sid);
};

const MODES = `${HOME_DIR}/.pi/kanban/modes.json`;
const readModesRaw = () => JSON.parse(readFileSync(MODES, "utf8"));
const writeModesRaw = (obj) => writeFileSync(MODES, JSON.stringify(obj));
const boardPath = (sid) => `${HOME_DIR}/.pi/kanban/sessions/${sid}.json`;
const writeBoardFile = (sid) =>
	writeFileSync(boardPath(sid), JSON.stringify({ cards: [{ id: 1, text: "t", col: "doing" }], nextId: 2 }));

function mkPi() {
	const handlers = new Map();
	const tools = new Map();
	const appended = [];
	const sent = [];
	const pi = {
		registerCommand() {},
		registerTool(spec) {
			tools.set(spec.name, spec);
		},
		appendEntry(type, data) {
			appended.push({ type, data });
		},
		on(ev, fn) {
			handlers.set(ev, fn);
		},
		sendUserMessage(c) {
			sent.push(c);
		},
	};
	return { pi, handlers, tools, appended, sent };
}

function mkCtx(sid, entries = []) {
	return {
		hasUI: false,
		isIdle: () => true,
		ui: { notify() {}, setWidget() {} },
		sessionManager: {
			getSessionId: () => sid,
			getSessionName: () => undefined,
			getEntries: () => entries,
		},
	};
}

const loopEntry = (at, count, halted = null) => ({
	type: "custom",
	customType: "kanban-loop",
	data: { count, halted, scope: null, stuckId: null, stuckCount: 0, lastActivityAt: at },
});

// --- 1. 純関数: 既定値と読み方 ------------------------------------------------
// 既存 modes.json（maxLoops フィールド無し）は今までのハードコードと同じ 10 で動く。
check("maxLoopsOf: maxLoops 無しは既定 10", () => assert.equal(mod.maxLoopsOf({ doingLoop: true }), 10));
check("maxLoopsOf: undefined でも既定 10", () => assert.equal(mod.maxLoopsOf(undefined), 10));
check("maxLoopsOf: 保存値をそのまま読む", () => assert.equal(mod.maxLoopsOf({ maxLoops: 25 }), 25));
check("maxLoopsOf: 0 は無制限（0 のまま）", () => assert.equal(mod.maxLoopsOf({ maxLoops: 0 }), 0));
check("maxLoopsOf: 負値も無制限", () => assert.equal(mod.maxLoopsOf({ maxLoops: -3 }), 0));
check("maxLoopsOf: 上限超過は既定 10 に落とす", () => assert.equal(mod.maxLoopsOf({ maxLoops: 5000 }), 10));
check("maxLoopsOf: 小数は既定 10 に落とす", () => assert.equal(mod.maxLoopsOf({ maxLoops: 2.5 }), 10));
check("maxLoopsOf: 文字列は既定 10 に落とす", () => assert.equal(mod.maxLoopsOf({ maxLoops: "7" }), 10));

// --- 2. 検証: 範囲外は拒否 ----------------------------------------------------
check("isValidMaxLoops: 0..1000 の整数は通る", () => {
	for (const n of [0, 1, 10, 1000]) assert.equal(mod.isValidMaxLoops(n), true, `n=${n}`);
});
check("isValidMaxLoops: 範囲外・非整数・NaN は拒否", () => {
	for (const n of [-1, 1001, 2.5, NaN, Infinity, "5", null]) {
		assert.equal(mod.isValidMaxLoops(n), false, `n=${String(n)}`);
	}
});

// --- 3. 既存 modes.json（maxLoops 無し）でも壊れない --------------------------
const SID = "sid-limit";
writeBoardFile(SID);
writeModesRaw({ SESSION: { [SID]: { doingLoop: true, autoPick: false } }, GLOBAL: {} });

const first = mkPi();
mod.default(first.pi);
const ctx = mkCtx(SID, [loopEntry(Date.now(), 0)]);
first.handlers.get("session_start")({ type: "session_start" }, ctx);

{
	const row = await rowOf(SID);
	check("maxLoops 未設定のセッションは dashboard 上で既定 10 として扱われる（後方互換）", () => {
		assert.ok(row, `${SID} が dashboard に無い`);
		assert.equal(row.modes.session.maxLoops, undefined, JSON.stringify(row.modes.session));
	});
}

// --- 4. HTTP: /api/maxloops で保存し、読み戻せる -----------------------------
{
	const ok = await get(`/api/maxloops?scope=session&sid=${SID}&n=6`);
	check("/api/maxloops は 200 で保存する", () => {
		assert.equal(ok.status, 200, JSON.stringify(ok.body));
		assert.equal(ok.body.modes.session.maxLoops, 6, JSON.stringify(ok.body.modes.session));
	});
	check("保存値が modes.json の SESSION に載る", () => assert.equal(readModesRaw().SESSION[SID].maxLoops, 6));
	check("既存フィールドを壊さない", () => {
		const e = readModesRaw().SESSION[SID];
		assert.equal(e.doingLoop, true, JSON.stringify(e));
	});

	const glob = await get(`/api/maxloops?scope=global&sid=${SID}&n=7`);
	check("GLOBAL スコープにも保存できる", () => {
		assert.equal(glob.status, 200, JSON.stringify(glob.body));
		assert.equal(readModesRaw().GLOBAL[SID].maxLoops, 7);
		assert.equal(glob.body.modes.global.maxLoops, 7);
	});

	const bad = await get(`/api/maxloops?scope=session&sid=${SID}&n=1001`);
	check("範囲外（1001）は 400 で拒否する", () => assert.equal(bad.status, 400, JSON.stringify(bad.body)));
	check("拒否時は保存値を変えない", () => assert.equal(readModesRaw().SESSION[SID].maxLoops, 6));
	{
		const neg = await get(`/api/maxloops?scope=session&sid=${SID}&n=-1`);
		check("負値は 400 で拒否する", () => assert.equal(neg.status, 400, JSON.stringify(neg.body)));
		const frac = await get(`/api/maxloops?scope=session&sid=${SID}&n=1.5`);
		check("小数は 400 で拒否する", () => assert.equal(frac.status, 400, JSON.stringify(frac.body)));
		const none = await get("/api/maxloops?scope=session&n=5");
		check("session スコープで sid 無しは 400", () => assert.equal(none.status, 400, JSON.stringify(none.body)));
		const unl = await get(`/api/maxloops?scope=session&sid=${SID}&n=0`);
		check("無制限（0）は 200 で保存される", () => {
			assert.equal(unl.status, 200, JSON.stringify(unl.body));
			assert.equal(readModesRaw().SESSION[SID].maxLoops, 0);
			assert.equal(unl.body.modes.session.maxLoops, 0);
		});
	}
	// 後続の停止テストのために上限を戻す。
	await get(`/api/maxloops?scope=session&sid=${SID}&n=2`);
}

// --- 5. 上限に達したら halted:limit、無制限なら止まらない --------------------
// 停止判定は settle（agent_before_settle）の中で起きる。count が既に上限の状態で
// 復元し、settle を実際に通して halted が立つことを見る。
const SID_LIMIT = "sid-halt";
writeBoardFile(SID_LIMIT);
{
	const m = readModesRaw();
	m.SESSION[SID_LIMIT] = { doingLoop: true, autoPick: false, maxLoops: 2 };
	writeModesRaw(m);
}
const lim = mkPi();
mod.default(lim.pi);
const ctxLim = mkCtx(SID_LIMIT, [loopEntry(Date.now(), 2, null)]);
lim.handlers.get("session_start")({ type: "session_start" }, ctxLim);

const origWrite = process.stderr.write.bind(process.stderr);
lim.handlers.get("agent_before_settle")({ context: { contextMessages: undefined } }, ctxLim);
{
	const row = await rowOf(SID_LIMIT);
	check("上限（2回）に達したセッションは halted:limit になる", () => {
		assert.ok(row, `${SID_LIMIT} が dashboard に無い`);
		assert.ok(row.halted, "halted が無い");
		assert.equal(row.halted.halted, "limit", JSON.stringify(row.halted));
	});
	check("dashboard の halted 行は現在の上限値（cap）を運ぶ", () => assert.equal(row.halted.cap, 2, JSON.stringify(row.halted)));
	check("上限停止は doingLoop を両スコープで OFF にする", () => {
		const m = readModesRaw();
		assert.equal(m.SESSION[SID_LIMIT].doingLoop, false, JSON.stringify(m.SESSION[SID_LIMIT]));
		assert.equal(m.GLOBAL[SID_LIMIT].doingLoop, false, JSON.stringify(m.GLOBAL[SID_LIMIT]));
	});
}

// 無制限（0）のセッションは、count が大きくても limit 停止しない。
const SID_FREE = "sid-unlimited";
writeBoardFile(SID_FREE);
{
	const m = readModesRaw();
	m.SESSION[SID_FREE] = { doingLoop: true, autoPick: false, maxLoops: 0 };
	writeModesRaw(m);
}
const free = mkPi();
mod.default(free.pi);
const ctxFree = mkCtx(SID_FREE, [loopEntry(Date.now(), 999, null)]);
free.handlers.get("session_start")({ type: "session_start" }, ctxFree);
free.handlers.get("agent_before_settle")({ context: { contextMessages: undefined } }, ctxFree);
{
	const row = await rowOf(SID_FREE);
	check("maxLoops:0 のセッションは count 999 でも halted:limit にならない", () => {
		if (!row) return; // 一覧に無いこと自体、停止していない証拠
		assert.notEqual(row.halted && row.halted.halted, "limit", JSON.stringify(row.halted));
	});
}

// --- 6. 再開: halted:limit -> null、count 0、doingLoop ON --------------------
const SID_RESUME = "sid-resume";
writeBoardFile(SID_RESUME);
{
	const m = readModesRaw();
	m.SESSION[SID_RESUME] = { doingLoop: false, autoPick: false, maxLoops: 1 };
	m.GLOBAL[SID_RESUME] = { doingLoop: false, autoPick: false };
	writeModesRaw(m);
}
const rp = mkPi();
const tRp = mod.default(rp.pi).__test;
const ctxRp = mkCtx(SID_RESUME, [loopEntry(Date.now(), 1, "limit")]);
rp.handlers.get("session_start")({ type: "session_start" }, ctxRp);

{
	const row = await rowOf(SID_RESUME);
	check("復元直後の dashboard 行は halted:limit と cap 1", () => {
		assert.ok(row, `${SID_RESUME} が dashboard に無い`);
		assert.equal(row.halted && row.halted.halted, "limit", JSON.stringify(row.halted));
		assert.equal(row.halted && row.halted.cap, 1, JSON.stringify(row.halted));
	});
}

const rq = await get(`/api/resume?scope=session&sid=${SID_RESUME}`);
check("/api/resume は 202 で受け付ける", () => assert.equal(rq.status, 202, JSON.stringify(rq.body)));
{
	const bad = await get("/api/resume?scope=session");
	check("/api/resume は sid 無しの session スコープを 400 で拒否", () =>
		assert.equal(bad.status, 400, JSON.stringify(bad.body)));
}
check("再開要求が poll の受け渡しに載っている", () => assert.equal(tRp.resumeRequests.get(SID_RESUME), 1));

// poll が要求を消費して実際に再開する（halt はプロセスのメモリなのでここで初めて動く）。
tRp.poll();
check("poll が再開要求を消費する", () => assert.equal(tRp.resumeRequests.has(SID_RESUME), false));
{
	const row = await rowOf(SID_RESUME);
	check("再開後の dashboard 行は halted:null", () => assert.equal(row.halted, null, JSON.stringify(row.halted)));
}
check("再開は両スコープの doingLoop を ON に戻す", () => {
	const m = readModesRaw();
	assert.equal(m.SESSION[SID_RESUME].doingLoop, true);
	assert.equal(m.GLOBAL[SID_RESUME].doingLoop, true);
});
check("再開は JSONL に count:0 / halted:null を書く", () => {
	const last = rp.appended.filter((e) => e.type === "kanban-loop").at(-1);
	assert.ok(last, "kanban-loop entry が追記される");
	assert.equal(last.data.count, 0);
	assert.equal(last.data.halted, null);
});
check("再開は上限値そのものを書き換えない", () => assert.equal(readModesRaw().SESSION[SID_RESUME].maxLoops, 1));

// 既存の kanban ツール resume も従来どおり動く（非破壊の固定）。
const kanbanRp = rp.tools.get("kanban");
const res = await kanbanRp.execute("c1", { action: "resume" }, undefined, undefined, ctxRp);
check("kanban ツールの resume は従来どおり成功する", () => assert.ok(!res.isError, res.content[0].text));
check("kanban ツールの resume は可変の上限を反映した残量を返す", () =>
	assert.match(res.content[0].text, /残り 1\/1/, res.content[0].text));

// --- 7. /kanban maxloops コマンド -------------------------------------------
check("parseKanbanArgs: maxloops は status", () =>
	assert.deepEqual(mod.parseKanbanArgs(["maxloops"]), { kind: "maxLoopsStatus", scope: "session" }));
check("parseKanbanArgs: maxloops global 20", () =>
	assert.deepEqual(mod.parseKanbanArgs(["maxloops", "global", "20"]), { kind: "maxLoops", scope: "global", n: 20 }));
check("parseKanbanArgs: maxloops 0（無制限）", () =>
	assert.deepEqual(mod.parseKanbanArgs(["maxloops", "0"]), { kind: "maxLoops", scope: "session", n: 0 }));
check("parseKanbanArgs: maxloops 範囲外は reject", () =>
	assert.equal(mod.parseKanbanArgs(["maxloops", "1001"]).kind, "reject"));

// --- 8. テンプレート: 上限 UI と再開が両方にある ------------------------------
const DASH = await (await fetch(`${BASE}/`)).text();
check("DASHBOARD_HTML に上限値の入力欄（/api/maxloops 経由）がある", () => {
	assert.ok(/\/api\/maxloops/.test(DASH), "maxloops の保存経路が無い");
	assert.ok(/上限/.test(DASH), "上限のラベルが無い");
	assert.ok(/ml\.type = "number"/.test(DASH), "数値入力が無い");
});
check("DASHBOARD_HTML に「無制限」に切り替える手段がある", () => {
	assert.ok(/無制限/.test(DASH), "無制限の文言が無い");
	assert.ok(/maxloops[\s\S]{0,80}n=0|0 = 無制限|0 で無制限/.test(DASH), "0 = 無制限 の導線が無い");
});
check("DASHBOARD_HTML に「再開」ボタンの生成がある", () => {
	assert.ok(/function resumeBtn/.test(DASH), "resumeBtn が無い");
	assert.ok(/再開/.test(DASH), "「再開」の文言が無い");
	assert.ok(/act\("\/api\/resume"/.test(DASH), "resume への送信が無い");
});
check("DASHBOARD_HTML の停止理由は可変の上限値を出す（リテラル埋め込みではない）", () => {
	assert.ok(!/\$\{MAX_LOOPS\}/.test(DASH), "${MAX_LOOPS} が残っている");
	assert.ok(/haltText\(s\.halted, maxLoopsOf/.test(DASH), "haltText に上限値を渡していない");
});
check("DASHBOARD_HTML の <script> はすべて構文として通る", () => {
	const scripts = [...DASH.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
	assert.ok(scripts.length > 0, "DASHBOARD_HTML: script が無い");
	for (const src of scripts) new Function(src);
});

for (const h of [first, lim, free, rp]) h.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" });
delete process.env.KANBAN_DEBUG;
process.stderr.write = origWrite;

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
