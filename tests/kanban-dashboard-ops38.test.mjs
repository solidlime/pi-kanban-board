// #60 ダッシュボード (#38 機能群) の移植漏れの自己検証 (#011)。
// フレームワーク無しで `node tests/kanban-dashboard-ops38.test.mjs`。
// DASHBOARD_HTML が唯一のテンプレート（#84 で右パネルを廃止）。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import vm from "node:vm";
import { authFetch } from "./helpers/token.mjs";

// #83b: HTTP routes need the server token now; tf = fetch + the kb_token cookie.
const tf = (input, init) => authFetch(input, init);

const HOME_DIR = "/tmp/kb-dashboard-ops38-home";
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
// async 版: 同期版だと async な check の失敗が未処理の rejection に消える。
const check = async (name, fn) => {
	try {
		await fn();
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

// --- 1. 実サーバ: GET / はダッシュボードの HTML ---------------------------------
const res = await tf(`${BASE}/`);
const html = await res.text();
const { DASHBOARD_HTML } = mod.__test_exports ?? {};
await check("GET / は 200", () => assert.equal(res.status, 200));
await check("// 0. 前提: 応答はダッシュボード（別テンプレートを掴んでいない）", () => {
	assert.ok(html.includes('var API = "/api/dashboard"'), "dashboard のポーリング JS が無い");
	assert.ok(!html.includes('id="board"'), "別テンプレート（右パネル）を掴んでいる");
});
// 文字列で見るのは CSS だけ（DOM の挙動は下の vm で叩く）
await check("#38-5 CSS: .card .t.clampable が 3 行クランプ", () => {
	assert.ok(
		html.includes(".card .t.clampable:not(.open)"),
		"ダッシュボードのクランプ CSS が無い（.t が対象）",
	);
	assert.match(html, /\.card \.t\.clampable:not\(\.open\)\{[^}]*-webkit-line-clamp:3/);
});
await check("#38-7 CSS: 畳んだ列の中身を落とすルール", () => {
	assert.match(html, /\.col\.collapsed \.card[^{]*\{display:none\}/, "畳みの CSS が無い");
});
await check("#38-10 CSS: 経過用の .since は既存トークンだけを使う", () => {
	assert.match(html, /\.card \.since\{[^}]*color:var\(--muted\)/, ".since が無い");
});

// --- 2. ブラウザ側 JS を vm で走らせて実際に叩く -----------------------------
// makeEl / document / sandbox は kanban-dashboard-collapse-search.test.mjs の型を流用。
{
	const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
	const apiScript = scripts.find((s) => s.includes('var API = "/api/dashboard"'));
	await check("// 0b. dashboard のポーリング JS を抽出できる", () => assert.ok(apiScript));

	const makeEl = (tagName = "DIV") => {
		const e = {
			children: [],
			hidden: false,
			className: "",
			innerHTML: "",
			textContent: "",
			value: "",
			title: "",
			tagName,
			href: "",
			target: "",
			rel: "",
			type: "",
			placeholder: "",
			tabIndex: undefined,
			style: {},
			dataset: {},
			focused: false,
			classes: new Set(),
			_lis: {},
			_attrs: {},
			get classList() {
				return {
					add: (...c) => c.forEach((x) => e.classes.add(x)),
					remove: (...c) => c.forEach((x) => e.classes.delete(x)),
					toggle: (c) => (e.classes.has(c) ? (e.classes.delete(c), false) : (e.classes.add(c), true)),
					contains: (c) => e.classes.has(c),
				};
			},
			get innerHTML() {
				return e._html || "";
			},
			set innerHTML(v) {
				e._html = String(v);
				e.children.length = 0;
			},
			appendChild(c) {
				e.children.push(c);
				c.parentNode = e;
				return c;
			},
			removeChild(c) {
				const i = e.children.indexOf(c);
				if (i >= 0) e.children.splice(i, 1);
				return c;
			},
			replaceChild(n, o) {
				const i = e.children.indexOf(o);
				if (i >= 0) e.children[i] = n;
				n.parentNode = e;
				return o;
			},
			setAttribute(k, v) {
				e._attrs[k] = String(v);
			},
			getAttribute(k) {
				return k in e._attrs ? e._attrs[k] : null;
			},
			querySelector(sel) {
				const cls = sel.replace(/^\./, "");
				const walk = (n) => {
					for (const c of n.children) {
						if (String(c.className).split(/\s+/).includes(cls)) return c;
						const hit = walk(c);
						if (hit) return hit;
					}
					return null;
				};
				return walk(e);
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
		};
		return e;
	};
	const byId = {};
	const document = {
		activeElement: null,
		getElementById: (id) => byId[id] || (byId[id] = makeEl()),
		createElement: (tag) => makeEl(String(tag || "div").toUpperCase()),
		documentElement: makeEl(),
		querySelectorAll: () => [],
		_lis: {},
		addEventListener(t, fn) {
			(document._lis[t] = document._lis[t] || []).push(fn);
		},
	};
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
	const hasCls = (n, cls) => String(n.className).split(/\s+/).includes(cls);
	const byClass = (cls) => (n) => hasCls(n, cls);
	const texts = (root, cls) => findAll(root, byClass(cls)).map((n) => n.textContent);

	// #38-10/#38-11: DOING に movedAt 付きのカードを必ず置く（空ボードで緑にしない）。
	const H = 60 * 60 * 1000;
	const nowIso = "2026-01-01T12:00:00.000Z";
	const NOW = new Date(nowIso).getTime();
	const LONG_TEXT = "あ".repeat(61); // 60 字超 → クランプ対象
	const session = {
		id: "s1",
		name: "kotomi",
		cwd: "/tmp",
		isActive: true,
		updatedAt: nowIso,
		modes: { session: {}, global: {} },
		counts: { todo: 1, doing: 3, done: 0 },
		cards: [
			{ id: 1, col: "todo", text: LONG_TEXT },
			// 本文に「分前から」を入れない: 入れると #38-10 の判定が本文に当たって
			// 実装を消しても緑になる（mutation check で実際に踏んだ）。
			{ id: 2, col: "doing", text: "3時間め", movedAt: NOW - 3 * H },
			{ id: 3, col: "doing", text: "2.5時間め", movedAt: NOW - 2.5 * H },
			{ id: 4, col: "doing", text: "10分め", movedAt: NOW - 10 * 60 * 1000 },
		],
	};
	const payload = {
		host: "test-host",
		now: nowIso,
		stats: { sessions: 1, active: 1, todo: 1, doing: 3, done: 0, serve: 0, media: 0 },
		global: { counts: { todo: 0, doing: 0, done: 0 }, cards: [] },
		sessions: [session],
		serve: [],
	};
	const timers = [];
	let nextId = 1;
	const urls = [];
	const sandbox = {
		document,
		window: { confirm: () => true, matchMedia: () => ({ matches: false, addEventListener() {} }) },
		URL,
		localStorage: { getItem: () => null, setItem() {} },
		matchMedia: () => ({ matches: false, addEventListener() {} }),
		fetch: (u) => {
			urls.push(String(u));
			return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
		},
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
		JSON,
		Math,
		Date,
		encodeURIComponent,
	};
	vm.createContext(sandbox);
	vm.runInContext(apiScript, sandbox);
	for (let i = 0; i < 8; i++) await flush();

	const sess = () => byId["sessions"];
	const cols = () => findAll(sess(), byClass("col"));
	const colOf = (key) => cols().find((c) => c.getAttribute("data-col") === key);
	const cardsOf = (key) => findAll(colOf(key), byClass("card"));
	// カードの本文 span（#dash は span.t > span.body）
	const tOf = (cardEl) => findAll(cardEl, byClass("t"))[0];
	const bodyOf = (cardEl) => tOf(cardEl);
	const addBtnOf = (colEl) => findAll(colEl, byClass("addbtn"))[0];
	const addInOf = (colEl) => findAll(colEl, byClass("addin"))[0];

	await check("// 1. 前提: セッション看板が 3 列・カード 4 枚で描画された", () => {
		assert.equal(cols().length, 3, `cols=${cols().length}`);
		assert.equal(findAll(sess(), byClass("card")).length, 4);
	});

	// .t は本文そのもの（span.body ではない）。経過と ⏳ は .t の中に前置される。
	const tHtml = (col, id) => {
		const c = cardsOf(col).find((x) => findAll(x, byClass("id")).some((i) => i.textContent === "#" + id));
		assert.ok(c, `#${id} のカードが無い`);
		return tOf(c).innerHTML;
	};
	await check("#38-10 DOING のカードに「N分前から」が出る（3時間前 = 180分）", () => {
		assert.match(tHtml("doing", 2), /180分前から/, "3時間前が出ていない");
		assert.match(tHtml("doing", 3), /150分前から/, "2.5時間前が出ていない");
		assert.match(tHtml("doing", 4), /10分前から/, "10分前が出ていない");
	});
	await check("#38-10 TODO のカードには経過を出さない", () => {
		const h = tHtml("todo", 1);
		assert.ok(!h.includes("分前から"), `TODO に経過が出ている: ${h}`);
	});
	await check("#38-11 2時間超の DOING にだけ ⏳ が付く", () => {
		assert.match(tHtml("doing", 2), /class="stale"/, "3時間前に ⏳ が無い");
		assert.match(tHtml("doing", 3), /class="stale"/, "2.5時間前に ⏳ が無い");
		assert.ok(!tHtml("doing", 4).includes("stale"), "10分前のカードに ⏳ が付いている");
		assert.ok(!tHtml("todo", 1).includes("stale"), "TODO に ⏳ が付いている");
		assert.match(tHtml("doing", 2), /\u23f3/);
		assert.match(tHtml("doing", 2), /title="180分前から DOING"/);
	});
	await check("#38-11 ⏳ は表示だけ（カードを消さない）", () => {
		assert.equal(cardsOf("doing").length, 3, "stale カードが消えている");
	});

	// --- #38-3: + ボタン → その場で input → Enter で add -----------------------
	await check("#38-3 + で入力欄が出る（input の数は増えず、その列の input が開く）", () => {
		const col = colOf("todo");
		const btn = addBtnOf(col);
		assert.ok(btn, "+ ボタンが無い");
		const inp = addInOf(col);
		assert.ok(inp, "input.addin が無い");
		assert.equal(inp.style.display, "none", "初期状態で入力欄が開いている");
		const before = findAll(sess(), byClass("addin")).length;
		btn._lis.click[0]();
		assert.equal(findAll(sess(), byClass("addin")).length, before, "input が増えた");
		assert.equal(inp.style.display, "", "+ を押しても入力欄が出ない");
		assert.equal(btn.style.display, "none", "+ が引っ込まない");
		assert.equal(inp.focused, true, "入力欄にフォーカスしていない");
	});
	await check("#38-3 Enter で /api/add、Escape で閉じる", async () => {
		const col = colOf("todo");
		const inp = addInOf(col);
		urls.length = 0;
		inp.value = "  ダッシュボード追加  ";
		inp._lis.keydown[0]({ key: "Enter", preventDefault() {} });
		for (let i = 0; i < 4; i++) await flush();
		const hit = urls.find((u) => u.includes("/api/add"));
		assert.ok(hit, `add が飛んでいない: ${JSON.stringify(urls)}`);
		assert.ok(hit.includes("col=todo"), hit);
		assert.ok(hit.includes("scope=session"), hit);
		assert.ok(hit.includes("sid=s1"), hit);
		assert.equal(inp.style.display, "none", "Enter 後に入力欄が閉じない");
		for (let i = 0; i < 10; i++) await flush();
		// Escape
		timers.shift()?.fn(); // ポーリング 1 回（値の取り違えを避けるため状態は開き直す）
		for (let i = 0; i < 4; i++) await flush();
		const col2 = colOf("todo");
		addBtnOf(col2)._lis.click[0]();
		const inp2 = addInOf(col2);
		assert.equal(inp2.style.display, "", "再度 + で開かない");
		urls.length = 0;
		inp2.value = "やめる";
		inp2._lis.keydown[0]({ key: "Escape", preventDefault() {} });
		for (let i = 0; i < 4; i++) await flush();
		assert.equal(inp2.style.display, "none", "Escape で閉じない");
		assert.ok(!urls.some((u) => u.includes("/api/add")), `Escape で送った: ${JSON.stringify(urls)}`);
	});
	await check("#38-3 blur でも閉じる", async () => {
		for (let i = 0; i < 20; i++) await flush();
		const col = colOf("todo");
		addBtnOf(col)._lis.click[0]();
		const inp = addInOf(col);
		assert.equal(inp.style.display, "");
		inp._lis.blur[0]();
		assert.equal(inp.style.display, "none", "blur で閉じない");
	});

	// --- #38-5: 60 字超は 3 行クランプ + クリックで開閉 ------------------------
	await check("#38-5 60字超の本文に clampable が付き、クリックで open がトグルする", () => {
		const longCard = cardsOf("todo").find((c) => {
			const b = bodyOf(c);
			return b && b.innerHTML.includes("あああ");
		});
		assert.ok(longCard, "対象カードが無い");
		const t = tOf(longCard);
		assert.ok(t, "span.t が無い（span.body ではない）");
		assert.ok(t.classes.has("clampable"), `clampable が付いていない: ${[...t.classes]}`);
		assert.ok(t._lis.click && t._lis.click.length, "クリックのリスナが無い");
		assert.equal(t.classes.has("open"), false);
		t._lis.click[0]({});
		assert.ok(t.classes.has("open"), "クリックしても開かない");
		t._lis.click[0]({});
		assert.equal(t.classes.has("open"), false, "再クリックで閉じない");
	});
	await check("#38-5 60字以下はクランプしない", () => {
		const short = cardsOf("doing")[0];
		assert.ok(!tOf(short).classes.has("clampable"), "短いカードまでクランプしている");
	});

	// --- #38-6: Tab でカードに入り ←→ / Enter / m ------------------------------
	await check("#38-6 カードは tabIndex 0", () => {
		for (const c of findAll(sess(), byClass("card"))) {
			assert.equal(c.tabIndex, 0, `tabIndex=${c.tabIndex}`);
		}
	});
	await check("#38-6 ArrowLeft/ArrowRight で隣の列へ move", async () => {
		const doingCard = cardsOf("doing")[0];
		urls.length = 0;
		doingCard._lis.keydown[0]({ key: "ArrowLeft", target: doingCard, preventDefault() {} });
		for (let i = 0; i < 4; i++) await flush();
		assert.ok(
			urls.some((u) => u.includes("/api/move") && u.includes("col=todo")),
			`左へ移動していない: ${JSON.stringify(urls)}`,
		);
		timers.shift()?.fn();
		for (let i = 0; i < 4; i++) await flush();
		const todoCard = cardsOf("todo")[0];
		urls.length = 0;
		todoCard._lis.keydown[0]({ key: "ArrowRight", target: todoCard, preventDefault() {} });
		for (let i = 0; i < 4; i++) await flush();
		assert.ok(
			urls.some((u) => u.includes("/api/move") && u.includes("col=doing")),
			`右へ移動していない: ${JSON.stringify(urls)}`,
		);
	});
	await check("#38-6 Enter で DOING", async () => {
		timers.shift()?.fn();
		for (let i = 0; i < 4; i++) await flush();
		const todoCard = cardsOf("todo")[0];
		urls.length = 0;
		todoCard._lis.keydown[0]({ key: "Enter", target: todoCard, preventDefault() {} });
		for (let i = 0; i < 4; i++) await flush();
		assert.ok(
			urls.some((u) => u.includes("/api/move") && u.includes("col=doing")),
			`Enter で DOING にならない: ${JSON.stringify(urls)}`,
		);
	});
	await check("#38-6 m でメモ編集（textarea.ted が .t と入れ替わる）", () => {
		timers.shift()?.fn();
		const cardEl = cardsOf("todo")[0];
		const t = tOf(cardEl);
		cardEl._lis.keydown[0]({ key: "m", target: cardEl, preventDefault() {} });
		const ted = findAll(cardEl, byClass("ted"))[0];
		assert.ok(ted, "メモ編集の textarea が出ない");
		assert.equal(ted.value, "あ".repeat(61), "生テキストが入っていない");
		assert.ok(!cardEl.children.includes(t), ".t が残っている");
	});
	await check("#38-6 e.target !== card のガード（入力欄のキーを奪わない）", async () => {
		const cardEl = cardsOf("todo")[0];
		urls.length = 0;
		cardEl._lis.keydown[0]({
			key: "Enter",
			target: { closest: () => ({}) },
			preventDefault() {},
		});
		for (let i = 0; i < 4; i++) await flush();
		assert.ok(!urls.some((u) => u.includes("/api/move")), `子要素のキーで move した: ${JSON.stringify(urls)}`);
	});

	// --- #38-7: 見出しクリックで列を畳む ---------------------------------------
	await check("#38-7 見出しクリックで .collapsed が付き、再クリックで戻る", () => {
		timers.shift()?.fn();
		const col = colOf("done");
		const h = findAll(col, (n) => n.tagName === "H3")[0];
		assert.ok(h, "列見出しが無い");
		assert.ok(h._lis.click && h._lis.click.length, "見出しにクリックリスナが無い");
		assert.ok(!col.classes.has("collapsed"));
		h._lis.click[0]({});
		assert.ok(col.classes.has("collapsed"), "クリックしても畳まない");
		h._lis.click[0]({});
		assert.ok(!col.classes.has("collapsed"), "再クリックで戻らない");
	});

	// --- #38-10 / #38-11: DOING の経過と ⏳ -----------------------------------
}

// --- 3. 結果 -----------------------------------------------------------------
if (failures.length) {
	console.error(`\n${failures.length} failed:`);
	for (const f of failures) console.error(`  ✗ ${f}`);
}
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
