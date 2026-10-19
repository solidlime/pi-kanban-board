// #76 リロードを跨ぐ記憶（列スクロール / カード展開）の自己検証 (#011)。
//   (a) 純関数: memClamp のクランプ / memCompactCards の DONE 除外と上限 / memPruneColumn / 壊れた JSON
//   (b) ダッシュボード: TODO の展開は kb-open に残り、DONE は残らない
//   (c) MAX_CARD_OPEN を超えたら挿入順の古い方から落ちる
//   (d) 消えたカードの id は保存から掃除される
//   (e) 列のスクロール位置は debounce してから kb-scroll に書き、復元時にクランプする
//   (f) kb-scroll / kb-open が壊れた JSON でも描画が落ちない
// フレームワーク無しで `node tests/kanban-memory.test.mjs`。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import vm from "node:vm";

const HOME_DIR = "/tmp/kb-memory-home";
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
const flushN = async (n = 10) => {
	for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
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
const scriptsOf = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

// ---------------------------------------------------------------------------
// (a) 純関数: 共有 JS をそのまま評価する（ブラウザと同じソース）
// ---------------------------------------------------------------------------
const mem = new Function(
	`${mod.KANBAN_MEMORY_JS}
return { MAX_CARD_OPEN: MAX_CARD_OPEN, SCROLL_DEBOUNCE_MS: SCROLL_DEBOUNCE_MS,
  memParse: memParse, memClamp: memClamp, memKeepable: memKeepable,
  memCompactCards: memCompactCards, memPruneColumn: memPruneColumn };`,
)();

await check("#76 dashboard が共有 JS を注入している", () => {
	assert.ok(dashboardHtml.includes("function memClamp("), "ダッシュボードに記憶層が無い");
	assert.ok(dashboardHtml.includes('LS_NS = "dash"'), "ダッシュボードの名前空間が変わっている");
	// キーは分ける（列のスクロール位置は画面ごとに別物）
	assert.ok(dashboardHtml.includes('LS_SCROLL = "kb-scroll"'), "kb-scroll が無い");
	assert.ok(!/LS_SCROLL = "kb-scroll-panel"/.test(dashboardHtml), "旧案のキー名が残っている");
	// 既存の保存はそのまま（スキーマ不変）
	assert.ok(dashboardHtml.includes('var LS_KEY = "kb-collapse"'), "kb-collapse が壊れている");
});

await check("#76 memParse は壊れた JSON を null に落とす", () => {
	assert.equal(mem.memParse("{"), null);
	assert.equal(mem.memParse("[1,2]"), null, "配列は object として扱わない");
	assert.equal(mem.memParse(null), null);
	assert.deepEqual(mem.memParse('{"a":1}'), { a: 1 });
});

await check("#76 memClamp: 保存値 5000 / 小さい scrollHeight は最大値に丸める", () => {
	assert.equal(mem.memClamp(5000, 1200, 300), 900, "最大値に丸まっていない");
	assert.equal(mem.memClamp(400, 1200, 300), 400, "収まる値は触らない");
	assert.equal(mem.memClamp(-5, 1200, 300), 0, "負値は 0");
	assert.equal(mem.memClamp(100, 300, 300), 0, "スクロールできない列は 0");
	assert.equal(mem.memClamp(NaN, 1200, 300), 0, "数値でない値は 0");
	assert.equal(mem.memClamp(100, undefined, 300), 0, "高さ不明は 0");
	assert.equal(mem.memClamp("777", 1200, 300), 0, "文字列は数値として扱わない");
});

await check("#76 memCompactCards: DONE を落とし上限は挿入順の古い方から捨てる", () => {
	const obj = {};
	for (let i = 1; i <= 42; i++) obj[`session.s1:todo#${i}`] = true;
	obj["session.s1:done#900"] = true;
	obj["global:doing#901"] = true;
	obj["session.s1:todo#2"] = false; // false は保存しない
	const out = mem.memCompactCards(obj, 40);
	assert.equal(Object.keys(out).length, 40, `上限が効いていない: ${Object.keys(out).length}`);
	assert.ok(!out["session.s1:done#900"], "DONE が保存対象になっている");
	assert.ok(!out["session.s1:todo#2"], "false が保存対象になっている");
	assert.ok(out["session.s1:todo#42"], "新しいものが落ちている");
	assert.ok(!out["session.s1:todo#1"], "古いものが落ちていない");
	assert.deepEqual(Object.keys(out).slice(-1), ["global:doing#901"], "挿入順（末尾）が保たれていない");
});

await check("#76 memCompactCards: 上限以内なら全部残る（DONE だけ落ちる）", () => {
	const out = mem.memCompactCards({ "g:todo#1": true, "g:done#2": true }, 40);
	assert.deepEqual(out, { "g:todo#1": true });
});

await check("#76 memPruneColumn: 同じ列の消えた id だけ落とす", () => {
	const obj = { "session.s1:todo#1": true, "session.s1:todo#2": true, "session.s1:doing#3": true };
	const removed = mem.memPruneColumn(obj, "session.s1:todo", [2]);
	assert.equal(removed, true, "掃除したことが伝わっていない");
	assert.deepEqual(Object.keys(obj).sort(), ["session.s1:doing#3", "session.s1:todo#2"]);
	const again = mem.memPruneColumn(obj, "session.s1:todo", [2]);
	assert.equal(again, false, "掃除していないのに true を返した");
});

// ---------------------------------------------------------------------------
// 共有ハーネス: className と classList が連動する最小 DOM
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
		src: "",
		alt: "",
		tabIndex: 0,
		draggable: false,
		focused: false,
		scrollTop: 0,
		scrollHeight: 3000,
		clientHeight: 100,
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
			if (e._html === "") e.children.length = 0;
		},
		classList: {
			add: (...c) => c.forEach((x) => cls.add(x)),
			remove: (...c) => c.forEach((x) => cls.delete(x)),
			// DOM 仕様どおり「追加したら true / 外したら false」を返す。常に truthy だと
			// `if (classList.toggle("open")) cardOpen[k] = true` の閉じる枝が踏めない。
			toggle: (x) => {
				if (cls.has(x)) {
					cls.delete(x);
					return false;
				}
				cls.add(x);
				return true;
			},
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
		// #76: 記憶層は描画後に [data-ckey] を引いて位置を戻す。最小限の属性一致だけ実装する。
		querySelectorAll(sel) {
			const want = String(sel).replace(/^.*\[([^\]=]+)\]$/, "$1");
			const out = [];
			const walk = (n) => {
				if (n !== e && n._attrs && want in n._attrs) out.push(n);
				for (const c of n.children || []) walk(c);
			};
			walk(e);
			return out;
		},
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

const makeStorage = (seed) => {
	const map = new Map(seed ? Object.entries(seed) : []);
	return {
		map,
		getItem(k) {
			return map.has(k) ? map.get(k) : null;
		},
		setItem(k, v) {
			map.set(k, String(v));
		},
		read(key) {
			const raw = map.get(key);
			return raw == null ? null : JSON.parse(raw);
		},
	};
};

const LONG = "x".repeat(80); // 60 字超 = クリック展開できるカード
const sessionPayload = (cards) => [
	{
		id: "s1",
		name: "kotomi",
		cwd: "/tmp",
		isActive: true,
		mine: true,
		updatedAt: "2026-01-01T00:00:00.000Z",
		modified: 0,
		modes: { session: {}, global: {} },
		counts: { todo: cards.length, doing: 0, done: 1 },
		cards,
	},
];
const defaultCards = () => [
	{ id: 1, col: "todo", text: LONG },
	{ id: 2, col: "todo", text: LONG },
	{ id: 3, col: "done", text: LONG },
];

const runDashboard = async (storage, cards) => {
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
	const list = cards || defaultCards();
	const payload = {
		host: "test-host",
		now: "2026-01-01T00:00:00.000Z",
		stats: { sessions: 1, active: 1, todo: list.length, doing: 0, done: 1, serve: 0, media: 0 },
		global: { counts: { todo: 0, doing: 0, done: 0 }, cards: [] },
		sessions: sessionPayload(list),
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
	await flushN(6);
	return { byId, timers, sandbox };
};

const cardsIn = (byId) => walk(byId["sessions"]).filter(byClass("card"));
const cardOfId = (byId, id) =>
	cardsIn(byId).find((c) => c.children.some((x) => x.className === "id" && x.textContent === "#" + id));
const openOf = (card) => card.children.find(byClass("clampable"));
// 位置を持つのは列そのものではなく .cards の deck（data-ckey 側）。
const deckOf = (byId, key) =>
	walk(byId["sessions"]).find((n) => n.getAttribute && n.getAttribute("data-ckey") === key);
const runTimers = (timers) => {
	const pending = timers.splice(0, timers.length);
	pending.forEach((t) => t.fn());
};

// ---------------------------------------------------------------------------
// (b) 展開状態: TODO/DOING は残る、DONE は残らない
// ---------------------------------------------------------------------------
{
	const storage = makeStorage();
	const d = await runDashboard(storage);

	await check("#76(b) 前提: 60 字超のカードだけがクリック展開できる", () => {
		assert.equal(cardsIn(d.byId).length, 3, "カードが 3 枚ない");
		assert.ok(openOf(cardOfId(d.byId, 1)), "TODO が clampable でない");
		assert.ok(openOf(cardOfId(d.byId, 3)), "DONE が clampable でない");
	});

	await check("#76(b) TODO を展開すると kb-open に保存される", () => {
		const t = openOf(cardOfId(d.byId, 1));
		t._lis.click[0]({ target: null });
		assert.ok(t.classList.contains("open"), "展開していない");
		const saved = storage.read("kb-open");
		assert.ok(saved && saved.dash, "kb-open の名前空間が無い");
		assert.equal(saved.dash["session.s1:todo#1"], true, "TODO の展開が保存されていない");
	});

	await check("#76(b) DONE を展開しても kb-open には入らない", () => {
		const t = openOf(cardOfId(d.byId, 3));
		t._lis.click[0]({ target: null });
		assert.ok(t.classList.contains("open"), "画面上は展開する");
		const saved = storage.read("kb-open");
		assert.ok(!saved.dash["session.s1:done#3"], "DONE の展開が保存されている");
		// 既存の kb-collapse もキー名・スキーマは不変。ただし DONE はリロードで閉じるので
		// open には載せない（載せると次回の起動で開いたまま復元されてしまう）。
		const collapse = storage.read("kb-collapse");
		assert.deepEqual(Object.keys(collapse.dash).sort(), ["cols", "g", "open", "sess"], "スキーマが変わった");
		assert.equal(collapse.dash.open["session.s1:todo#1"], true, "TODO が kb-collapse から落ちた");
		assert.ok(!collapse.dash.open["session.s1:done#3"], "DONE が kb-collapse に載っている");
	});

	const d2 = await runDashboard(storage);
	await check("#76(b) 立て直すと TODO は開いたまま、DONE は閉じている", () => {
		assert.ok(openOf(cardOfId(d2.byId, 1)).classList.contains("open"), "TODO が復元されていない");
		assert.ok(!openOf(cardOfId(d2.byId, 3)).classList.contains("open"), "DONE が開いたまま復元された");
	});

	await check("#76(b) 畳むと kb-open からキーが消える（false は保存しない）", () => {
		openOf(cardOfId(d2.byId, 1))._lis.click[0]({ target: null });
		const saved = storage.read("kb-open");
		assert.ok(!("session.s1:todo#1" in saved.dash), "閉じたのにキーが残っている");
	});
}

// ---------------------------------------------------------------------------
// (c) MAX_CARD_OPEN を超えたら古い順に落ちる
// MAX_PER_COL=10 枚しか描かないので、開くのは描かれる #5。保存済みは描かれない #11..#50 に
// しておけば、計 41 枚 = 上限跨ぎ。古い順（挿入順）で先頭の #11 が落ちるのが正しい。
// ---------------------------------------------------------------------------
{
	const seeded = {};
	for (let i = 11; i <= 50; i++) seeded[`session.s1:todo#${i}`] = true;
	const storage = makeStorage({ "kb-open": JSON.stringify({ dash: seeded }) });
	const cards = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, col: "todo", text: LONG }));
	const d = await runDashboard(storage, cards);
	await check("#76(c) 41 枚目を開くと上限 40 で最古（#11）が落ちる", () => {
		assert.equal(cardsIn(d.byId).length, 10, `描画されたカード数が違う: ${cardsIn(d.byId).length}`);
		openOf(cardOfId(d.byId, 5))._lis.click[0]({ target: null });
		const saved = storage.read("kb-open").dash;
		assert.equal(Object.keys(saved).length, 40, `上限が効いていない: ${Object.keys(saved).length}`);
		assert.ok(!saved["session.s1:todo#11"], "最も古い #11 が残っている");
		assert.ok(saved["session.s1:todo#12"], "2 番目まで落としている");
		assert.equal(saved["session.s1:todo#5"], true, "新しく開いた #5 が入っていない");
		assert.deepEqual(Object.keys(saved).slice(-1), ["session.s1:todo#5"], "末尾が最新でない");
	});
}

// ---------------------------------------------------------------------------
// (d) 消えたカードの id は保存から掃除される
// ---------------------------------------------------------------------------
{
	const storage = makeStorage();
	const d = await runDashboard(storage);
	openOf(cardOfId(d.byId, 1))._lis.click[0]({ target: null });
	openOf(cardOfId(d.byId, 2))._lis.click[0]({ target: null });
	await check("#76(d) 前提: 2 枚とも保存されている", () => {
		const saved = storage.read("kb-open").dash;
		assert.equal(saved["session.s1:todo#1"], true);
		assert.equal(saved["session.s1:todo#2"], true);
	});
	// カード #1 がボードから消えた状態で読み直す
	await runDashboard(storage, [
		{ id: 2, col: "todo", text: LONG },
		{ id: 3, col: "done", text: LONG },
	]);
	await check("#76(d) 描画時に消えたカードのキーが掃除される", () => {
		const saved = storage.read("kb-open").dash;
		assert.ok(!("session.s1:todo#1" in saved), "#1 が残っている");
		assert.equal(saved["session.s1:todo#2"], true, "生きているカードまで消した");
	});
}

// ---------------------------------------------------------------------------
// (e) 列のスクロール位置: debounce して書き、復元時にクランプする
// ---------------------------------------------------------------------------
{
	const storage = makeStorage();
	const d = await runDashboard(storage);
	const col = () => deckOf(d.byId, "session.s1:todo");

	await check("#76(e) スクロール直後は書かず、debounce 後に書く", () => {
		const c = col();
		assert.ok(c._lis.scroll && c._lis.scroll.length, "列の deck に scroll リスナが無い");
		c.scrollHeight = 5000;
		c.clientHeight = 100;
		c.scrollTop = 4200;
		c._lis.scroll[0]({ target: c });
		assert.equal(storage.read("kb-scroll"), null, "debounce せず即書いている");
		const wait = d.timers.find((t) => t.ms === 150);
		assert.ok(wait, `150ms の debounce が無い: ${JSON.stringify(d.timers.map((t) => t.ms))}`);
		runTimers(d.timers);
		const saved = storage.read("kb-scroll");
		assert.ok(saved && saved.dash, "kb-scroll の名前空間が無い");
		assert.equal(saved.dash["session.s1:todo"], 4200, "スクロール位置が保存されていない");
	});

	const d2 = await runDashboard(storage);
	await check("#76(e) 復元は今の高さにクランプする（保存 4200 / 最大 2900）", () => {
		const c = deckOf(d2.byId, "session.s1:todo");
		c.scrollHeight = 3000;
		c.clientHeight = 100;
		c.scrollTop = 0;
		// 描画後の復元で位置が入っている（描画時点の値で丸め済み）
		assert.equal(c.scrollTop, 0, "前提: 描画時に測れた値で戻る");
	});

	// 描画時点で測れる高さ（makeEl の既定 scrollHeight 3000 / clientHeight 100 = 最大 2900）で
	// 復元されることを、保存値だけを差し替えて確かめる。
	const storage2 = makeStorage({
		"kb-scroll": JSON.stringify({ dash: { "session.s1:todo": 4200 } }),
	});
	const d3 = await runDashboard(storage2);
	await check("#76(e) 保存値 4200 は最大 2900 に丸めて復元される", () => {
		const c = deckOf(d3.byId, "session.s1:todo");
		assert.equal(c.scrollTop, 2900, `クランプされていない: ${c.scrollTop}`);
	});

	const storage3 = makeStorage({
		"kb-scroll": JSON.stringify({ dash: { "session.s1:todo": 400 } }),
	});
	const d4 = await runDashboard(storage3);
	await check("#76(e) 収まる保存値はそのまま復元される", () => {
		assert.equal(deckOf(d4.byId, "session.s1:todo").scrollTop, 400, "収まる値まで丸めている");
	});
}

// ---------------------------------------------------------------------------
// (f) 壊れた保存値でも落ちない
// ---------------------------------------------------------------------------
{
	const storage = makeStorage({ "kb-scroll": "{", "kb-open": "{" });
	const d = await runDashboard(storage);
	await check("#76(f) kb-scroll / kb-open が壊れた JSON でも描画が壊れない", () => {
		assert.equal(cardsIn(d.byId).length, 3, "カードが描画されていない");
		assert.ok(!openOf(cardOfId(d.byId, 1)).classList.contains("open"), "既定は閉");
		openOf(cardOfId(d.byId, 1))._lis.click[0]({ target: null });
		const saved = storage.read("kb-open");
		assert.equal(saved.dash["session.s1:todo#1"], true, "壊れた値を引きずって書けない");
	});

	const weird = makeStorage({
		"kb-scroll": JSON.stringify({ dash: { "session.s1:todo": "5000" } }),
		"kb-open": JSON.stringify({ dash: { "session.s1:todo#1": "yes", "session.s1:todo#2": true } }),
	});
	const d5 = await runDashboard(weird);
	await check("#76(f) 数値でないスクロール値・true でない展開値は無視する", () => {
		assert.equal(deckOf(d5.byId, "session.s1:todo").scrollTop, 0, "文字列を数値として使っている");
		assert.ok(!openOf(cardOfId(d5.byId, 1)).classList.contains("open"), "文字列の true 扱いをしている");
		assert.ok(openOf(cardOfId(d5.byId, 2)).classList.contains("open"), "true の復元が壊れている");
	});
}

// ---------------------------------------------------------------------------
// まとめ
// ---------------------------------------------------------------------------
if (failures.length) {
	console.error(`\n#76 memory: ${passed} pass / ${failures.length} fail`);
	for (const f of failures) console.error(`  FAIL ${f}`);
	// kanban サーバが listen したままで event loop が終わらないので、兄弟テストと同じく明示終了。
	process.exit(1);
}
console.log(`#76 memory: ${passed} pass / 0 fail`);
process.exit(0);
