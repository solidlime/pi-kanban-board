// #48 ダッシュボードのセッション折りたたみ + カード検索の自己検証 (#011)。
// フレームワーク無しで `node tests/kanban-dashboard-collapse-search.test.mjs`。
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

const HOME_DIR = "/tmp/kb-dashboard-collapse-search-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
mkdirSync(`${HOME_DIR}/workspace`, { recursive: true });
process.env.HOME = HOME_DIR;
// Windows: os.homedir() prefers USERPROFILE over HOME, so keep them in step or the
// server writes its token to the real profile and this test reads a missing file.
process.env.USERPROFILE = process.env.HOME;
process.env.KANBAN_PORT = String(
	await new Promise((resolve) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	}),
);
const PORT = process.env.KANBAN_PORT;
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
		fn();
		passed += 1;
	} catch (err) {
		failures.push(`${name}: ${err.message}`);
	}
};
const flush = () => new Promise((r) => setImmediate(r));

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

// --- 1. 実サーバ: GET / が 200 で新コードを含む ------------------------------
const res = await tf(`${BASE}/`);
const html = await res.text();
check("GET / は 200", () => assert.equal(res.status, 200));

// --- 2. 文字列レベル ---------------------------------------------------------
// #17: GLOBAL 欄（読み取り専用の集約ビュー）は削除した。開閉するヘッダごと無い。
check("GLOBAL 欄と renderGlobal は撤去されている", () => {
	assert.ok(!html.includes("renderGlobal("), "renderGlobal が残っている");
	assert.ok(!html.includes('id="global"'), "GLOBAL 欄が残っている");
});

check("検索欄は絞り込みバーの中、#project の手前", () => {
	assert.ok(html.includes('id="q" class="q" type="search"'), "検索 input が無い");
	assert.ok(html.includes('placeholder="検索: 本文・#番号・project・sid・session・commit・blocked・label（/ でフォーカス, Esc でクリア）"'));
	assert.ok(html.includes('autocomplete="off"'));
	// #17: session 行が消えたので検索欄は絞り込みバー（#filters）へ移った。
	const pane = html.slice(html.indexOf('id="filters"'), html.indexOf('id="h-project"'));
	assert.ok(pane.indexOf('id="q"') >= 0, "検索欄が絞り込みバーの外にある");
	assert.ok(html.indexOf('id="q"') < html.indexOf('id="project"'));
	assert.ok(html.includes(".q{width:100%;max-width:320px"), "CSS が無い");
});

check("カードのフィルタとキーボード操作がある", () => {
	// #21: 検索の述語は cardHit() に集約した（GLOBAL 欄の削除で呼び元は project の 1 箇所）。
	assert.equal((html.match(/cardHit\(x, query\)/g) || []).length, 1, "cardHit(x, query) の呼び元が 1 箇所でない");
	assert.match(html, /function cardHit\(c, q\)\{/);
	assert.doesNotMatch(html, /String\(x\.text \|\| ""\)\.toLowerCase\(\)/);
	assert.match(html, /e\.key === "\/"/);
	assert.match(html, /e\.key === "Escape" && document\.activeElement === qe/);
	assert.match(html, /qEl\.addEventListener\("input"/);
	assert.ok(html.includes('"sess-empty"'), "該当なし表示が無い");
	assert.ok(html.includes(".sess-empty{"), "該当なしの CSS が無い");
});

check("件数は検索中だけヒット/総数（meta の乖離を潰す）", () => {
	assert.match(html, /function countsText\(counts, cards, search\)/);
	assert.match(html, /return cards\.filter\(function\(c\)\{ return c\.col === k; \}\)\.length \+ "\/" \+ total;/);
});

// --- #49 欠陥2: caret の視認性（10px/var(--muted) では見えなかった） ---
check("caret は 13px 以上で濃い色（opacity を使わない）", () => {
	const m = html.match(/\.sess \.caret\{([^}]*)\}/);
	assert.ok(m, ".sess .caret の CSS が無い");
	const css = m[1];
	const fs = css.match(/font-size:(\d+)px/);
	assert.ok(fs, "caret の font-size が px 指定でない");
	assert.ok(Number(fs[1]) >= 13, `caret の font-size が小さい: ${fs[1]}px`);
	assert.ok(!/opacity/.test(css), "caret に opacity を使っている");
	assert.match(css, /color:var\(--text\)/, "caret の色が本文色でない");
	assert.match(css, /width:1em/, "caret の幅が固定でない（▾/▸ で名前がずれる）");
	assert.match(css, /text-align:center/);
	assert.match(css, /margin-right:4px/);
	assert.match(css, /flex:none/);
});

// --- 3. ブラウザ側 JS を vm で走らせて挙動を確認 -----------------------------
{
	const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
	const apiScript = scripts.find((s) => s.includes('var API = "/api/dashboard"'));
	check("dashboard のポーリング JS を抽出できる", () => assert.ok(apiScript));

	const makeEl = () => {
		const e = {
			children: [],
			hidden: false,
			className: "",
			innerHTML: "",
			textContent: "",
			value: "",
			title: "",
			tagName: "DIV",
			href: "",
			target: "",
			rel: "",
			style: {},
			dataset: {},
			focused: false,
			_lis: {},
			_attrs: {},
			// innerHTML = "" は実際の DOM 同様に子を捨てる（再描画を数えるため）
			get innerHTML() {
				return e._html || "";
			},
			set innerHTML(v) {
				e._html = String(v);
				e.children.length = 0;
			},
			appendChild(c) {
				e.children.push(c);
				return c;
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
			focus() {
				e.focused = true;
				document.activeElement = e;
			},
			blur() {
				e.focused = false;
				if (document.activeElement === e) document.activeElement = null;
			},
			classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
		};
		return e;
	};
	const byId = {};
	const document = {
		activeElement: null,
		getElementById: (id) => byId[id] || (byId[id] = makeEl()),
		createElement: () => makeEl(),
		documentElement: makeEl(),
		_lis: {},
		addEventListener(t, fn) {
			(document._lis[t] = document._lis[t] || []).push(fn);
		},
	};
	// 木を浅く走査するヘルパ（stub は DOM そのものではない）
	const walk = (node, fn) => {
		if (!node) return;
		fn(node);
		(node.children || []).forEach((c) => walk(c, fn));
	};
	const findAll = (root, pred) => {
		const out = [];
		walk(root, (n) => {
			if (pred(n)) out.push(n);
		});
		return out;
	};
	const byClass = (cls) => (n) => String(n.className).split(/\s+/).includes(cls);
	// #17: session 行は無くなった。既定で開いているのは project ボード。
	const cards = () => findAll(byId["project"], byClass("card")).length;
	const bodies = () => findAll(byId["project"], byClass("cols")).length;
	const empties = () => findAll(byId["project"], byClass("sess-empty"));
	const payload = {
		host: "test-host",
		now: "2026-01-01T00:00:00.000Z",
		stats: { todo: 2, doing: 0, done: 0, serve: 0, media: 0 },
		global: { counts: { todo: 0, doing: 0, done: 0 }, cards: [] },
		project: {
			id: "alpha",
			modes: {},
			loops: 0,
			halted: false,
			counts: { todo: 2, doing: 0, done: 0 },
			cards: [
				{ id: 1, col: "todo", text: "alpha task" },
				{ id: 2, col: "todo", text: "beta task" },
			],
		},
		serve: [],
	};
	const timers = [];
	let nextId = 1;
	const sandbox = {
		document,
		window: {},
		URL,
		localStorage: { getItem: () => null, setItem() {} },
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
	for (let i = 0; i < 4; i++) await flush();

	check("既定は全開: project 本体（3列）が出ている", () => {
		assert.equal(bodies(), 1, "本体が描画されていない");
		assert.equal(cards(), 2);
		assert.equal(empties().length, 0, "該当なしが出ている");
	});

	// ポーリングしても消えない（sig がずれていない）
	const polled = timers.shift();
	if (polled) polled.fn();
	for (let i = 0; i < 4; i++) await flush();
	check("ポーリング後も project ボードが描かれたまま", () => {
		assert.equal(bodies(), 1);
		assert.equal(cards(), 2);
	});

	const qEl = byId["q"];
	check("検索欄に input リスナがある", () => assert.ok(qEl._lis.input && qEl._lis.input.length));
	qEl.value = "ALP";
	qEl._lis.input[0]();
	check("検索で project のカードが絞られる", () => {
		assert.equal(bodies(), 1);
		assert.equal(cards(), 1, "絞り込めていない");
	});

	qEl.value = "zzz";
	qEl._lis.input[0]();
	check("ヒット0件でもボードは残し、該当なしを出す", () => {
		assert.equal(empties().length, 1, "該当なしが無い");
		assert.equal(empties()[0].textContent, "該当なし");
		assert.equal(cards(), 0);
	});

	// Esc でクリア
	const esc = document._lis.keydown[0];
	document.activeElement = qEl;
	esc({ key: "Escape", target: qEl, preventDefault() {} });
	check("Esc は検索語をクリアする", () => {
		assert.equal(qEl.value, "");
		assert.equal(qEl.focused, false, "blur していない");
	});
	check("クリア後は全件戻る", () => {
		assert.equal(bodies(), 1);
		assert.equal(cards(), 2);
		assert.equal(empties().length, 0);
	});

	// "/" で検索欄へフォーカス（入力中は横取りしない）
	esc({ key: "/", target: { tagName: "DIV" }, preventDefault() {} });
	check("\"/\" で検索欄にフォーカスする", () => assert.equal(qEl.focused, true));
	qEl.blur();
	esc({ key: "/", target: { tagName: "INPUT" }, preventDefault() {} });
	check("入力中の \"/\" は横取りしない", () => assert.equal(qEl.focused, false));
}

// --- #49 vm: aria-expanded / keydown トグル / GLOBAL の検索絞り込み -----------
{
	const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
	const apiScript = scripts.find((s) => s.includes('var API = "/api/dashboard"'));
	const makeEl = () => {
		const e = {
			children: [],
			hidden: false,
			className: "",
			textContent: "",
			value: "",
			title: "",
			tagName: "DIV",
			href: "",
			target: "",
			rel: "",
			style: {},
			dataset: {},
			focused: false,
			_lis: {},
			_attrs: {},
			get innerHTML() {
				return e._html || "";
			},
			set innerHTML(v) {
				e._html = String(v);
				e.children.length = 0;
			},
			appendChild(c) {
				e.children.push(c);
				return c;
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
			focus() {
				e.focused = true;
				document.activeElement = e;
			},
			blur() {
				e.focused = false;
				if (document.activeElement === e) document.activeElement = null;
			},
			classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
		};
		return e;
	};
	const byId = {};
	const document = {
		activeElement: null,
		getElementById: (id) => byId[id] || (byId[id] = makeEl()),
		createElement: () => makeEl(),
		documentElement: makeEl(),
		_lis: {},
		addEventListener(t, fn) {
			(document._lis[t] = document._lis[t] || []).push(fn);
		},
	};
	const findAll = (root, pred) => {
		const out = [];
		const walk = (n) => {
			if (!n) return;
			if (pred(n)) out.push(n);
			(n.children || []).forEach(walk);
		};
		walk(root);
		return out;
	};
	const byClass = (cls) => (n) => String(n.className).split(/\s+/).includes(cls);
	const gcards = () => findAll(byId["global"], byClass("card")).length;
	const gempty = () => findAll(byId["global"], byClass("sess-empty"));
	const ghead = () => findAll(byId["global"], byClass("sess-hd"))[0];
	const gheadText = () => (ghead() ? ghead().children.map((n) => n.textContent).join("") : "");
	// GLOBAL には「りんご」を含まないカードだけを渡す（実ブラウザ検証と同じ条件）
	const globalCards = [
		{ id: 1, col: "todo", text: "GLOBAL: 看板の配色を見直す" },
		{ id: 2, col: "doing", text: "GLOBAL: 検索のショートカット実装" },
		{ id: 3, col: "done", text: "GLOBAL: パッケージ化" },
	];
	const payload = {
		host: "test-host",
		now: "2026-01-01T00:00:00.000Z",
		stats: { todo: 1, doing: 0, done: 0, serve: 0, media: 0 },
		global: { counts: { todo: 1, doing: 1, done: 1 }, cards: globalCards, modes: {}, loops: 0, halted: false },
		project: {
			id: "alpha",
			modes: {},
			loops: 0,
			halted: false,
			counts: { todo: 1, doing: 0, done: 0 },
			cards: [{ id: 9, col: "todo", text: "りんごを買う" }],
		},
		serve: [],
	};
	const timers = [];
	let nextId = 1;
	const sandbox = {
		document,
		window: {},
		URL,
		localStorage: { getItem: () => null, setItem() {} },
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
	for (let i = 0; i < 4; i++) await flush();

	const projCards = () => findAll(byId["project"], byClass("card")).length;
	const pEmpty = () => findAll(byId["project"], byClass("sess-empty"));
	const pollNow = async () => {
		const poll = timers.shift();
		if (poll) poll.fn();
		for (let i = 0; i < 4; i++) await flush();
	};

	check("vm: 検索前は project ボードのカードが全部出る", () => assert.equal(projCards(), 1));

	// 検索「りんご」: project ボードは 1 件ヒット
	const qEl2 = byId["q"];
	qEl2.value = "りんご";
	qEl2._lis.input[0]();
	check("vm: 検索で project ボードが絞られる", () => assert.equal(projCards(), 1));

	// ヒットしないカードだけに差し替えると 0 件 + 該当なし
	payload.project.cards = [{ id: 5, col: "todo", text: "パッケージ化" }];
	await pollNow();
	check("vm: 0 件のときは「該当なし」を出す", () => {
		assert.equal(projCards(), 0, "絞り込みが効いていない");
		assert.equal(pEmpty().length, 1, "該当なしが無い");
		assert.equal(pEmpty()[0].textContent, "該当なし");
	});

	// 検索語を消せば全部戻る
	qEl2.value = "";
	qEl2._lis.input[0]();
	await pollNow();
	check("vm: 検索語を消すと全部戻る", () => {
		assert.equal(projCards(), 1);
		assert.equal(pEmpty().length, 0, "該当なしが残っている");
	});
}

for (const f of failures) console.error("FAIL", f);
console.log(`kanban-dashboard-collapse-search: ${passed} passed, ${failures.length} failed`);
// サーバを掴んだままにしない（プロセスを終了させる）
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
