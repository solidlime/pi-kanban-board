// #62 アコーディオンの開閉状態の維持 + GLOBAL の折りたたみ の自己検証 (#011)。
//   (a) ダッシュボード: セッションを畳む -> kb-collapse に書かれる -> vm を立て直すと畳まれたまま
//   (b) 右パネル: 同じこと（テンプレートごとに独立したキー名前空間）
//   (c) GLOBAL ボードが role/tabindex/aria-expanded を持ち、クリックで閉じて中身が消える
//   (d) キーボード（Enter / Space）でも GLOBAL が畳める
//   (e) GLOBAL の列折りたたみのキーに active sid が混ざらない（"global:todo" 形式）
//   (f) localStorage が例外を投げるスタブでも描画が壊れない
// フレームワーク無しで `node tests/kanban-accordion-persist.test.mjs`。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import vm from "node:vm";

const HOME_DIR = "/tmp/kb-accordion-persist-home";
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
		if (r && typeof r.then === "function")
			return r.then(
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
const flushN = async (n = 10) => {
	for (let i = 0; i < n; i++) await flush();
};

const pi = {
	registerCommand() {},
	registerTool() {},
	appendEntry() {},
	on() {},
	sendUserMessage() {},
};
mod.default(pi);
for (let i = 0; i < 40; i++) {
	try {
		if ((await fetch(`${BASE}/`)).ok) break;
	} catch {
		// まだ listen していない
	}
	await new Promise((r) => setTimeout(r, 100));
}

const dashboardHtml = await (await fetch(`${BASE}/`)).text();
const kanbanHtml = await (await fetch(`${BASE}/api/kanban.html`)).text();

// ---------------------------------------------------------------------------
// 共有ハーネス: className と classList が連動する最小 DOM（既存テストと同じ流用元）
// ---------------------------------------------------------------------------
const makeEl = (tag) => {
	const cls = new Set();
	const e = {
		tagName: tag || "div",
		children: [],
		parentNode: null,
		style: {},
		dataset: {},
		hidden: false,
		_attrs: {},
		_lis: {},
		_html: "",
		textContent: "",
		value: "",
		title: "",
		placeholder: "",
		type: "",
		min: "",
		src: "",
		alt: "",
		tabIndex: 0,
		draggable: false,
		focused: false,
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
			if (e._html === "") e.children.length = 0; // 実 DOM と同じく子が消える
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
		insertBefore(c) {
			c.parentNode = e;
			e.children.push(c);
			return c;
		},
		replaceChild() {},
		removeChild(c) {
			const i = e.children.indexOf(c);
			if (i >= 0) e.children.splice(i, 1);
		},
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
		querySelector: () => null,
		closest: () => null,
		focus() {
			e.focused = true;
		},
		blur() {},
	};
	return e;
};

const walk = (node, out = []) => {
	if (!node) return out;
	out.push(node);
	for (const c of node.children || []) walk(c, out);
	return out;
};
const byClass = (cls) => (n) => String(n.className).split(/\s+/).includes(cls);

// 保存される localStorage。テスト間で使い回し、vm を立て直して「再訪」を作る。
const makeStorage = (seed) => {
	const map = new Map(seed ? Object.entries(seed) : []);
	let throws = false;
	return {
		map,
		throwOnEverything() {
			throws = true;
		},
		getItem(k) {
			if (throws) throw new Error("storage disabled");
			return map.has(k) ? map.get(k) : null;
		},
		setItem(k, v) {
			if (throws) throw new Error("quota exceeded");
			map.set(k, String(v));
		},
		read(key) {
			const raw = map.get(key);
			return raw == null ? null : JSON.parse(raw);
		},
	};
};

const sessionPayload = () => [
	{
		id: "s1",
		name: "kotomi",
		cwd: "/tmp",
		isActive: true,
		mine: true,
		updatedAt: "2026-01-01T00:00:00.000Z",
		modified: 0,
		modes: { session: {}, global: {} },
		counts: { todo: 2, doing: 0, done: 0 },
		cards: [
			{ id: 1, col: "todo", text: "alpha task" },
			{ id: 2, col: "todo", text: "beta task" },
		],
	},
	{
		id: "s2",
		name: "other",
		cwd: "/tmp",
		isActive: false,
		mine: false,
		updatedAt: "2026-01-01T00:00:00.000Z",
		modified: 0,
		modes: { session: {}, global: {} },
		counts: { todo: 1, doing: 0, done: 0 },
		cards: [{ id: 3, col: "todo", text: "gamma task" }],
	},
];
const globalCards = () => [
	{ id: 10, col: "todo", text: "GLOBAL: 配色" },
	{ id: 11, col: "doing", text: "GLOBAL: 検索" },
	{ id: 12, col: "done", text: "GLOBAL: パッケージ" },
];

const scriptsOf = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

// ---------------------------------------------------------------------------
// ダッシュボード用の sandbox
// ---------------------------------------------------------------------------
const runDashboard = async (storage) => {
	const scripts = scriptsOf(dashboardHtml);
	const apiScript = scripts.find((s) => s.includes('var API = "/api/dashboard"'));
	if (!apiScript) throw new Error("dashboard のポーリング JS を抽出できない");
	const byId = {};
	const document = {
		activeElement: null,
		getElementById: (id) => byId[id] || (byId[id] = makeEl("div")),
		createElement: (t) => makeEl(t),
		createTextNode: (t) => {
			const n = makeEl("#text");
			n.textContent = String(t);
			return n;
		},
		documentElement: makeEl("html"),
		querySelectorAll: () => [],
		_lis: {},
		addEventListener(t, fn) {
			(document._lis[t] = document._lis[t] || []).push(fn);
		},
	};
	const payload = {
		host: "test-host",
		now: "2026-01-01T00:00:00.000Z",
		stats: { sessions: 2, active: 1, todo: 3, doing: 0, done: 0, serve: 0, media: 0 },
		global: { counts: { todo: 1, doing: 1, done: 1 }, cards: globalCards() },
		sessions: sessionPayload(),
		serve: [],
	};
	const timers = [];
	let nextId = 1;
	const sandbox = {
		document,
		window: {},
		URL,
		localStorage: storage,
		matchMedia: () => ({ matches: false, addEventListener() {} }),
		fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) }),
		setTimeout(fn, ms) {
			const id = nextId++;
			timers.push({ id, fn, ms });
			return id;
		},
		clearTimeout(id) {
			const i = timers.findIndex((t) => t.id === id);
			if (i >= 0) timers.splice(i, 1);
		},
		console,
	};
	vm.createContext(sandbox);
	vm.runInContext(apiScript, sandbox);
	await flushN(4);
	return { byId, timers, sandbox, document };
};

// ---------------------------------------------------------------------------
// 右パネル用の sandbox
// ---------------------------------------------------------------------------
const runKanban = async (storage) => {
	const scripts = scriptsOf(kanbanHtml);
	const apiScript = scripts.find((s) => s.includes('var API = BP + "//"'));
	if (!apiScript) throw new Error("kanban.html の本体スクリプトを取り出せない");
	const byId = {};
	const document = {
		baseURI: `${BASE}/api/kanban.html`,
		getElementById: (id) => byId[id] || (byId[id] = makeEl("div")),
		createElement: (t) => makeEl(t),
		createTextNode: (t) => {
			const n = makeEl("#text");
			n.textContent = String(t);
			return n;
		},
		documentElement: makeEl("html"),
		querySelectorAll: () => [],
	};
	const fetchStub = (u) => {
		let body = { ok: true };
		if (String(u).includes("/api/kanban"))
			body = { ok: true, global: { cards: globalCards() }, modes: { session: {}, global: {} } };
		else if (String(u).includes("/api/sessions")) body = { ok: true, sessions: sessionPayload() };
		return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
	};
	const timers = [];
	const sandbox = {
		document,
		location: { protocol: "http:", hostname: "127.0.0.1" },
		URL,
		localStorage: storage,
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
	vm.createContext(sandbox);
	vm.runInContext(apiScript, sandbox);
	await flushN(10);
	return { byId, timers, sandbox };
};

// ===========================================================================
// 文字列レベル: 実装の入口が両テンプレートにある
// ===========================================================================
await check("#62 両テンプレートが同じキー kb-collapse を使う", () => {
	assert.ok(dashboardHtml.includes('var LS_KEY = "kb-collapse"'), "dashboard に kb-collapse が無い");
	assert.ok(kanbanHtml.includes('var LS_KEY = "kb-collapse"'), "kanban.html に kb-collapse が無い");
	// キー名前空間はテンプレートごとに独立（片方の開閉が他方を壊さない）
	assert.ok(dashboardHtml.includes('LS_NS = "dash"'), "dashboard の名前空間が無い");
	assert.ok(kanbanHtml.includes('LS_NS = "kanban"'), "kanban.html の名前空間が無い");
	// 既存の kb-theme は触っていない
	assert.ok(dashboardHtml.includes('localStorage.getItem("kb-theme")'), "kb-theme が壊れている");
	assert.ok(kanbanHtml.includes('localStorage.getItem("kb-theme")'), "kb-theme が壊れている");
});

await check("#62 GLOBAL の ckey は active sid を含まない", () => {
	assert.ok(
		dashboardHtml.includes('var ckey = ctx.scope === "global" ? "global:" + key : ctx.scope + "." + ctx.sid + ":" + key;'),
		"dashboard の GLOBAL ckey に sid が混ざっている",
	);
	// セッション側の名前空間は従来どおり
	assert.ok(dashboardHtml.includes('ctx.scope + "." + ctx.sid + ":" + key'), "セッション側のキー形式が変わっている");
});

// ===========================================================================
// (a) ダッシュボード: 畳む -> 保存 -> 立て直しても畳まれたまま
// ===========================================================================
{
	const storage = makeStorage();
	const d1 = await runDashboard(storage);
	const heads = () => walk(d1.byId["sessions"]).filter(byClass("sess-hd"));
	const bodies = () => walk(d1.byId["sessions"]).filter(byClass("cols")).length;

	await check("#62(a) 前提: 既定は全開（s1 / s2 とも本体が出ている）", () => {
		assert.equal(heads().length, 2, "セッション見出しが 2 つない");
		assert.equal(bodies(), 2, "既定で畳まれている");
	});

	await check("#62(a) クリックで畳むと kb-collapse に sess.s1=false が書かれる", () => {
		const h = heads()[0];
		assert.ok(h._lis.click && h._lis.click.length, "click リスナが無い");
		h._lis.click[0]({ target: null });
		assert.equal(bodies(), 1, "畳めていない");
		const saved = storage.read("kb-collapse");
		assert.ok(saved && saved.dash, "dash の名前空間が保存されていない");
		assert.equal(saved.dash.sess.s1, false, "s1 が false で保存されていない");
		assert.equal(saved.dash.g, true, "GLOBAL の既定（開）が壊れている");
	});

	await check("#62(a) localStorage を使えない環境でも同じ操作が落ちない（getItem 例外）", async () => {
		const broken = makeStorage();
		broken.throwOnEverything();
		const d = await runDashboard(broken);
		const h = walk(d.byId["sessions"]).filter(byClass("sess-hd"))[0];
		assert.ok(h && h._lis.click, "壊れた storage で描画/リスナが死んでいる");
		h._lis.click[0]({ target: null }); // persist() が throw しても握りつぶされる
		assert.equal(walk(d.byId["sessions"]).filter(byClass("cols")).length, 1, "畳めていない");
	});

	// vm を立て直す = 再訪 / F5。同じ localStorage を渡すと畳まれたまま。
	const d2 = await runDashboard(storage);
	await check("#62(a) 立て直しても畳まれたまま（s1 は閉、s2 は開）", () => {
		const h2 = walk(d2.byId["sessions"]).filter(byClass("sess-hd"));
		assert.equal(h2.length, 2);
		assert.equal(h2[0].getAttribute("aria-expanded"), "false", "s1 が復元されていない");
		assert.equal(h2[1].getAttribute("aria-expanded"), "true", "s2 の既定が壊れている");
		assert.equal(walk(d2.byId["sessions"]).filter(byClass("cols")).length, 1, "本体の数が違う");
		// caret も閉じている
		const carets = walk(d2.byId["sessions"])
			.filter(byClass("caret"))
			.map((n) => n.textContent);
		assert.deepEqual(carets, ["\u25B8", "\u25BE"], `caret が復元されていない: ${JSON.stringify(carets)}`);
	});
}

// ===========================================================================
// (b) 右パネル: 同じことを独立した名前空間で
// ===========================================================================
{
	const storage = makeStorage();
	const k1 = await runKanban(storage);
	const sessHeads = (byId) => walk(byId["sessions"]).filter(byClass("sess-hd"));

	await check("#62(b) 前提: 既定は mine だけ開（s1 開 / s2 閉）", () => {
		const hs = sessHeads(k1.byId);
		assert.equal(hs.length, 2, "セッションが 2 つない");
		assert.equal(hs[0].getAttribute("aria-expanded"), "true", "mine の既定が開でない");
		assert.equal(hs[1].getAttribute("aria-expanded"), "false", "他セッションの既定が閉でない");
	});

	await check("#62(b) クリックで畳むと kanban 名前空間に保存される", () => {
		const hs = sessHeads(k1.byId);
		assert.ok(hs[0]._lis.click && hs[0]._lis.click.length, "click リスナが無い");
		hs[0]._lis.click[0]({ target: null });
		const saved = storage.read("kb-collapse");
		assert.ok(saved && saved.kanban, "kanban の名前空間が保存されていない");
		assert.equal(saved.kanban.sess.s1, false, "s1 が false で保存されていない");
		assert.ok(!saved.dash, "右パネルが dashboard の名前空間を作っている");
	});

	const k2 = await runKanban(storage);
	await check("#62(b) 立て直しても畳まれたまま（s1 閉 / s2 は既定の閉）", () => {
		const hs = sessHeads(k2.byId);
		assert.equal(hs[0].getAttribute("aria-expanded"), "false", "s1 が復元されていない");
		assert.equal(hs[1].getAttribute("aria-expanded"), "false", "s2 の既定が壊れている");
		// aria-expanded が付いた = a11y 属性も入っている
		assert.equal(hs[0].getAttribute("role"), "button", "role が無い");
		assert.equal(hs[0].getAttribute("tabindex"), "0", "tabindex が無い");
	});
}

// ===========================================================================
// (c) GLOBAL は a11y 付きのボタンで、クリックで閉じ中身が消える
// ===========================================================================
{
	const storage = makeStorage();
	const d = await runDashboard(storage);
	const gHead = () => walk(d.byId["global"]).filter(byClass("sess-hd"))[0];
	const gCols = () => walk(d.byId["global"]).filter(byClass("cols")).length;
	const gCards = () => walk(d.byId["global"]).filter(byClass("card")).length;

	await check("#62(c) GLOBAL 見出しは role=button / tabindex=0 / aria-expanded=true", () => {
		const h = gHead();
		assert.ok(h, "GLOBAL の見出しが無い");
		assert.equal(h.getAttribute("role"), "button", "role=button が無い");
		assert.equal(h.getAttribute("tabindex"), "0", "tabindex=0 が無い");
		assert.equal(h.getAttribute("aria-expanded"), "true", "aria-expanded が true でない");
		assert.ok(gCols() === 1, "既定で GLOBAL の列が出ていない");
		assert.equal(gCards(), 3, "GLOBAL のカードが 3 枚でない");
	});

	await check("#62(c) クリックで aria-expanded が true->false、中身が消える", () => {
		const h = gHead();
		assert.ok(h._lis.click && h._lis.click.length, "GLOBAL に click リスナが無い");
		h._lis.click[0]({ target: null });
		assert.equal(gHead().getAttribute("aria-expanded"), "false", "aria-expanded が false にならない");
		assert.equal(gCols(), 0, "畳んだのに列が DOM にある");
		assert.equal(gCards(), 0, "畳んだのにカードが DOM にある");
		assert.equal(gHead().children[0].textContent, "\u25BE".replace("\u25BE", "\u25B8"), "caret が ▸ でない");
		// 保存もされる
		assert.equal(storage.read("kb-collapse").dash.g, false, "GLOBAL の閉が保存されていない");
	});

	await check("#62(c) 立て直しても GLOBAL は畳まれたまま", async () => {
		const d2 = await runDashboard(storage);
		const h2 = walk(d2.byId["global"]).filter(byClass("sess-hd"))[0];
		assert.equal(h2.getAttribute("aria-expanded"), "false", "GLOBAL の閉が復元されていない");
		assert.equal(walk(d2.byId["global"]).filter(byClass("cols")).length, 0, "中身が復元されている");
	});
}

// ===========================================================================
// (d) キーボードでも GLOBAL が畳める（Enter / Space）
// ===========================================================================
{
	const d = await runDashboard(makeStorage());
	const gHead = () => walk(d.byId["global"]).filter(byClass("sess-hd"))[0];
	const key = (k) => {
		const h = gHead();
		assert.ok(h._lis.keydown && h._lis.keydown.length, "GLOBAL に keydown リスナが無い");
		h._lis.keydown[0]({ key: k, target: null, preventDefault() {} });
	};

	await check("#62(d) Enter で畳める", () => {
		key("Enter");
		assert.equal(gHead().getAttribute("aria-expanded"), "false", "Enter で畳めていない");
		assert.equal(walk(d.byId["global"]).filter(byClass("cols")).length, 0, "Enter で中身が消えていない");
	});
	await check("#62(d) Space で開ける", () => {
		key(" ");
		assert.equal(gHead().getAttribute("aria-expanded"), "true", "Space で開けない");
		assert.equal(walk(d.byId["global"]).filter(byClass("cols")).length, 1, "Space で中身が戻らない");
	});
	await check("#62(d) Enter/Space 以外では畳まない", () => {
		key("ArrowDown");
		assert.equal(gHead().getAttribute("aria-expanded"), "true", "矢印キーで畳まれた");
	});

	// 右パネル側の GLOBAL も同じ
	const k = await runKanban(makeStorage());
	const kHead = () => walk(k.byId["global"]).filter(byClass("hd"))[0];
	await check("#62(d) 右パネルの GLOBAL 見出しも a11y 付きのボタン", () => {
		const h = kHead();
		assert.ok(h, "右パネルに GLOBAL 見出しが無い");
		assert.equal(h.getAttribute("role"), "button", "role=button が無い");
		assert.equal(h.getAttribute("tabindex"), "0", "tabindex=0 が無い");
		assert.equal(h.getAttribute("aria-expanded"), "true", "aria-expanded が true でない");
		assert.equal(walk(k.byId["global"]).filter(byClass("cols")).length, 1, "既定で列が出ていない");
	});
	await check("#62(d) 右パネルの GLOBAL もキーボードで畳める（Enter -> Space）", () => {
		const kkey = (kk) => {
			const h = kHead();
			assert.ok(h._lis.keydown && h._lis.keydown.length, "GLOBAL に keydown リスナが無い");
			h._lis.keydown[0]({ key: kk, target: null, preventDefault() {} });
		};
		kkey("Enter");
		// 右パネルは reload() 経由の非同期再描画なので、描画を待ってから確かめる
		return flushN(10).then(() => {
			assert.equal(walk(k.byId["global"]).filter(byClass("cols")).length, 0, "Enter で中身が消えていない");
			assert.equal(kHead().getAttribute("aria-expanded"), "false", "Enter で aria-expanded が false でない");
			kkey(" ");
			return flushN(10);
		}).then(() => {
			assert.equal(walk(k.byId["global"]).filter(byClass("cols")).length, 1, "Space で中身が戻らない");
			assert.equal(kHead().getAttribute("aria-expanded"), "true", "Space で aria-expanded が true でない");
		});
	});
}

// ===========================================================================
// (e) GLOBAL の列折りたたみのキーに active sid が混ざらない
// ===========================================================================
{
	const storage = makeStorage();
	const d = await runDashboard(storage);
	const gCols = () => walk(d.byId["global"]).filter(byClass("col"));
	const h3Of = (c) => c.children[0];

	await check("#62(e) GLOBAL の DOING を畳むと cols のキーは global:doing（sid 無し）", () => {
		assert.equal(gCols().length, 3, "GLOBAL の列が 3 つない");
		const doing = gCols()[1];
		assert.ok(Array.isArray(h3Of(doing)._lis.click), "列見出しに click ハンドラが無い");
		h3Of(doing)._lis.click[0]();
		assert.ok(doing.classList.contains("collapsed"), "列が畳まれていない");
		const saved = storage.read("kb-collapse");
		const keys = Object.keys(saved.dash.cols);
		assert.ok(keys.includes("global:doing"), `global:doing が無い: ${JSON.stringify(keys)}`);
		assert.ok(
			!keys.some((k) => k.indexOf("global.") === 0 || k.indexOf("s1") >= 0 || k.indexOf("s2") >= 0),
			`GLOBAL のキーに sid が混ざっている: ${JSON.stringify(keys)}`,
		);
	});

	await check("#62(e) 立て直しても GLOBAL の列は畳まれたまま", async () => {
		const d2 = await runDashboard(storage);
		const cols2 = walk(d2.byId["global"]).filter(byClass("col"));
		assert.equal(cols2.length, 3, "再訪で列が壊れた");
		assert.ok(cols2[1].classList.contains("collapsed"), "再訪で GLOBAL の列が開いた");
		assert.ok(!cols2[0].classList.contains("collapsed"), "別の列まで畳まれている");
	});

	// 右パネル: board.key "g" + ":" + col = "g:doing"（sid を含まない）
	const k = await runKanban(makeStorage());
	await check("#62(e) 右パネルの GLOBAL 列キーも sid を含まない（g:doing）", () => {
		const gcols = walk(k.byId["global"]).filter(byClass("col"));
		assert.equal(gcols.length, 3, "右パネルの GLOBAL に列が 3 つない");
		const h2 = gcols[1].children[0];
		assert.ok(Array.isArray(h2._lis.click), "列見出しに click ハンドラが無い");
		h2._lis.click[0]();
		assert.ok(gcols[1].classList.contains("collapsed"), "右パネルで列が畳まれていない");
	});
}

// ===========================================================================
// (f) localStorage が例外を投げるスタブでも描画が壊れない
// ===========================================================================
{
	await check("#62(f) ダッシュボード: getItem/setItem が throw しても描画が壊れない", async () => {
		const broken = makeStorage();
		broken.throwOnEverything();
		const d = await runDashboard(broken);
		assert.equal(walk(d.byId["sessions"]).filter(byClass("sess-hd")).length, 2, "セッションが描画されていない");
		assert.equal(walk(d.byId["sessions"]).filter(byClass("cols")).length, 2, "既定（全開）が壊れている");
		assert.equal(walk(d.byId["global"]).filter(byClass("cols")).length, 1, "GLOBAL が描画されていない");
		// 畳む操作も落ちない（persist の throw は握りつぶされる）
		const gh = walk(d.byId["global"]).filter(byClass("sess-hd"))[0];
		gh._lis.click[0]({ target: null });
		assert.equal(walk(d.byId["global"]).filter(byClass("cols")).length, 0, "壊れた storage で畳めない");
	});

	await check("#62(f) 破損した保存値（JSON.parse 失敗）でも前提の既定に戻るだけ", async () => {
		const broken = makeStorage({ "kb-collapse": "{not json" });
		const d = await runDashboard(broken);
		assert.equal(walk(d.byId["sessions"]).filter(byClass("cols")).length, 2, "既定が壊れている");
		assert.equal(walk(d.byId["global"]).filter(byClass("cols")).length, 1, "GLOBAL の既定が壊れている");
	});

	await check("#62(f) 右パネル: getItem/setItem が throw しても描画が壊れない", async () => {
		const broken = makeStorage();
		broken.throwOnEverything();
		const k = await runKanban(broken);
		const hs = walk(k.byId["sessions"]).filter(byClass("sess-hd"));
		assert.equal(hs.length, 2, "セッションが描画されていない");
		assert.equal(hs[0].getAttribute("aria-expanded"), "true", "mine の既定が壊れている");
		assert.equal(hs[1].getAttribute("aria-expanded"), "false", "他セッションの既定が壊れている");
		hs[0]._lis.click[0]({ target: null }); // persist -> throw -> 握りつぶし
		assert.equal(walk(k.byId["global"]).filter(byClass("cols")).length, 1, "GLOBAL が壊れている");
	});
}

for (const f of failures) console.error("FAIL", f);
console.log(`kanban-accordion-persist: ${passed} passed, ${failures.length} failed`);
// サーバを掴んだままにしない（プロセスを終了させる）
process.exit(failures.length === 0 ? 0 : 1);
