// #44 ダッシュボードのダブルクリック編集。読み取り専用セッションのカードでも
// 「なぜ編集できないか」を返すことの自己検証 (#011)。
// フレームワーク無しで `node tests/kanban-dashboard-edit.test.mjs`。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import vm from "node:vm";

const HOME_DIR = "/tmp/kb-dashboard-edit-home";
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
function check(name, fn) {
	try {
		fn();
		passed += 1;
	} catch (err) {
		failures.push(`${name}: ${err.message}`);
	}
}
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

// --- 0. 実サーバ: GET / が 200 で新コードを配信する ---------------------------
{
	const res = await fetch(`${BASE}/`);
	const html = await res.text();
	check("GET / は 200 を返す", () => assert.equal(res.status, 200));
	check("配信 HTML にカード本体の dblclick が含まれる", () =>
		assert.ok(html.includes('card.addEventListener("dblclick"'), "カード本体のリスナが無い"));
	check("配信 HTML に RO 注記の定義が含まれる（#55 では発火しない）", () => {
		// #55: セッション単位ロック撤去で ctx.active は常に true。分岐と文言の定義だけ残る。
		assert.ok(html.includes("読み取り専用"), "読み取り専用の文言が無い");
		assert.ok(html.includes('id="note"'), "#note 要素が無い");
	});
}

// --- 1. 配信されたテンプレート文字列レベル -----------------------------------
// DASHBOARD_HTML は export されていないので、サーバが返した HTML を正とする。
const SRC = await (await fetch(`${BASE}/`)).text();

check("DASHBOARD_HTML: dblclick はカード本体に付く（1 本だけ）", () => {
	assert.ok(SRC.includes('card.addEventListener("dblclick"'), "カード本体のリスナが無い");
	// .t にも登録すると 1 回のダブルクリックで 2 回発火する
	assert.ok(!SRC.includes('t.addEventListener("dblclick"'), ".t 側の登録が残っている（二重発火）");
});

check("DASHBOARD_HTML: RO 分岐は残るが ctx.active は常に true（#55）", () => {
	const at = SRC.indexOf('card.addEventListener("dblclick"');
	assert.ok(at > 0, "リスナが無い");
	assert.ok(/if \(!ctx \|\| !ctx\.active\) \{ note\(RO_MSG\); return; \}/.test(SRC.slice(at, at + 900)), "分岐が無い");
	assert.ok(/RO_MSG = "この看板は読み取り専用/.test(SRC), "文言が違う");
	// 常に true を渡すので RO 分岐は到達しない
	assert.ok(SRC.includes('boardCtx("session", s.id)'), "session ボードの ctx に isActive を渡している");
	assert.ok(!SRC.includes('boardCtx("session", s.id, s.isActive)'), "isActive がまだ渡されている");
});

check("DASHBOARD_HTML: .ops / a / textarea を除外する", () => {
	const at = SRC.indexOf('card.addEventListener("dblclick"');
	const h = SRC.slice(at, at + 900);
	assert.ok(h.includes('closest(".ops")'), ".ops の除外が無い");
	assert.ok(h.includes('closest("a")'), "リンクの除外が無い");
	assert.ok(h.includes('closest("textarea")'), "編集中 textarea の除外が無い");
});

check("DASHBOARD_HTML: RO_TITLE の定義は残る（#55 では card.title に入らない）", () => {
	assert.ok(/RO_TITLE = "読み取り専用（編集するにはセッションをアクティブに）"/.test(SRC), "title 文言が違う");
	// session ボードは常に active:true なので、この代入はどの実セッションでも起きない。
	assert.ok(/card\.title = RO_TITLE/.test(SRC), "RO_TITLE 代入の分岐自体が消えている");
});

check("読み取り専用でも draggable は付けない（既存挙動を維持）", () => {
	const at = SRC.indexOf("function board(cards, nowMs, ctx)");
	const h = SRC.slice(at, at + 3000);
	assert.match(h, /if \(ctx && ctx\.active\) \{\s*\n\s*card\.setAttribute\("draggable", "true"\)/, "draggable の条件が変わっている");
});


// --- 2. ブラウザ側 JS: 構文検査 + 読み取り専用カードの実挙動 ------------------
const html = SRC;
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const apiScript = scripts.find((s) => s.includes('var API = "/api/dashboard"'));

check("dashboard の JS を抽出できる", () => assert.ok(apiScript));
check("dashboard の <script> は構文として妥当", () => {
	assert.doesNotThrow(() => new Function(apiScript));
});

{
	const created = [];
	const makeEl = () => {
		const e = {
			children: [],
			hidden: false,
			className: "",
			innerHTML: "",
			textContent: "",
			title: "",
			type: "",
			value: "",
			disabled: false,
			style: {},
			attrs: {},
			lis: {},
			appendChild(c) {
				e.children.push(c);
				c.parentNode = e;
				return c;
			},
			replaceChild(n, o) {
				const i = e.children.indexOf(o);
				if (i >= 0) e.children[i] = n;
				n.parentNode = e;
				return o;
			},
			setAttribute(k, v) {
				e.attrs[k] = String(v);
			},
			getAttribute(k) {
				return k in e.attrs ? e.attrs[k] : null;
			},
			focus() {},
			addEventListener(t, fn) {
				(e.lis[t] = e.lis[t] || []).push(fn);
			},
			removeEventListener() {},
			classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
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
		};
		created.push(e);
		return e;
	};
	const byId = {};
	const document = {
		getElementById: (id) => byId[id] || (byId[id] = makeEl()),
		createElement: () => makeEl(),
		documentElement: makeEl(),
		querySelectorAll: () => [],
	};
	const payload = {
		host: "test-host",
		now: "2026-01-01T00:00:00.000Z",
		stats: { sessions: 2, active: 1, todo: 2, doing: 0, done: 0, serve: 0, media: 0 },
		global: { counts: { todo: 0, doing: 0, done: 0 }, cards: [] },
		sessions: [
			{
				id: "01a1480c",
				name: "active-one",
				cwd: "/tmp",
				isActive: true,
				updatedAt: "2026-01-01T00:00:00.000Z",
				modes: { session: {}, global: {} },
				counts: { todo: 1, doing: 0, done: 0 },
				cards: [{ id: "1", col: "todo", text: "書けるカード" }],
			},
			{
				id: "01a1266c",
				name: "readonly-one",
				cwd: "/tmp",
				isActive: false,
				updatedAt: "2026-01-01T00:00:00.000Z",
				modes: { session: {}, global: {} },
				counts: { todo: 1, doing: 0, done: 0 },
				cards: [{ id: "2", col: "todo", text: "読むだけのカード" }],
			},
		],
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
		fetch: () =>
			Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) }),
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
	for (let i = 0; i < 6; i++) await flush();

	// カードは dblclick を登録した要素 = 1 枚につき 1 つ
	const cards = created.filter((e) => e.className === "card");
	check("カード 2 枚とも dblclick を登録している（active / readonly 両方）", () => {
		assert.equal(cards.length, 2, `cards=${cards.length}`);
		for (const c of cards) assert.ok(c.lis.dblclick && c.lis.dblclick.length === 1, "dblclick が 1 本でない");
	});
	check("カード 1 枚につき .t スパンも 1 つ（二重登録なし）", () => {
		for (const c of cards) {
			const ts = c.children.filter((x) => x.className === "t");
			assert.equal(ts.length, 1, ".t が 1 つでない");
			assert.ok(!(ts[0].lis.dblclick && ts[0].lis.dblclick.length), ".t に dblclick が付いている");
		}
	});

	// #note は note() が getElementById で引く。先に実体を作っておく。
	const noteEl = document.getElementById("note");
	const RO_TITLE = "読み取り専用（編集するにはセッションをアクティブに）";
	const idle = { target: { closest: () => null } };
	// dblclick は .t を textarea に置き換えるので、カードの同定は先に済ませる。
	const cardOf = (text) => cards.find((c) => c.children.some((x) => String(x.innerHTML).includes(text)));
	const otherCard = cardOf("読むだけのカード");
	const activeCard = cardOf("書けるカード");
	check("どちらのカードにも RO_TITLE は付かない（#55: 全セッション編集可）", () => {
		assert.equal(cards.filter((c) => c.title === RO_TITLE).length, 0, "読み取り専用扱いのカードがある");
	});
	check("driver でないセッションのカードも dblclick で textarea になる", () => {
		assert.ok(otherCard, "他セッションのカードが無い");
		noteEl.hidden = true;
		otherCard.lis.dblclick[0](idle);
		assert.equal(noteEl.hidden, true, "note が誤発火している");
		const ta = otherCard.children.find((x) => x.className === "ted");
		assert.ok(ta, "textarea.ted に置き換わっていない");
		assert.equal(ta.value, "読むだけのカード");
	});
	check(".ops 内のダブルクリックは無視する", () => {
		assert.ok(activeCard, "active カードが無い");
		noteEl.hidden = true;
		const before = activeCard.children.filter((x) => x.className === "ted").length;
		activeCard.lis.dblclick[0]({ target: { closest: (s) => (s === ".ops" ? {} : null) } });
		assert.equal(noteEl.hidden, true, "note が出ている");
		const after = activeCard.children.filter((x) => x.className === "ted").length;
		assert.equal(after, before, "textarea が開いている");
	});
	check("active カードの dblclick は textarea に置き換える（note は出さない）", () => {
		assert.ok(activeCard, "active カードが無い");
		noteEl.hidden = true;
		activeCard.lis.dblclick[0](idle);
		assert.equal(noteEl.hidden, true, "note が誤発火している");
		const ta = activeCard.children.find((x) => x.className === "ted");
		assert.ok(ta, "textarea.ted に置き換わっていない");
		assert.equal(ta.value, "書けるカード");
	});
}

// --- 3. 集計 -----------------------------------------------------------------
for (const f of failures) console.error("FAIL", f);
console.log(`kanban-dashboard-edit: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
console.log("OK");
process.exit(0);
