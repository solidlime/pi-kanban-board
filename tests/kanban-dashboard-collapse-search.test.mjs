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
check("折りたたみの状態変数とマーカーがある（#17: 開閉するのは GLOBAL 行だけ）", () => {
	assert.ok(html.includes("var gOpen = true"), "gOpen が無い");
	assert.ok(html.includes('"caret"'), "caret が無い");
	assert.ok(html.includes('"\u25BE"'), "開マーカー（▾）が無い");
	assert.ok(html.includes('"\u25B8"'), "閉マーカー（▸）が無い");
	assert.ok(
		html.includes('.sess-hd[role="button"]{cursor:pointer'),
		"ヘッダがクリック可能に見えない",
	);
	assert.ok(html.includes('head.title = "クリックで折りたたみ"'), "title が無い");
	assert.match(html, /head\.addEventListener\("click", toggleGlobal\)/);
	assert.match(html, /closest\("\.ops"\)/, "ヘッダ内操作の除外が無い");
});

check("既定は全開（gOpen の既定 true）", () => {
	assert.ok(html.includes("var gOpen = true"), "既定全開の判定が無い");
});

check("検索中は強制展開（query !== \"\"）", () => {
	assert.match(html, /var search = query !== ""/);
	assert.match(html, /var gexpanded = gOpen \|\| filtered;/);
});

check("検索欄は絞り込みバーの中、#project の手前", () => {
	assert.ok(html.includes('id="q" class="q" type="search"'), "検索 input が無い");
	assert.ok(html.includes('placeholder="検索: 本文・#番号・project・commit（/ でフォーカス, Esc でクリア）"'));
	assert.ok(html.includes('autocomplete="off"'));
	// #17: session 行が消えたので検索欄は絞り込みバー（#filters）へ移った。
	const pane = html.slice(html.indexOf('id="filters"'), html.indexOf('id="h-project"'));
	assert.ok(pane.indexOf('id="q"') >= 0, "検索欄が絞り込みバーの外にある");
	assert.ok(html.indexOf('id="q"') < html.indexOf('id="project"'));
	assert.ok(html.includes(".q{width:100%;max-width:320px"), "CSS が無い");
});

check("カードのフィルタとキーボード操作がある", () => {
	// #21: 検索の述語は cardHit() に集約した（2 箇所から呼ぶ）。
	assert.equal((html.match(/cardHit\(x, query\)/g) || []).length, 2, "cardHit(x, query) が 2 箇所に無い");
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

// --- #49 欠陥1: GLOBAL も検索で絞る（renderGlobal が query を見ていなかった） ---
check("renderGlobal が query を見てカードを絞る", () => {
	const at = html.indexOf("function renderGlobal(");
	assert.ok(at >= 0, "renderGlobal が無い");
	// センチネル未検査だと slice(at, -1) が末尾 1 文字を落とすだけで静かに全文へ広がる。
	const bodyEnd = html.indexOf("function serveLeft(", at);
	assert.ok(bodyEnd > at, "serveLeft のセンチネルが無い");
	const body = html.slice(at, bodyEnd);
	assert.match(body, /var search = query !== ""/, "renderGlobal に search 判定が無い");
	assert.match(body, /cardHit\(x, query\)/, "renderGlobal に query フィルタが無い");
	assert.match(body, /countsText\(c, cards, filtered\)/, "GLOBAL の件数が検索中 n/m にならない");
	assert.match(body, /el\("div", "sess-empty", "該当なし"\)/, "GLOBAL の該当なしが無い");
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

check("ヘッダは hover で背景が付き、テキスト選択されない（#62 で GLOBAL も対象）", () => {
	const SEL = '.sess-hd[role="button"]';
	const rule = (suffix) => {
		const at = html.indexOf(SEL + suffix + "{");
		return at < 0 ? null : html.slice(html.indexOf("{", at) + 1, html.indexOf("}", at));
	};
	const base = rule("");
	assert.ok(base, "interactive な .sess-hd の CSS が無い");
	assert.match(base, /user-select:none/, "user-select:none が無い");
	assert.match(base, /border-radius:6px/, "border-radius が .sess と揃っていない");
	assert.match(base, /cursor:pointer/);
	const hover = rule(":hover");
	assert.ok(hover, ".sess-hd[role=button]:hover が無い");
	assert.match(hover, /background:var\(--/, "hover の背景が既存トークンでない");
	// #62 で GLOBAL も押せるようになったため反転: GLOBAL のヘッダにも hover 背景を付ける。
	// （「押せないのに押せそうに見せない」という元の意図は、押せるようにする側で解消した）
	assert.ok(html.includes(".sess-hd:hover") || hover, "GLOBAL のヘッダに hover が付いていない");
	// 反転の本体: GLOBAL ヘッダが実際に操作可能なボタンになっている（旧: role が付かない前提）
	assert.match(html, /head\.setAttribute\("role", "button"\)/);
	assert.match(html, /head\.setAttribute\("aria-expanded", gexpanded \? "true" : "false"\)/);
});

check("ヘッダは a11y 的にもボタン（aria-expanded / role / tabindex）", () => {
	assert.match(html, /head\.setAttribute\("role", "button"\)/);
	assert.match(html, /head\.setAttribute\("tabindex", "0"\)/);
	assert.match(html, /head\.setAttribute\("aria-expanded", gexpanded \? "true" : "false"\)/);
	assert.match(html, /head\.addEventListener\("keydown"/);
	assert.match(html, /k !== "Enter" && k !== " "/);
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

	// #17: role=button で開閉するヘッダは GLOBAL 行にだけある。
	const ghd = () => findAll(byId["global"], byClass("sess-hd"))[0];
	const projCards = () => findAll(byId["project"], byClass("card")).length;

	check("vm: セッションヘッダは role=button / tabindex=0 / aria-expanded=true", () => {
		const h = ghd();
		assert.equal(h.getAttribute("role"), "button");
		assert.equal(h.getAttribute("tabindex"), "0");
		assert.equal(h.getAttribute("aria-expanded"), "true");
	});

	// Enter で畳む（click と同じ経路）
	const h0 = ghd();
	check("vm: ヘッダは keydown リスナを持つ", () => assert.ok(h0._lis.keydown && h0._lis.keydown.length));
	const key = (k) => {
		const h = ghd();
		assert.ok(h._lis.keydown && h._lis.keydown[0], "keydown リスナが無い");
		h._lis.keydown[0]({ key: k, target: null, preventDefault() {} });
	};
	check("vm: Enter で畳める（aria-expanded=false）", () => {
		key("Enter");
		assert.equal(ghd().getAttribute("aria-expanded"), "false");
		assert.equal(findAll(byId["global"], byClass("cols")).length, 0, "畳めていない");
	});
	// Space で開く
	check("vm: Space で開ける（aria-expanded=true）", () => {
		key(" ");
		assert.equal(ghd().getAttribute("aria-expanded"), "true");
		assert.equal(findAll(byId["global"], byClass("cols")).length, 1, "開けていない");
	});
	// 矢印キーでは畳まない（誤爆防止）
	check("vm: Enter/Space 以外では畳まない", () => {
		key("ArrowDown");
		assert.equal(ghd().getAttribute("aria-expanded"), "true");
	});

	// 検索前は GLOBAL に 3 枚
	check("vm: 検索前の GLOBAL は 3 枚", () => assert.equal(gcards(), 3, "GLOBAL のカード数が違う"));
	check("vm: 検索前の GLOBAL 件数は従来の形（計 3 枚）", () => {
		assert.ok(gheadText().includes("TODO 1 / DOING 1 / DONE 1 ・ 計 3 枚"), gheadText());
	});

	// 検索「りんご」: GLOBAL は 0 件（ヘッダは残す）、SESSION 側は 1 件
	const qEl2 = byId["q"];
	qEl2.value = "りんご";
	qEl2._lis.input[0]();
	check("vm: GLOBAL も検索で絞られる（欠陥1の再現条件）", () => {
		assert.equal(gcards(), 0, "GLOBAL が絞られていない");
	});
	check("vm: GLOBAL 0 件のとき該当なしを出す（ヘッダは残す）", () => {
		assert.equal(gempty().length, 1, "GLOBAL の該当なしが無い");
		assert.equal(gempty()[0].textContent, "該当なし");
		assert.ok(ghead(), "GLOBAL のヘッダが消えている");
	});
	check("vm: 検索中の GLOBAL 件数は n/m", () => {
		assert.ok(gheadText().includes("TODO 0/1 / DOING 0/1 / DONE 0/1"), gheadText());
	});
	check("vm: project 側は 1 件ヒット", () => {
		assert.equal(projCards(), 1);
	});

	// ヒットする GLOBAL カードなら 1 枚出る
	payload.global.cards = [
		{ id: 4, col: "todo", text: "りんごの生産計画" },
		{ id: 5, col: "todo", text: "パッケージ化" },
	];
	payload.global.counts = { todo: 2, doing: 0, done: 0 };
	const poll = timers.shift();
	if (poll) poll.fn();
	for (let i = 0; i < 4; i++) await flush();
	check("vm: ヒットする GLOBAL カードは 1 枚だけ出る", () => {
		assert.equal(gcards(), 1, "GLOBAL の絞り込みが効いていない");
		assert.equal(gempty().length, 0, "該当なしが残っている");
		assert.ok(gheadText().includes("TODO 1/2"), gheadText());
	});
}

for (const f of failures) console.error("FAIL", f);
console.log(`kanban-dashboard-collapse-search: ${passed} passed, ${failures.length} failed`);
// サーバを掴んだままにしない（プロセスを終了させる）
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
