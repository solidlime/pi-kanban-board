// #38 (ダッシュボードの操作系と見た目) のうち、実装はあるがテストで固まっていなかった
// 5 項目を固定する自己検証 (#011)。実装は変えない（#38-9 の CSS だけは両テンプレートで揃えた）。
//   - #38-9  DOING 強調を KANBAN_HTML / DASHBOARD_HTML の両方で持つ
//   - #38-7  列見出しクリックで畳む + render() 再実行後も collapsed が生き残る
//   - #38-8  検索は大文字小文字を無視した部分一致
//   - #38-12 HALTED の理由を footer に出す (limit / stuck #n / 無し)
// フレームワーク無しで `node tests/kanban-ops38-frozen.test.mjs`。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import vm from "node:vm";

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
// #67: /api/kanban.html is gone; the template is exported for the tests that pin it.
const kanbanHtml = mod.KANBAN_HTML;
const dashboardHtml = await (await fetch(`${BASE}/`)).text();

// ===========================================================================
// #38-9: DOING 強調は両テンプレートで同じ見た目（片方だけ直す事故を防ぐ）
// ===========================================================================
await check("#38-9 KANBAN_HTML と DASHBOARD_HTML の .col.doingcol が同一", () => {
	// 仕様: 左ボーダー + 淡い背景。色は既存トークンのみ（新しい色を発明しない）。
	const rule = ".col.doingcol{border-left:3px solid var(--accent);background:var(--accent-soft-2)}";
	assert.ok(kanbanHtml.includes(rule), "KANBAN_HTML に doingcol の強調が無い");
	assert.ok(dashboardHtml.includes(rule), "DASHBOARD_HTML に doingcol の強調が無い（#38-9 の取りこぼし）");
	// 両方に doingcol の列が実際に描画される経路がある
	assert.ok(kanbanHtml.includes('(col === "doing" && list.length ? " doingcol" : "")'), "kanban.html の列に doingcol が付かない");
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

// ===========================================================================
// #38-7 / #38-8: KANBAN_HTML のブラウザ側 JS を vm で走らせる
// ===========================================================================
{
	const scripts = [...kanbanHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
	const apiScript = scripts.find((s) => s.includes('var API = BP + "//"'));
	assert.ok(apiScript, "kanban.html の本体スクリプトを取り出せない");

	// className と classList が連動する最小の DOM 要素。
	const makeEl = (tag) => {
		const cls = new Set();
		const e = {
			tagName: tag,
			children: [],
			parentNode: null,
			style: {},
			dataset: {},
			_attrs: {},
			_lis: {},
			_html: "",
			textContent: "",
			value: "",
			title: "",
			placeholder: "",
			type: "",
			min: "",
			max: "",
			src: "",
			alt: "",
			tabIndex: 0,
			draggable: false,
			hidden: false,
			get className() {
				return [...cls].join(" ");
			},
			set className(v) {
				cls.clear();
				String(v)
					.split(/\s+/)
					.filter((x) => x.length > 0)
					.forEach((x) => cls.add(x));
			},
			get innerHTML() {
				return e._html;
			},
			set innerHTML(v) {
				e._html = String(v);
				if (e._html === "") e.children.length = 0; // 実 DOM と同じく中身が消える
			},
			classList: {
				add: (...c) => c.forEach((x) => cls.add(x)),
				remove: (...c) => c.forEach((x) => cls.delete(x)),
				toggle: (x) => (cls.has(x) ? cls.delete(x) : cls.add(x)),
				contains: (x) => cls.has(x),
			},
			appendChild(c) {
				c.parentNode = e;
				e.children.push(c);
				return c;
			},
			replaceChild() {},
			removeChild() {},
			setAttribute(k, v) {
				e._attrs[k] = String(v);
			},
			getAttribute(k) {
				return k in e._attrs ? e._attrs[k] : null;
			},
			addEventListener(t, fn) {
				(e._lis[t] = e._lis[t] || []).push(fn);
			},
			removeEventListener() {},
			querySelectorAll: () => [],
			focus() {},
		};
		return e;
	};
	const byId = {};
	const document = {
		baseURI: `${BASE}/`,
		getElementById: (id) => byId[id] || (byId[id] = makeEl("div")),
		createElement: (t) => makeEl(t),
		documentElement: makeEl("html"),
		querySelectorAll: () => [],
	};
	let globalCards = [];
	let sessionCards = [];
	const timers = [];
	const fetchStub = (u) => {
		let body = { ok: true };
		if (String(u).includes("/api/kanban")) body = { ok: true, global: { cards: globalCards }, modes: { session: {}, global: {} } };
		else if (String(u).includes("/api/sessions"))
			body = {
				ok: true,
				sessions: [
					{
						id: "s1",
						name: "me",
						cwd: "",
						mine: true,
						isActive: true,
						modified: 0,
						counts: { todo: sessionCards.length, doing: 0, done: 0 },
						modes: { session: {}, global: {} },
						cards: sessionCards,
					},
				],
			};
		return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
	};
	const sandbox = {
		document,
		location: { protocol: "http:", hostname: "127.0.0.1" },
		URL,
		localStorage: { getItem: () => null, setItem() {} },
		matchMedia: () => ({ matches: false, addEventListener() {} }),
		fetch: fetchStub,
		setInterval: (fn) => {
			timers.push(fn);
			return 0;
		},
		clearInterval() {},
		Date,
		console,
	};

	globalCards = [
		{ id: 1, text: "Alpha task", col: "todo" },
		{ id: 2, text: "BETA two", col: "doing" },
	];
	sessionCards = [];
	vm.createContext(sandbox);
	vm.runInContext(apiScript, sandbox);
	for (let i = 0; i < 10; i++) await flush();

	const walk = (node, out = []) => {
		if (!node) return out;
		out.push(node);
		for (const c of node.children || []) walk(c, out);
		return out;
	};
	const cols = (root) => walk(root).filter((n) => n.classList.contains("col"));
	const cardsOf = (root) => walk(root).filter((n) => n.classList.contains("card"));
	const h2Of = (colBox) => colBox.children[0];

	if (byId["global"].children.length === 0) failures.push("vm: GLOBAL が描画されていない（前提が壊れている）");

	await check("#38-7 ckey は board.key:col 形式", () => {
		assert.ok(kanbanHtml.includes('var ckey = board.key + ":" + col;'), "ckey の組み立てが board.key:col でない");
	});

	await check("#38-7 初期状態では .col に collapsed が付かない", () => {
		for (const c of cols(byId["global"])) {
			assert.ok(!c.classList.contains("collapsed"), `初期状態で畳まれている: ${c.className}`);
		}
		assert.equal(cols(byId["global"]).length, 3, "列が 3 つ描画されていない");
	});

	await check("#38-7 見出しクリックで collapsed が付き、render() 再実行後も生き残る", async () => {
		const doing = cols(byId["global"])[1];
		assert.ok(doing.classList.contains("doingcol"), "前提: DOING 列が doingcol でない");
		assert.ok(Array.isArray(h2Of(doing)._lis.click), "見出しに click ハンドラが無い");
		h2Of(doing)._lis.click[0]();
		assert.ok(doing.classList.contains("collapsed"), "クリックで畳まれていない");
		assert.ok(!cols(byId["global"])[0].classList.contains("collapsed"), "別の列まで畳まれた");

		// データが変わって render() が DOM を作り直しても状態は collapsed[ckey] 側に残る
		globalCards = [
			{ id: 1, text: "Alpha task", col: "todo" },
			{ id: 2, text: "BETA two", col: "doing" },
			{ id: 3, text: "fresh", col: "done" },
		];
		assert.ok(timers.length > 0, "poll のタイマーが登録されていない");
		timers[0](); // reload() -> render()
		for (let i = 0; i < 10; i++) await flush();
		const after = cols(byId["global"]);
		assert.equal(after.length, 3, "再描画で列が壊れた");
		assert.ok(cardsOf(byId["global"]).length === 3, "再描画されていない（前提が壊れている）");
		assert.ok(after[1].classList.contains("collapsed"), "再描画で collapsed が失われた");
		assert.ok(!after[0].classList.contains("collapsed"), "再描画で別の列が畳まれた");

		// 戻す（後続の検索テストは全開を前提にする）
		h2Of(after[1])._lis.click[0]();
		assert.ok(!cols(byId["global"])[1].classList.contains("collapsed"), "再クリックで開かない");
	});

	await check("#38-8 空クエリは全件通す", () => {
		assert.equal(cardsOf(byId["global"]).length, 3, `空クエリで全件出ない: ${cardsOf(byId["global"]).length}`);
	});

	await check("#38-8 大文字小文字を無視した部分一致だけを描画する", () => {
		const q = byId["q"];
		assert.ok(Array.isArray(q._lis.input), "検索欄に input ハンドラが無い");
		// カード側が大文字 / クエリ側が大文字の両方向を見る
		q.value = "beta";
		q._lis.input[0]();
		assert.equal(cardsOf(byId["global"]).length, 1, "部分一致で 1 件に絞られていない");
		assert.ok(
			walk(byId["global"]).some((n) => n.classList.contains("body") && n.innerHTML.includes("BETA")),
			"一致したカードが描画されていない",
		);
		q.value = "ALPHA";
		q._lis.input[0]();
		assert.equal(cardsOf(byId["global"]).length, 1, "大文字クエリで小文字化されていない");
	});

	await check("#38-8 一致しないカードは描画されず「該当なし」になる", () => {
		const q = byId["q"];
		q.value = "zzz";
		q._lis.input[0]();
		assert.equal(cardsOf(byId["global"]).length, 0, "一致しないカードが残っている");
		const empties = walk(byId["global"]).filter((n) => n.classList.contains("col-empty"));
		assert.equal(empties.length, 3, "空表示が 3 列に出ていない");
		assert.ok(
			empties.every((n) => n.textContent === "該当なし"),
			"検索中の空表示が「該当なし」でない",
		);
	});

	await check("#38-8 クエリをクリアすると全件戻る", () => {
		const q = byId["q"];
		q.value = "";
		q._lis.input[0]();
		assert.equal(cardsOf(byId["global"]).length, 3, "クリアで全件戻らない");
	});
}

// --- 結果 ---------------------------------------------------------------------
for (const f of failures) console.error(`FAIL ${f}`);
console.log(`kanban-ops38-frozen: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
