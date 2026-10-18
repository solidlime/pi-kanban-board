// #48 ダッシュボードのセッション折りたたみ + カード検索の自己検証 (#011)。
// フレームワーク無しで `node tests/kanban-dashboard-collapse-search.test.mjs`。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import vm from "node:vm";

const HOME_DIR = "/tmp/kb-dashboard-collapse-search-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
mkdirSync(`${HOME_DIR}/workspace`, { recursive: true });
process.env.HOME = HOME_DIR;
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
	"/root/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.cjs",
);
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(new URL("../extensions/kanban.ts", import.meta.url).pathname);

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
		if ((await fetch(`${BASE}/`)).ok) break;
	} catch {
		// まだ listen していない
	}
	await new Promise((r) => setTimeout(r, 100));
}

// --- 1. 実サーバ: GET / が 200 で新コードを含む ------------------------------
const res = await fetch(`${BASE}/`);
const html = await res.text();
check("GET / は 200", () => assert.equal(res.status, 200));

// --- 2. 文字列レベル ---------------------------------------------------------
check("折りたたみの状態変数とマーカーがある", () => {
	assert.ok(html.includes("var sessOpen = {}"), "sessOpen が無い");
	assert.ok(html.includes('"caret"'), "caret が無い");
	assert.ok(html.includes('"\\u25BE"'), "開マーカー（\\u25BE）が無い");
	assert.ok(html.includes('"\\u25B8"'), "閉マーカー（\\u25B8）が無い");
	assert.ok(html.includes(".sess-hd{cursor:pointer}"), "ヘッダがクリック可能に見えない");
	assert.ok(html.includes('hd.title = "クリックで折りたたみ"'), "title が無い");
	assert.match(html, /hd\.addEventListener\("click"/);
	assert.match(html, /closest\("\.ops"\)/, "ヘッダ内操作の除外が無い");
});

check("既定は全開（undefined なら true）", () => {
	assert.ok(
		html.includes("sessOpen[s.id] === undefined ? true : sessOpen[s.id]"),
		"既定全開の判定が無い",
	);
});

check("検索中は強制展開（query !== \"\"）", () => {
	assert.match(html, /var search = query !== ""/);
	assert.match(html, /var expanded = \(sessOpen\[s\.id\] === undefined \? true : sessOpen\[s\.id\]\) \|\| search;/);
});

check("検索欄は SESSIONS ヘッダの直後、#sessions の手前", () => {
	assert.ok(html.includes('id="q" class="q" type="search"'), "検索 input が無い");
	assert.ok(html.includes('placeholder="検索（/ でフォーカス, Esc でクリア）"'));
	assert.ok(html.includes('autocomplete="off"'));
	const pane = html.slice(html.indexOf('id="h-sessions"'), html.indexOf('id="pane-serve"'));
	assert.ok(pane.indexOf('id="q"') >= 0);
	assert.ok(pane.indexOf('id="q"') < pane.indexOf('id="sessions"'));
	assert.ok(html.includes(".q{width:100%;max-width:320px"), "CSS が無い");
});

check("カードのフィルタとキーボード操作がある", () => {
	assert.match(html, /String\(c\.text \|\| ""\)\.toLowerCase\(\)\.indexOf\(query\)/);
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
	const cards = () => findAll(byId["sessions"], byClass("card")).length;
	const bodies = () => findAll(byId["sessions"], byClass("cols")).length;
	const carets = () => findAll(byId["sessions"], byClass("caret")).map((n) => n.textContent);
	const heads = () => findAll(byId["sessions"], byClass("sess-hd"));
	const meta = () => findAll(byId["sessions"], byClass("sess-meta"))[0];
	const payload = (sess) => ({
		host: "test-host",
		now: "2026-01-01T00:00:00.000Z",
		stats: { sessions: sess.length, active: 1, todo: 2, doing: 0, done: 0, serve: 0, media: 0 },
		global: { counts: { todo: 0, doing: 0, done: 0 }, cards: [] },
		sessions: sess,
		serve: [],
	});
	const session = {
		id: "s1",
		name: "kotomi",
		cwd: "/tmp",
		isActive: true,
		updatedAt: "2026-01-01T00:00:00.000Z",
		modes: { session: {}, global: {} },
		counts: { todo: 2, doing: 0, done: 0 },
		cards: [
			{ id: 1, col: "todo", text: "alpha task" },
			{ id: 2, col: "todo", text: "beta task" },
		],
	};
	const timers = [];
	let nextId = 1;
	const sandbox = {
		document,
		window: {},
		URL,
		localStorage: { getItem: () => null, setItem() {} },
		matchMedia: () => ({ matches: false, addEventListener() {} }),
		fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload([session])) }),
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

	check("既定は全開: セッション本体（3列）が出ている", () => {
		assert.equal(bodies(), 1, "本体が描画されていない");
		assert.equal(cards(), 2);
		assert.deepEqual(carets(), ["\u25BE"]);
	});
	check("検索していないときの件数は従来どおり（TODO 2）", () => {
		assert.ok(meta().textContent.includes("TODO 2 /"), meta().textContent);
		assert.ok(!meta().textContent.includes("TODO 2/2"), meta().textContent);
	});

	// ヘッダをクリック → 畳む
	const hd = heads()[0];
	check("ヘッダはクリックリスナを持つ", () => assert.ok(hd._lis.click && hd._lis.click.length));
	hd._lis.click[0]({ target: null });
	check("畳むと body を append しない（DOM を作らない）", () => {
		assert.equal(bodies(), 0, "body が残っている");
		assert.equal(cards(), 0);
		assert.deepEqual(carets(), ["\u25B8"], "caret が閉じていない");
	});

	// ヘッダ内の操作は畳まない
	const before = bodies();
	heads()[0]._lis.click[0]({ target: { closest: (sel) => (sel === "button" ? {} : null) } });
	check("ヘッダ内のボタンクリックでは畳まない", () => assert.equal(bodies(), before));

	// 畳んだまま 5 秒ポーリングが来ても畳んだまま（sig がずれない）
	const polled = timers.shift();
	if (polled) polled.fn();
	for (let i = 0; i < 4; i++) await flush();
	check("ポーリング後も畳んだ状態が維持される", () => {
		assert.equal(bodies(), 0, "ポーリングで開き直された");
		assert.deepEqual(carets(), ["\u25B8"]);
	});

	// 検索: 畳んでいても強制展開し、ヒットだけ出す
	const qEl = byId["q"];
	check("検索欄に input リスナがある", () => assert.ok(qEl._lis.input && qEl._lis.input.length));
	qEl.value = "ALP";
	qEl._lis.input[0]();
	check("検索中は畳み状態でも本体を出す（強制展開）", () => {
		assert.equal(bodies(), 1);
		assert.equal(cards(), 1, "絞り込めていない");
	});
	check("検索中は TODO ヒット/総数（#009 の乖離を潰す）", () => {
		assert.ok(meta().textContent.includes("TODO 1/2"), meta().textContent);
	});

	qEl.value = "zzz";
	qEl._lis.input[0]();
	check("ヒット0件でもセッションは残し、該当なしを出す", () => {
		assert.equal(heads().length, 1, "セッションごと消えている");
		assert.equal(findAll(byId["sessions"], byClass("sess-empty")).length, 1, "該当なしが無い");
		assert.equal(
			findAll(byId["sessions"], byClass("sess-empty"))[0].textContent,
			"該当なし",
		);
		assert.equal(bodies(), 0, "該当なしのときは列を出さない");
		assert.equal(cards(), 0);
		assert.ok(meta().textContent.includes("TODO 0/2"), meta().textContent);
	});

	// Esc でクリア
	const esc = document._lis.keydown[0];
	document.activeElement = qEl;
	esc({ key: "Escape", target: qEl, preventDefault() {} });
	check("Esc は検索語をクリアする（畳みはユーザの操作なので維持）", () => {
		assert.equal(qEl.value, "");
		assert.equal(bodies(), 0, "畳みが勝手に開いた");
		assert.equal(qEl.focused, false, "blur していない");
	});
	heads()[0]._lis.click[0]({ target: null });
	check("クリア後に開けば全件戻る", () => {
		assert.equal(bodies(), 1);
		assert.equal(cards(), 2);
		assert.ok(meta().textContent.includes("TODO 2 /"), meta().textContent);
	});

	// "/" で検索欄へフォーカス（入力中は横取りしない）
	esc({ key: "/", target: { tagName: "DIV" }, preventDefault() {} });
	check("\"/\" で検索欄にフォーカスする", () => assert.equal(qEl.focused, true));
	qEl.blur();
	esc({ key: "/", target: { tagName: "INPUT" }, preventDefault() {} });
	check("入力中の \"/\" は横取りしない", () => assert.equal(qEl.focused, false));
}

for (const f of failures) console.error("FAIL", f);
console.log(`kanban-dashboard-collapse-search: ${passed} passed, ${failures.length} failed`);
// サーバを掴んだままにしない（プロセスを終了させる）
process.exit(failures.length === 0 ? 0 : 1);
