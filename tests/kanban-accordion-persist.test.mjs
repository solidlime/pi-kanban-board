// #62 アコーディオンの開閉状態の維持の自己検証 (#011)。
//   (a) project ボードの列を畳む -> kb-collapse に書かれる -> vm を立て直すと畳まれたまま
//   (b) 列の折りたたみキーはボード + 列ごと（別の列を巻き込まない）
//   (c) localStorage が例外を投げるスタブでも描画が壊れない
// #17/#62 の GLOBAL 欄（読み取り専用の集約ビュー）は削除したので、見出しの開閉は無い。
// フレームワーク無しで `node tests/kanban-accordion-persist.test.mjs`。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import vm from "node:vm";
import { authFetch } from "./helpers/token.mjs";
import { useKanban } from "./helpers/board.mjs";

// #83b: HTTP routes need the server token now; tf = fetch + the kb_auth cookie.
const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-accordion-persist-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/projects`, { recursive: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/media`, { recursive: true });
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

const { createJiti } = createRequire(import.meta.url)(
	process.env.KANBAN_JITI ?? createRequire(import.meta.url).resolve("jiti"),
);
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url)));
useKanban(mod);

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
		if ((await tf(`${BASE}/`)).ok) break;
	} catch {
		// まだ listen していない
	}
	await new Promise((r) => setTimeout(r, 100));
}

const dashboardHtml = await (await tf(`${BASE}/`)).text();
// #84: KANBAN_HTML retired — the dashboard is the only template left.

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

// #17: session 行は無い。ボードは project（自 cwd）と global の 2 枚。
const projectCards = () => [
	{ id: 1, col: "todo", text: "alpha task" },
	{ id: 2, col: "todo", text: "beta task" },
	{ id: 3, col: "doing", text: "gamma task" },
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
		stats: { todo: 4, doing: 1, done: 1, serve: 0, media: 0 },
		global: { counts: { todo: 1, doing: 1, done: 1 }, cards: globalCards(), modes: {}, loops: 0, halted: false },
		project: { id: "alpha", counts: { todo: 2, doing: 1, done: 0 }, cards: projectCards(), modes: {}, loops: 0, halted: false },
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

// ===========================================================================
// 文字列レベル: 実装の入口が両テンプレートにある
// ===========================================================================
await check("#62 ダッシュボードが既存のキー kb-collapse を使う", () => {
	assert.ok(dashboardHtml.includes('var LS_KEY = "kb-collapse"'), "dashboard に kb-collapse が無い");
	// #84: 名前空間は dash だけ。kanban 側は消えたので、残骸が出てきたらここで落とす
	assert.ok(dashboardHtml.includes('LS_NS = "dash"'), "dashboard の名前空間が無い");
	assert.ok(!dashboardHtml.includes('LS_NS = "kanban"'), "消えた kanban 名前空間が復活している");
	// 既存の kb-theme は触っていない
	assert.ok(dashboardHtml.includes('localStorage.getItem("kb-theme")'), "kb-theme が壊れている");
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
// (a) project ボードの列折りたたみ: 畳む -> 保存 -> 立て直しても畳まれたまま
//     #17: session 行ごとの開閉（sess.*）は廃止。畳めるのは GLOBAL の見出しと列だけ。
// ===========================================================================
{
	const storage = makeStorage();
	const d1 = await runDashboard(storage);
	const projCols = (d) => walk(d.byId["project"]).filter(byClass("col"));

	await check("#62(a) 前提: project の列は 3 つとも開いている", () => {
		assert.equal(projCols(d1).length, 3, "project の列が 3 つない");
		assert.equal(projCols(d1).filter((c) => c.classList.contains("collapsed")).length, 0, "既定で畳まれている");
	});

	await check("#62(a) クリックで畳むと kb-collapse に project.:todo が書かれる（sid は混ざらない）", () => {
		const todo = projCols(d1)[0];
		const h = todo.children[0];
		assert.ok(h._lis.click && h._lis.click.length, "列見出しに click リスナが無い");
		h._lis.click[0]({ target: null });
		assert.ok(todo.classList.contains("collapsed"), "畳めていない");
		const saved = storage.read("kb-collapse");
		assert.ok(saved && saved.dash, "dash の名前空間が保存されていない");
		assert.equal(saved.dash.cols["project.:todo"], true, `project.:todo が保存されていない: ${JSON.stringify(saved.dash.cols)}`);
		// #17: session 行の開閉状態（sess）はもう書かない。
		assert.equal(saved.dash.sess, undefined, "廃止した sess が書かれている");
		assert.equal(saved.dash.g, true, "GLOBAL の既定（開）が壊れている");
	});

	await check("#62(a) localStorage を使えない環境でも同じ操作が落ちない（getItem 例外）", async () => {
		const broken = makeStorage();
		broken.throwOnEverything();
		const d = await runDashboard(broken);
		const todo = walk(d.byId["project"]).filter(byClass("col"))[0];
		assert.ok(todo && todo.children[0]._lis.click, "壊れた storage で描画/リスナが死んでいる");
		todo.children[0]._lis.click[0]({ target: null }); // persist() が throw しても握りつぶされる
		assert.ok(todo.classList.contains("collapsed"), "畳めていない");
	});

	// vm を立て直す = 再訪 / F5。同じ localStorage を渡すと畳まれたまま。
	const d2 = await runDashboard(storage);
	await check("#62(a) 立て直しても project の todo 列は畳まれたまま（他は開）", () => {
		const cols = projCols(d2);
		assert.equal(cols.length, 3);
		assert.ok(cols[0].classList.contains("collapsed"), "todo 列が復元されていない");
		assert.ok(!cols[1].classList.contains("collapsed"), "doing 列まで畳まれている");
		assert.ok(!cols[2].classList.contains("collapsed"), "done 列まで畳まれている");
	});
}

// ===========================================================================
// (b) 列折りたたみのキーはボード + 列（GLOBAL 欄の削除で板は project だけ）
// ===========================================================================
{
	const storage = makeStorage();
	const d = await runDashboard(storage);
	const pCols = () => walk(d.byId["project"]).filter(byClass("col"));

	await check("#62(b) project の todo と doing を別々に畳める（キーは列ごと）", () => {
		assert.equal(pCols().length, 3, "project の列が 3 つない");
		pCols()[0].children[0]._lis.click[0]({ target: null });
		pCols()[1].children[0]._lis.click[0]({ target: null });
		const keys = Object.keys(storage.read("kb-collapse").dash.cols).sort();
		assert.deepEqual(keys, ["project.:doing", "project.:todo"], `キーが想定と違う: ${JSON.stringify(keys)}`);
		assert.ok(pCols()[0].classList.contains("collapsed"), "todo が畳まれていない");
		assert.ok(!pCols()[2].classList.contains("collapsed"), "done まで畳まれている");
	});

	await check("#62(b) 立て直しても畳んだ 2 列だけが残る", async () => {
		const d2 = await runDashboard(storage);
		const cols = walk(d2.byId["project"]).filter(byClass("col"));
		assert.equal(cols.length, 3, "再訪で列が壊れた");
		assert.ok(cols[0].classList.contains("collapsed"), "todo 列が開いた");
		assert.ok(cols[1].classList.contains("collapsed"), "doing 列が開いた");
		assert.ok(!cols[2].classList.contains("collapsed"), "done 列まで畳まれている");
	});
}

// ===========================================================================
// (c) localStorage が例外を投げるスタブでも描画が壊れない
// ===========================================================================
{
	await check("#62(c) ダッシュボード: getItem/setItem が throw しても描画が壊れない", async () => {
		const broken = makeStorage();
		broken.throwOnEverything();
		const d = await runDashboard(broken);
		assert.equal(walk(d.byId["project"]).filter(byClass("sess-hd")).length, 1, "project 行が描画されていない");
		assert.equal(walk(d.byId["project"]).filter(byClass("cols")).length, 1, "既定（開）が壊れている");
		// 畳む操作も落ちない（persist の throw は握りつぶされる）
		const todo = walk(d.byId["project"]).filter(byClass("col"))[0];
		todo.children[0]._lis.click[0]({ target: null });
		assert.ok(todo.classList.contains("collapsed"), "壊れた storage で畳めない");
	});

	await check("#62(c) 破損した保存値（JSON.parse 失敗）でも既定に戻るだけ", async () => {
		const broken = makeStorage({ "kb-collapse": "{not json" });
		const d = await runDashboard(broken);
		assert.equal(walk(d.byId["project"]).filter(byClass("cols")).length, 1, "既定が壊れている");
	});
}

for (const f of failures) console.error("FAIL", f);
console.log(`kanban-accordion-persist: ${passed} passed, ${failures.length} failed`);
// サーバを掴んだままにしない（プロセスを終了させる）
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
