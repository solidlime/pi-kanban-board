// #58 `kanban` ツールの resume の回帰テスト。フレームワーク無しで `node tests/kanban-resume.test.mjs`.
// 対象: halted 中の自動発火が止まること（既存挙動の固定）と、resume が
// 「予算・halted・両スコープの doingLoop・JSONL」を実際に戻すこと。
// HOME と KANBAN_PORT を差し替えるので、本番の ~/.pi/kanban と 8789 には触れない。
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { authFetch } from "./helpers/token.mjs";

// #83b: HTTP routes need the server token now; tf = fetch + the kb_auth cookie.
const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-resume-home";
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

// dist/jiti.cjs は壊れているので lib/jiti.cjs を使う（既存テストと同じ経路）。
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

const MODES = `${HOME_DIR}/.pi/kanban/modes.json`;
const board = (sid) => `${HOME_DIR}/.pi/kanban/sessions/${sid}.json`;
const writeBoardFile = (sid) =>
	writeFileSync(board(sid), JSON.stringify({ cards: [{ id: 1, text: "t", col: "doing" }], nextId: 2 }));
// doingLoop は ON のまま。halted 中の実測状態（modes.json だけ見ると動きそう）を再現する。
const writeModes = (...sids) =>
	writeFileSync(
		MODES,
		JSON.stringify({
			SESSION: Object.fromEntries(sids.map((s) => [s, { doingLoop: true, autoPick: false }])),
			GLOBAL: {},
		}),
	);
const readModes = () => JSON.parse(readFileSync(MODES, "utf8"));

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

const haltingEntry = (at) => ({
	type: "custom",
	customType: "kanban-loop",
	data: { count: 10, halted: "limit", scope: null, stuckId: null, stuckCount: 0, lastActivityAt: at },
});

// KANBAN_DEBUG の poll verdict 行を集める（なぜ発火/停止したかの観測用）。
const traces = [];
const origWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk) => {
	const s = typeof chunk === "string" ? chunk : chunk.toString();
	if (s.startsWith("kanban: poll ")) traces.push(s);
	return true;
};
const verdictOf = (sid) => {
	for (const line of traces) {
		if (!line.includes(`sid=${sid} `)) continue;
		const m = /=> (\S+)/.exec(line);
		if (m !== null) return m[1];
	}
	return null;
};

// --- 1. 純関数: halted:limit は doingLoop が ON でも発火しない ----------------
// 「modes.json のトグルでは再開しない」の根拠をここで固定する。
const base = {
	isIdle: true,
	doingLoop: true,
	card: { id: 1, col: "doing" },
	halted: "limit",
	lastTickAt: 0,
	lastActivityAt: 0,
	now: 5 * 60_000,
};
check("halted:limit + doingLoop:true は fire:false", () =>
	assert.deepEqual(mod.autoTickVerdict(base), { fire: false, reason: "halted:limit", quiet: true }));
check("resume 相当（halted:null）にすると同じ入力で fire:true", () =>
	assert.equal(mod.autoTickVerdict({ ...base, halted: null }).fire, true));

// --- 2. 実際のセッション: halted で止まり、resume で再開する ------------------
process.env.KANBAN_DEBUG = "1";
const SID = "sid-resume";
writeBoardFile(SID);
writeModes(SID);

const { pi, handlers, tools, appended, sent } = mkPi();
const t = mod.default(pi).__test;
const kanban = tools.get("kanban");
check("kanban ツールに resume アクションがある", () =>
	assert.ok(kanban.parameters.properties.action.anyOf.some((a) => a.const === "resume")));

const ctx = mkCtx(SID, [haltingEntry(Date.now())]);
handlers.get("session_start")({ type: "session_start" }, ctx);

// 前提: セッション entry の halted:"limit" が復元され、発火しない。
traces.length = 0;
t.poll();
check("halted 復元直後の poll は skip:halted:limit", () =>
	assert.equal(verdictOf(SID), "skip:halted:limit", `verdict=${verdictOf(SID)}`));
check("halted 中は 1 件も送らない", () => assert.equal(sent.length, 0, `sent=${sent.length}`));

// --- 3. GUI 経路: dashboard に halted が載っている（理由を出すための前提） ----
const dashboardHalted = async () => {
	const j = await (await tf(`${BASE}/api/dashboard`)).json();
	const row = j.sessions.find((s) => s.id === SID);
	return row === undefined ? "NO-SUCH-SESSION" : row.halted;
};
{
	const h = await dashboardHalted();
	check("/api/dashboard の halted は limit と理由を運ぶ", () => assert.equal(h?.halted, "limit", JSON.stringify(h)));
}

// --- 4. resume ---------------------------------------------------------------
const before = appended.length;
const r = await kanban.execute("c-resume", { action: "resume" }, undefined, undefined, ctx);
check("resume はエラーにならない", () => assert.ok(!r.isError, r.content[0].text));
check("resume の戻り値に旧 halted と旧 count が入る", () => {
	const text = r.content[0].text;
	assert.match(text, /halted:limit/, text);
	assert.match(text, /10 → 0/, text);
});
check("resume は loop を JSONL に書き戻す（count:0 / halted:null）", () => {
	const last = appended.slice(before).filter((e) => e.type === "kanban-loop").at(-1);
	assert.ok(last, "kanban-loop entry が追記される");
	assert.equal(last.data.count, 0);
	assert.equal(last.data.halted, null);
});
check("resume は両スコープの doingLoop を ON に戻す", () => {
	const f = readModes();
	assert.equal(f.SESSION[SID].doingLoop, true);
	assert.equal(f.GLOBAL[SID].doingLoop, true);
});

// lastTickAt=0 なので interval を待たず、次の poll で発火する。
traces.length = 0;
t.poll();
check("resume 後の poll は fire", () => assert.equal(verdictOf(SID), "fire", `verdict=${verdictOf(SID)}`));
check("resume 後は 1 件送る", () => assert.equal(sent.length, 1, `sent=${sent.length}`));

// GUI 側の halted 表示も消える（paintLoop が stopped の記録を落とす）。
{
	const h = await dashboardHalted();
	check("resume 後の dashboard halted は null", () => assert.equal(h, null, JSON.stringify(h)));
}

// --- 5. GUI: halted の理由と復帰手段が出ている（両テンプレート） ------------------
const DASH = await (await tf(`${BASE}/`)).text();
// #84: 右パネルのテンプレートは廃止。ダッシュボード 1 枚だけを固定する。
check("DASHBOARD_HTML は両方の停止理由を持つ", () => {
	assert.ok(DASH.includes("ループ上限（"), "limit の文言が無い");
	assert.ok(DASH.includes("回スタックして停止"), "stuck の文言が無い");
});
check("DASHBOARD_HTML は復帰手段（resume / loop on）を案内する", () => {
	assert.ok(DASH.includes("resume"), "resume の案内が無い");
	assert.ok(DASH.includes("/kanban loop on"), "loop on の案内が無い");
	// GUI のトグルでは直らないことを明記しているか（placebo の防止）
	assert.ok(/ON にしても再開しない|スイッチを ON にしても再開しない/.test(DASH), "トグル無効の注記が無い");
});
check("DASHBOARD_HTML の <script> はすべて構文として通る", () => {
	const scripts = [...DASH.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
	assert.ok(scripts.length > 0, "script が無い");
	for (const src of scripts) new Function(src);
});
check("DASHBOARD_HTML は session 行の halted を描画に使う", () =>
	assert.ok(/haltText\(s\.halted[,)]/.test(DASH), "s.halted を haltText に渡していない"));

handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" });
delete process.env.KANBAN_DEBUG;

process.stderr.write = origWrite;

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
