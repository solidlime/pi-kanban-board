// #38 (ダッシュボードの操作系と見た目) のうち、実装はあるがテストで固まっていなかった
// 項目を固定する自己検証 (#011)。実装は変えない。
//   - #38-9  DOING 強調をダッシュボードで持つ
//   - #38-12 HALTED の理由を footer に出す (limit / stuck #n / 無し)
// #84: 右パネルのテンプレートは廃止。#38-7（列の畳み）/ #38-8（検索）の vm 検証は
// ダッシュボード側の kanban-dashboard-ops38.test.mjs と
// kanban-dashboard-collapse-search.test.mjs が実 DOM 相当で持っているので、ここでは落とした。
// フレームワーク無しで `node tests/kanban-ops38-frozen.test.mjs`。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";

const HOME_DIR = "/tmp/kb-ops38-frozen-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/media`, { recursive: true });
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

const { createJiti } = createRequire(import.meta.url)(
	"/root/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.cjs",
);
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(new URL("../extensions/kanban.ts", import.meta.url).pathname);

const failures = [];
let passed = 0;
const check = (name, fn) => {
	try {
		const r = fn();
		if (r && typeof r.then === "function") return r.then(
			() => {
				passed += 1;
			},
			(err) => {
				failures.push(`${name}: ${err.message}`);
			},
		);
		passed += 1;
	} catch (err) {
		failures.push(`${name}: ${err.message}`);
	}
	return undefined;
};
const flush = () => new Promise((r) => setImmediate(r));

// --- サーバ起動 (このテスト専用ポート) ----------------------------------------
const tools = [];
const handlers = new Map();
const pi = {
	registerCommand() {},
	registerTool(spec) {
		tools.push(spec);
	},
	appendEntry() {},
	on(ev, fn) {
		handlers.set(ev, fn);
	},
	sendUserMessage() {},
};
mod.default(pi);
for (let i = 0; i < 40; i++) {
	try {
		if ((await fetch(`${BASE}/api/kanban`)).ok) break;
	} catch {
		// まだ listen していない
	}
	await new Promise((r) => setTimeout(r, 100));
}
const dashboardHtml = await (await fetch(`${BASE}/`)).text();

// ===========================================================================
// #38-9: DOING 強調は両テンプレートで同じ見た目（片方だけ直す事故を防ぐ）
// ===========================================================================
await check("#38-9 DASHBOARD_HTML が .col.doingcol を持つ", () => {
	// 仕様: 左ボーダー + 淡い背景。色は既存トークンのみ（新しい色を発明しない）。
	const rule = ".col.doingcol{border-left:3px solid var(--accent);background:var(--accent-soft-2)}";
	assert.ok(dashboardHtml.includes(rule), "DASHBOARD_HTML に doingcol の強調が無い（#38-9 の取りこぼし）");
	assert.ok(
		dashboardHtml.includes('(key === "doing" && list.length ? " doingcol" : "")'),
		"dashboard の列に doingcol が付かない",
	);
});

// ===========================================================================
// #38-12: HALTED の理由が footer に出る（haltTag は公開経路 = footer で観測）
// ===========================================================================
{
	const SID = "ops38frozen";
	let entries = [];
	let widget = null;
	const mkCtx = (hasUI) => ({
		hasUI,
		isIdle: () => true,
		ui: {
			notify() {},
			setWidget(_key, lines) {
				widget = lines;
			},
		},
		sessionManager: {
			getSessionId: () => SID,
			getSessionName: () => "frozen",
			getEntries: () => entries,
		},
	});
	const loopEntry = (data) => [{ type: "custom", customType: "kanban-loop", data }];
	const footer = () => {
		assert.ok(Array.isArray(widget), "footer が描かれていない");
		return widget.join("\n");
	};

	await check("#38-12 HALTED:limit / HALTED:stuck #n / 無し を footer に出す", () => {
		const ctx = mkCtx(true);
		// limit
		entries = loopEntry({ count: 10, halted: "limit", scope: "session" });
		handlers.get("session_start")({}, ctx);
		assert.ok(footer().includes("HALTED:limit"), `limit の理由が無い: ${footer()}`);
		// stuck + stuckId
		entries = loopEntry({ count: 3, halted: "stuck", scope: "session", stuckId: 5, stuckCount: 3 });
		handlers.get("session_start")({}, ctx);
		assert.ok(footer().includes("HALTED:stuck #5"), `stuck の card id が無い: ${footer()}`);
		// stuckId 未設定 -> 理由だけ出す。カード id 0 は存在し得ないので #0 は嘘になる。
		entries = loopEntry({ count: 3, halted: "stuck", scope: "session" });
		handlers.get("session_start")({}, ctx);
		assert.ok(footer().includes("HALTED:stuck"), `stuck の理由が無い: ${footer()}`);
		assert.ok(!footer().includes("HALTED:stuck #"), `stuckId 未設定なのに id が出た: ${footer()}`);
		// null -> タグを出さない
		entries = loopEntry({ count: 0, halted: null, scope: null });
		handlers.get("session_start")({}, ctx);
		assert.ok(!footer().includes("HALTED"), `停止していないのに HALTED が出た: ${footer()}`);
	});
}

// --- 結果 ---------------------------------------------------------------------
for (const f of failures) console.error(`FAIL ${f}`);
console.log(`kanban-ops38-frozen: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
