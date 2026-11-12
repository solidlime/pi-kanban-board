// #67 ループ上限（maxLoops）の回帰テスト。フレームワーク無しで
// `node tests/kanban-loop-limit.test.mjs`.
// 対象: modes.json への保存/既定値/無制限（0）/範囲外の拒否/HTTP 書き込み、
// halted:limit の停止と再開（count のリセット）、両テンプレートの UI。
// HOME と KANBAN_PORT を差し替えるので、本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { authFetch } from "./helpers/token.mjs";
import { readBoardAt, seedBoard, useKanban } from "./helpers/board.mjs";

// #83b: HTTP routes need the server token now; tf = fetch + the kb_auth cookie.
const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-loop-limit-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
process.env.HOME = HOME_DIR;
// Windows: os.homedir() prefers USERPROFILE over HOME, so keep them in step or the
// server writes its token to the real profile and this test reads a missing file.
process.env.USERPROFILE = process.env.HOME;
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
	process.env.KANBAN_JITI ?? createRequire(import.meta.url).resolve("jiti"),
);
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url)));
useKanban(mod);

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
	const r = await tf(`${BASE}${path}`);
	return { status: r.status, body: await r.json() };
}
// #17: the dashboard has one project row and one global row. `sid` is only the actor
// whose halt / count maps the rows are rendered from.
const rowOf = async (_sid) => {
	const { body } = await get("/api/dashboard");
	return body.project;
};

const MODES = `${HOME_DIR}/.pi/kanban/modes.json`;
const readModesRaw = () => JSON.parse(readFileSync(MODES, "utf8"));
const writeModesRaw = (obj) => writeFileSync(MODES, JSON.stringify(obj, null, 2));
// #17: session boards are gone. Everything below works on this cwd's PROJECT board;
// the sid stays the ACTOR (movedBy, halt maps). #26: switches live in PROJECT[slug] only,
// global is a read-only view so no global switch is ever written or read.
const PROJ_KEY = mod.projectSlugOf(process.cwd());
const PROJ_FILE = `${HOME_DIR}/.pi/kanban/projects/${PROJ_KEY}.json`;
const boardPath = (_sid) => PROJ_FILE;
const writeBoardFile = (sid) =>
	seedBoard(PROJ_FILE, { cards: [{ id: 1, text: "t", col: "doing", movedBy: sid }], nextId: 2 });

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

// #110: sid をキーにした状態（cwd / halted / count）はセッションの寿命で消える。本番と同じく
// 各 case の末尾で session_shutdown を呼ぶ: 同じ板に複数の owner が生きたままだと、
// 「止まっている owner を最優先で読む」規則が前の case の halt を拾って行を halted にする。
const shutdownOf = (run, c) =>
	run.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, c);

// --- 3. 既存 modes.json（maxLoops 無し）でも壊れない --------------------------
const SID = "sid-limit";
writeBoardFile(SID);
writeModesRaw({
	PROJECT: { [PROJ_KEY]: { doingLoop: true, autoPick: false } },
	GLOBAL: { [SID]: { doingLoop: true, autoPick: false } },
});

const first = mkPi();
mod.default(first.pi);
const ctx = mkCtx(SID, [loopEntry(Date.now(), 0)]);
first.handlers.get("session_start")({ type: "session_start" }, ctx);

{
	const row = await rowOf(SID);
	check("maxLoops 未設定のセッションは dashboard 上で既定 10 として扱われる（後方互換）", () => {
		assert.ok(row, `${SID} が dashboard に無い`);
		assert.equal(row.modes.maxLoops, undefined, JSON.stringify(row.modes));
	});
}

// --- 4. HTTP: /api/maxloops で保存し、読み戻せる -----------------------------
{
	const ok = await get("/api/maxloops?scope=project&n=6");
	check("/api/maxloops は 200 で保存する", () => {
		assert.equal(ok.status, 200, JSON.stringify(ok.body));
		assert.equal(ok.body.modes.project.maxLoops, 6, JSON.stringify(ok.body.modes.project));
	});
	check("保存値が modes.json の PROJECT[slug] に載る", () =>
		assert.equal(readModesRaw().PROJECT[PROJ_KEY].maxLoops, 6));
	check("既存フィールドを壊さない", () => {
		const e = readModesRaw().PROJECT[PROJ_KEY];
		assert.equal(e.doingLoop, true, JSON.stringify(e));
	});

	// #26: global は集約ビューなのでスイッチを持たない（sid を付けても 400、GLOBAL バケツは作らない）。
	const glob = await get(`/api/maxloops?scope=global&sid=${SID}&n=7`);
	check("GLOBAL スコープには保存できない（400）", () => {
		assert.equal(glob.status, 400, JSON.stringify(glob.body));
		assert.equal(glob.body.error, "global は集約ビューでスイッチを持たない（scope=project を使う）");
		assert.equal(readModesRaw().GLOBAL?.[SID]?.maxLoops, undefined);
		assert.equal(readModesRaw().PROJECT[PROJ_KEY].maxLoops, 6);
	});

	const bad = await get("/api/maxloops?scope=project&n=1001");
	check("範囲外（1001）は 400 で拒否する", () => assert.equal(bad.status, 400, JSON.stringify(bad.body)));
	check("拒否時は保存値を変えない", () => assert.equal(readModesRaw().PROJECT[PROJ_KEY].maxLoops, 6));
	{
		const neg = await get("/api/maxloops?scope=project&n=-1");
		check("負値は 400 で拒否する", () => assert.equal(neg.status, 400, JSON.stringify(neg.body)));
		const frac = await get("/api/maxloops?scope=project&n=1.5");
		check("小数は 400 で拒否する", () => assert.equal(frac.status, 400, JSON.stringify(frac.body)));
		// #17: session ボードは無い。scope=session は sid の有無に関係なく 400。
		const none = await get("/api/maxloops?scope=session&n=5");
		check("scope=session は 400（session は廃止）", () => {
			assert.equal(none.status, 400, JSON.stringify(none.body));
			assert.equal(none.body.error, "scope must be global or project", JSON.stringify(none.body));
		});
		const unl = await get("/api/maxloops?scope=project&n=0");
		check("無制限（0）は 200 で保存される", () => {
			assert.equal(unl.status, 200, JSON.stringify(unl.body));
			assert.equal(readModesRaw().PROJECT[PROJ_KEY].maxLoops, 0);
			assert.equal(unl.body.modes.project.maxLoops, 0);
		});
	}
	// 後続の停止テストのために上限を戻す。
	await get("/api/maxloops?scope=project&n=2");
}

// --- 4b. scope=project の sid ゲートは書き込み経路と同じ判定 ---------------------
// 未知の sid は cwd が解決できないので、自分の cwd のボードに黙って着地させない。
{
	const bad = await get("/api/modes?scope=project&sid=sid-nobody&key=doingLoop&value=off");
	check("/api/modes?scope=project&sid=<unknown> は 400（/api/add と同じ判定）", () => {
		assert.equal(bad.status, 400, JSON.stringify(bad.body));
		assert.equal(bad.body.error, "unknown sid", JSON.stringify(bad.body));
	});
	check("拒否時は PROJECT バケツを書き換えない", () => {
		const m = readModesRaw();
		assert.deepEqual(
			m.PROJECT[PROJ_KEY],
			{ doingLoop: true, autoPick: false, maxLoops: 2 },
			JSON.stringify(m.PROJECT),
		);
		assert.equal(m.PROJECT["sid-nobody"], undefined, JSON.stringify(m.PROJECT));
	});
}

shutdownOf(first, ctx);

// --- 5. 上限に達したら halted:limit、無制限なら止まらない --------------------
// 停止判定は settle（agent_before_settle）の中で起きる。count が既に上限の状態で
// 復元し、settle を実際に通して halted が立つことを見る。
const SID_LIMIT = "sid-halt";
writeBoardFile(SID_LIMIT);
{
	const m = readModesRaw();
	// #26: the cap and the switch live in PROJECT[slug]; the global bucket is no longer read.
	m.PROJECT = { [PROJ_KEY]: { doingLoop: true, autoPick: false, maxLoops: 2 } };
	m.GLOBAL = { [SID_LIMIT]: { doingLoop: true, autoPick: false } };
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
	check("上限（2回）に達した project ボードは halted になる", () => {
		assert.ok(row, `${SID_LIMIT} が dashboard に無い`);
		// 上限は PROJECT[slug] から読む。既定 10 なら 2 回では止まらない。
		assert.equal(row.halted, true, JSON.stringify(row));
	});
	check("project 行は使った回数（2）を出す", () => assert.equal(row.loops, 2, JSON.stringify(row)));
	check("上限停止は project の doingLoop を OFF にする（#26: スイッチは project だけ）", () => {
		const m = readModesRaw();
		assert.equal(m.PROJECT[PROJ_KEY].doingLoop, false, JSON.stringify(m.PROJECT[PROJ_KEY]));
		assert.equal(m.GLOBAL?.[SID_LIMIT]?.doingLoop, true, "global バケツは触られない");
	});
}

shutdownOf(lim, ctxLim);

// 無制限（0）のセッションは、count が大きくても limit 停止しない。
const SID_FREE = "sid-unlimited";
writeBoardFile(SID_FREE);
{
	const m = readModesRaw();
	m.PROJECT = { [PROJ_KEY]: { doingLoop: true, autoPick: false, maxLoops: 0 } };
	writeModesRaw(m);
}
const free = mkPi();
mod.default(free.pi);
const ctxFree = mkCtx(SID_FREE, [loopEntry(Date.now(), 999, null)]);
free.handlers.get("session_start")({ type: "session_start" }, ctxFree);
free.handlers.get("agent_before_settle")({ context: { contextMessages: undefined } }, ctxFree);
{
	const row = await rowOf(SID_FREE);
	check("maxLoops:0 の project ボードは count 999 でも停止しない", () => {
		assert.equal(row.halted, false, JSON.stringify(row));
		assert.equal(row.loops, 1000, JSON.stringify(row));
	});
}

shutdownOf(free, ctxFree);

// --- 6. 再開: halted:limit -> null、count 0、doingLoop ON --------------------
const SID_RESUME = "sid-resume";
writeBoardFile(SID_RESUME);
{
	const m = readModesRaw();
	// #26: 上限もスイッチも project ボードのもの。global バケツは読まれない。
	m.GLOBAL = {};
	m.PROJECT = { [PROJ_KEY]: { doingLoop: false, autoPick: false, maxLoops: 1 } };
	writeModesRaw(m);
}
const rp = mkPi();
const tRp = mod.default(rp.pi).__test;
const ctxRp = mkCtx(SID_RESUME, [loopEntry(Date.now(), 1, "limit")]);
rp.handlers.get("session_start")({ type: "session_start" }, ctxRp);

{
	const row = await rowOf(SID_RESUME);
	check("復元直後の dashboard 行は halted（limit）", () => {
		assert.ok(row, `${SID_RESUME} が dashboard に無い`);
		assert.equal(row.halted, true, JSON.stringify(row));
	});
}

{
	// #26: global はスイッチを持たないので、再開要求のキューには何も積まれない（pid フォールバックの廃止）。
	const g = await get(`/api/resume?scope=global&sid=${SID_RESUME}`);
	check("/api/resume?scope=global&sid= は 400（集約ビューにスイッチは無い）", () => {
		assert.equal(g.status, 400, JSON.stringify(g.body));
		assert.equal(g.body.error, "global は集約ビューでスイッチを持たない（scope=project を使う）");
	});
	check("scope=global の要求はキューに積まれない", () =>
		assert.equal(tRp.resumeRequests.size, 0, `keys=${[...tRp.resumeRequests.keys()]}`));
}
// #17 回帰: ダッシュボードの project 行の「再開」は scope=project だけを送る（act() は
// ctx.sid がある時しか sid を付けない）。settingsSidOf はそれを slug に解決するので、
// sid に付け替えないと poll が永久に読めず、202 を返すのに何も起きない。
const rq = await get(`/api/resume?scope=project`);
check("/api/resume?scope=project (sid 無し) は 202 で受け付ける", () =>
	assert.equal(rq.status, 202, JSON.stringify(rq.body)));
{
	const bad = await get("/api/resume?scope=session");
	check("/api/resume は sid 無しの session スコープを 400 で拒否", () =>
		assert.equal(bad.status, 400, JSON.stringify(bad.body)));
}
check("再開要求が poll の受け渡しに載っている（ボードキーではなく sid）", () => {
	assert.equal(tRp.resumeRequests.get(SID_RESUME), 1, `keys=${[...tRp.resumeRequests.keys()]}`);
	assert.equal(tRp.resumeRequests.has(PROJ_KEY), false, "slug をキーに積んでいる: poll が読めない");
});

// poll が要求を消費して実際に再開する（halt はプロセスのメモリなのでここで初めて動く）。
tRp.poll();
check("poll が再開要求を消費する", () => assert.equal(tRp.resumeRequests.has(SID_RESUME), false));
{
	const row = await rowOf(SID_RESUME);
	check("再開後の dashboard 行は halted:false", () => assert.equal(row.halted, false, JSON.stringify(row)));
}
// 上限 halt は project の doingLoop を落とすので、再開もそれを戻さないと
// project（唯一の駆動ボード）のループが二度と回らない。
check("再開は project の doingLoop を ON に戻す（#26: スイッチは project だけ）", () => {
	const m = readModesRaw();
	assert.equal(m.SESSION, undefined, `SESSION バケツが残っている: ${JSON.stringify(m.SESSION)}`);
	assert.ok(m.PROJECT && m.PROJECT[PROJ_KEY], `PROJECT[${PROJ_KEY}] が無い: ${JSON.stringify(m.PROJECT)}`);
	assert.equal(m.PROJECT[PROJ_KEY].doingLoop, true, JSON.stringify(m.PROJECT[PROJ_KEY]));
});
check("再開は JSONL に count:0 / halted:null を書く", () => {
	const last = rp.appended.filter((e) => e.type === "kanban-loop").at(-1);
	assert.ok(last, "kanban-loop entry が追記される");
	assert.equal(last.data.count, 0);
	assert.equal(last.data.halted, null);
});
check("再開は上限値そのものを書き換えない", () => assert.equal(readModesRaw().PROJECT[PROJ_KEY].maxLoops, 1));

// 既存の kanban ツール resume も従来どおり動く（非破壊の固定）。
const kanbanRp = rp.tools.get("kanban");
const res = await kanbanRp.execute("c1", { action: "resume" }, undefined, undefined, ctxRp);
check("kanban ツールの resume は従来どおり成功する", () => assert.ok(!res.isError, res.content[0].text));
check("kanban ツールの resume は可変の上限を反映した残量を返す", () =>
	assert.match(res.content[0].text, /残り 1\/1/, res.content[0].text));
check("kanban ツールの resume は ON にしたスコープを報告する", () =>
	assert.match(res.content[0].text, /doingLoop ON \(project\)/, res.content[0].text));

shutdownOf(rp, ctxRp);

// --- 6b. project scope の loop entry は再起動をまたいで残る -------------------
// 復元で scope が落ちると settle は session ボードを見て、project の halted:stuck を
// 自分で解除してしまう（暴走防止の停止が勝手に解ける）。
const SID_PROJ = "sid-project-loop";
// paintLoop must read the cap from PROJECT[slug], never from a bucket keyed by the sid.
{
	const m = readModesRaw();
	m.PROJECT = { [PROJ_KEY]: { doingLoop: true, autoPick: false, maxLoops: 4 } };
	writeModesRaw(m);
}
seedBoard(PROJ_FILE, {
	cards: [{ id: 5, text: "halted card", col: "doing", movedBy: SID_PROJ }],
	nextId: 6,
});
const pl = mkPi();
mod.default(pl.pi);
const ctxPl = mkCtx(SID_PROJ, [
	{
		type: "custom",
		customType: "kanban-loop",
		data: { count: 3, halted: "stuck", scope: "project", stuckId: 5, stuckCount: 1, lastActivityAt: Date.now() },
	},
]);
pl.handlers.get("session_start")({ type: "session_start" }, ctxPl);
{
	const row = await rowOf(SID_PROJ);
	check("project scope の loop entry は復元され halted:stuck を保つ", () => {
		assert.ok(row, `${SID_PROJ} が dashboard に無い`);
		assert.equal(row.halted, true, JSON.stringify(row));
	});
}
pl.handlers.get("agent_before_settle")({ context: { contextMessages: undefined } }, ctxPl);
{
	const row = await rowOf(SID_PROJ);
	check("project で止まった loop は次の settle で勝手に解除されない", () => {
		assert.ok(row, `${SID_PROJ} が dashboard に無い`);
		assert.equal(row.halted, true, JSON.stringify(row));
	});
}

shutdownOf(pl, ctxPl);

// --- 6c. project で止まった loop は footer と件数に出る -----------------------
// footer は 2 行しかなく、project 用の行は無い。paintLoop が project を落としていたので
// 既定ボードが理由も件数も出さずに黙って止まっていた。
const SID_FOOT = "sid-project-footer";
const GLOBAL_FILE = `${HOME_DIR}/.pi/kanban/global.json`;
const projectFile = PROJ_FILE;
seedBoard(GLOBAL_FILE, { cards: [], nextId: 1 });
seedBoard(projectFile, { cards: [{ id: 1, text: "proj doing", col: "doing", movedBy: SID_FOOT }], nextId: 2 });
{
	const m = readModesRaw();
	// project の上限は slug のバケツから読む（既定 10 なら 2 回で止まらない）。
	m.PROJECT = { [PROJ_KEY]: { doingLoop: true, autoPick: false, maxLoops: 2 } };
	writeModesRaw(m);
}
const foot = mkPi();
mod.default(foot.pi);
const widgets = [];
const ctxFoot = {
	...mkCtx(SID_FOOT, [loopEntry(Date.now(), 2)]),
	hasUI: true,
	ui: {
		notify() {},
		setWidget(_key, lines) {
			widgets.push(lines);
		},
	},
};
foot.handlers.get("session_start")({ type: "session_start" }, ctxFoot);
await foot.handlers.get("agent_before_settle")({ context: { contextMessages: undefined } }, ctxFoot);
{
	const lines = widgets.at(-1) ?? [];
	check("project で上限停止したら footer の PROJECT 行に HALTED:limit が出る", () => {
		assert.equal(lines.length, 1, JSON.stringify(lines));
		assert.match(lines[0], /HALTED:limit/, JSON.stringify(lines));
		assert.ok(/^PROJECT:/.test(lines[0]), JSON.stringify(lines));
	});
}
{
	const row = await rowOf(SID_FOOT);
	check("project で使った回数は loopCountOf（dashboard の loops）に載る", () => {
		assert.ok(row, `${SID_FOOT} が dashboard に無い`);
		assert.equal(row.loops, 2, JSON.stringify(row));
	});
}

shutdownOf(foot, ctxFoot);

// 同じことが停止していない場合（件数だけ）にも成り立つこと。
const SID_FOOT2 = "sid-project-count";
seedBoard(projectFile, { cards: [{ id: 1, text: "proj doing", col: "doing", movedBy: SID_FOOT2 }], nextId: 2 });
{
	const m = readModesRaw();
	m.PROJECT = { [PROJ_KEY]: { doingLoop: true, autoPick: false, maxLoops: 9 } };
	writeModesRaw(m);
}
const foot2 = mkPi();
mod.default(foot2.pi);
const widgets2 = [];
const ctxFoot2 = {
	...mkCtx(SID_FOOT2, [loopEntry(Date.now(), 3)]),
	hasUI: true,
	ui: {
		notify() {},
		setWidget(_key, lines) {
			widgets2.push(lines);
		},
	},
};
foot2.handlers.get("session_start")({ type: "session_start" }, ctxFoot2);
{
	const res = await foot2.handlers.get("agent_before_settle")({ context: { contextMessages: undefined } }, ctxFoot2);
	check("project が駆動している settle は continuation を返す", () => assert.equal(res && res.continue, true, JSON.stringify(res)));
	const lines = widgets2.at(-1) ?? [];
	check("project の件数は footer の PROJECT 行に「残り/上限」で出る", () => {
		assert.equal(lines.length, 1, JSON.stringify(lines));
		// 上限 9、使った 4 -> 残り 5/9（session 自身は ON だが件数は project のもの）。
		assert.match(lines[0], / 5\/9/, JSON.stringify(lines));
	});
	const row = await rowOf(SID_FOOT2);
	check("loopCountOf は project の回数（4）を返す", () => {
		assert.ok(row, `${SID_FOOT2} が dashboard に無い`);
		assert.equal(row.loops, 4, JSON.stringify(row));
	});
}

shutdownOf(foot2, ctxFoot2);

// --- 6d. 移行待ちの間は write 経路（tools/settle/poll）が待つ ------------------
// 折り込みは session/global 行を消して終わるので、その窓で受けた書き込みは最後の
// writeBoard に上書きされる。HTTP の handle ゲートだけではここが素通りしていた。
// gate = 移行が終わるまで待つ / settle = continuation を落とす（sync のまま）/ poll =
// wake は送るが firedFor を書かない（tick を落とすと interval ごと失うから）。
const SID_GATE = "sid-migration-gate";
const gateFile = PROJ_FILE;
// nextFireAt を持たせないと markFired が 1 行目で return し、`if (!folding)` を外しても
// firedFor は書かれない（反例不能なテストになる）。過去の due を置いて実際に火を付けさせる。
const dueIso = new Date(Date.now() - 60_000).toISOString();
seedBoard(gateFile, { cards: [{ id: 1, text: "g", col: "doing", movedBy: SID_GATE, nextFireAt: dueIso }], nextId: 2 });
{
	const m = readModesRaw();
	m.PROJECT = { [PROJ_KEY]: { doingLoop: true, autoPick: false } };
	writeModesRaw(m);
}
const gate = mkPi();
const tGate = mod.default(gate.pi).__test;
const ctxGate = mkCtx(SID_GATE, [loopEntry(Date.now(), 0)]);
gate.handlers.get("session_start")({ type: "session_start" }, ctxGate);

// 対照: gate が開いている同じ poll が firedFor を書くこと。これが無いと、下の
// 「書かれない」は markFired の早期 return でも成立してしまい、`if (!folding)` を
// 消しても緑のままになる（移行窓のガードを検査しないテストになる）。
tGate.poll();
// #51-①: firedFor は wake の promise の成功側で刻む（reject で刻まないため）。
// 同期の右直後にはまだ無いので、マイクロタスクを 1 回回してから見る。
await new Promise((r) => setTimeout(r, 20));
check("対照: 移行待ちでなければ poll は firedFor を書く", () => {
	const b = readBoardAt(gateFile);
	assert.equal(b.cards[0].firedFor, dueIso, JSON.stringify(b.cards));
});
check("対照: wake も 1 回出る", () => assert.equal(gate.sent.length, 1, JSON.stringify(gate.sent)));
// 対照で付いた firedFor と lastTickAt を戻す（resetLoop が lastTickAt = 0 にし、
// seedBoard が盤面を due の初期状態に戻す）。これで次の poll はまた判定に進む。
tGate.resumeNow(SID_GATE);
seedBoard(gateFile, { cards: [{ id: 1, text: "g", col: "doing", movedBy: SID_GATE, nextFireAt: dueIso }], nextId: 2 });

let releaseGate = () => {};
tGate.setMigrationPending(new Promise((resolve) => { releaseGate = resolve; }));
let toolDone = false;
const toolRun = gate.tools
	.get("kanban")
	.execute("t-gate", { action: "list" }, undefined, undefined, ctxGate)
	.then((r) => {
		toolDone = true;
		return r;
	});
await new Promise((r) => setTimeout(r, 80));
check("移行待ちの間は kanban ツールの execute が進まない", () => assert.equal(toolDone, false));
check("移行待ちの間は settle が continuation を返さない", () => {
	assert.equal(gate.handlers.get("agent_before_settle")({ context: { contextMessages: undefined } }, ctxGate), undefined);
});
check("移行待ちの間は poll が firedFor を書かない（wake は送る）", () => {
	const sentBefore = gate.sent.length;
	tGate.poll();
	assert.equal(gate.sent.length, sentBefore + 1, JSON.stringify(gate.sent));
	const b = readBoardAt(gateFile);
	assert.equal(b.cards[0].firedFor, undefined, JSON.stringify(b.cards));
});
// #51-①: 上の wake の成功側はマイクロタスクで走る。先に回収しないと、この後の
// seedBoard に firedFor を書き戻して次の poll を沈黙させる。
await new Promise((r) => setTimeout(r, 20));
assert.equal(readBoardAt(gateFile).cards[0].firedFor, undefined, "移行中は wake が成功しても刻まない");
tGate.setMigrationPending(null);
releaseGate();
{
	const res = await toolRun;
	check("移行が終われば execute は通る", () => {
		assert.equal(toolDone, true);
		assert.ok(res && Array.isArray(res.content), JSON.stringify(res));
	});
	const res2 = gate.handlers.get("agent_before_settle")({ context: { contextMessages: undefined } }, ctxGate);
	check("移行が終われば settle は通る（continuation を返す）", () => {
		assert.equal(res2 && res2.continue, true, JSON.stringify(res2));
	});
}

// --- 6e. /api/maxloops は project も受ける（キーは slug、sid ではない）---------
{
	const ok = await get("/api/maxloops?scope=project&n=3");
	check("/api/maxloops?scope=project は 200 で PROJECT[slug].maxLoops を書く", () => {
		assert.equal(ok.status, 200, JSON.stringify(ok.body));
		assert.equal(ok.body.modes.project.maxLoops, 3, JSON.stringify(ok.body));
		assert.equal(readModesRaw().PROJECT[PROJ_KEY].maxLoops, 3);
	});
	const bad = await get("/api/maxloops?scope=project&sid=sid-nobody&n=3");
	check("/api/maxloops?scope=project&sid=<session id> は 400（unknown sid）", () => {
		assert.equal(bad.status, 400, JSON.stringify(bad.body));
		assert.equal(bad.body.error, "unknown sid", JSON.stringify(bad.body));
	});
	check("拒否時は PROJECT をセッション id で汚さない", () => {
		const m = readModesRaw();
		assert.equal(m.PROJECT["sid-nobody"], undefined, JSON.stringify(m.PROJECT));
		assert.equal(m.PROJECT[PROJ_KEY].maxLoops, 3, JSON.stringify(m.PROJECT));
	});
}

// --- 7. /kanban maxloops コマンド -------------------------------------------
check("parseKanbanArgs: maxloops は status", () =>
	assert.deepEqual(mod.parseKanbanArgs(["maxloops"]), { kind: "maxLoopsStatus", scope: "project" }));
check("parseKanbanArgs: maxloops global 20", () =>
	assert.deepEqual(mod.parseKanbanArgs(["maxloops", "global", "20"]), { kind: "maxLoops", scope: "global", n: 20 }));
check("parseKanbanArgs: maxloops 0（無制限）", () =>
	assert.deepEqual(mod.parseKanbanArgs(["maxloops", "0"]), { kind: "maxLoops", scope: "project", n: 0 }));
check("parseKanbanArgs: maxloops 範囲外は reject", () =>
	assert.equal(mod.parseKanbanArgs(["maxloops", "1001"]).kind, "reject"));

// --- 8. テンプレート: 上限 UI と再開が両方にある ------------------------------
const DASH = await (await tf(`${BASE}/`)).text();
check("DASHBOARD_HTML に上限値の入力欄（/api/maxloops 経由）がある", () => {
	assert.ok(/\/api\/maxloops/.test(DASH), "maxloops の保存経路が無い");
	assert.ok(/上限/.test(DASH), "上限のラベルが無い");
	assert.ok(/id="ml" type="number"/.test(DASH), "数値入力が無い");
});
check("DASHBOARD_HTML に「無制限」に切り替える手段がある", () => {
	// v2.5: 残り回数は ∞ 表示。上限そのものは /api/maxloops で書く。
	assert.ok(/∞/.test(DASH), "無制限の表示（∞）が無い");
	assert.ok(/\/api\/maxloops/.test(DASH), "maxloops の保存経路が無い");
});
check("DASHBOARD_HTML に halt/resume のスイッチがある（#43/#48 で resumeBtn は pause スイッチに統合）", () => {
	assert.ok(/data-sw="pause"/.test(DASH), "pause スイッチが無い");
	assert.ok(/\/api\/resume/.test(DASH), "resume への送信が無い");
	assert.ok(/\/api\/halt/.test(DASH), "halt への送信が無い");
});
check("DASHBOARD_HTML の停止表示は halted の bool で駆動される（#17: 理由の文字列は消えた）", () => {
	assert.ok(!/\$\{MAX_LOOPS\}/.test(DASH), "${MAX_LOOPS} が残っている");
	assert.ok(/function halted\(\)/.test(DASH), "halted() が無い");
	assert.ok(/p\.halted/.test(DASH), "halted() が halted の bool を見ていない");
	assert.ok(/setAttribute\("aria-pressed", String\(halted\(\)\)\)/.test(DASH), "スイッチが実値で駆動されない");
});
check("DASHBOARD_HTML の <script> はすべて構文として通る", () => {
	const scripts = [...DASH.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
	assert.ok(scripts.length > 0, "DASHBOARD_HTML: script が無い");
	for (const src of scripts) new Function(src);
});

// gate は最後の poll / settle / 移行待ちまで生かす（他の case は上で死んでいる）。
shutdownOf(gate, ctxGate);
delete process.env.KANBAN_DEBUG;
process.stderr.write = origWrite;

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
