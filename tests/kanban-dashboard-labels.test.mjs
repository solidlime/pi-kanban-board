// #22: ダッシュボードのラベル表示とラベル絞り込み。
// web/dashboard.html のブラウザ側 JS を vm で走らせる（サーバは要らない）。
// 静的 grep では「labFilter が cardFilterOk から読まれていない」を検知できないので、
// cardFilterOk を波括弧対応で抜き出して直接叩く。
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (f) => readFileSync(fileURLToPath(new URL("../web/" + f, import.meta.url)), "utf8");
const readGen = () =>
	readFileSync(fileURLToPath(new URL("../extensions/dashboard.generated.ts", import.meta.url)), "utf8");
const html = read("dashboard.html")
	.replace("__KB_MD_JS__", () => read("md.js").trim())
	.replace("__KB_MEMORY_JS__", () => read("memory.js").trim());
const JS = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
	.map((m) => m[1])
	.find((s) => s.includes('var API = "/api/dashboard"'));
assert.ok(JS, "dashboard のポーリング JS が見つからない");

const flush = () => new Promise((r) => setImmediate(r));

function makeEl(tag) {
	const e = {
		tagName: String(tag).toUpperCase(),
		children: [],
		hidden: false,
		className: "",
		innerHTML: "",
		textContent: "",
		title: "",
		value: "",
		style: {},
		dataset: {},
		_lis: {},
		_attrs: {},
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
		classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
	};
	return e;
}
const all = (n, pred, out = []) => {
	if (!n) return out;
	if (pred(n)) out.push(n);
	for (const c of n.children || []) all(c, pred, out);
	return out;
};
const labs = (n) => all(n, (e) => e.className === "lab");
const textOf = (n) => {
	if (!n) return "";
	let s = typeof n.textContent === "string" ? n.textContent : "";
	// card 行は span を並べる。innerHTML 側に入る本文（md() の結果）も拾う。
	if (n.innerHTML && !n.children.length) s += String(n.innerHTML);
	for (const c of n.children || []) s += textOf(c);
	return s;
};

// --- cardFilterOk を抜き出して直接叩く ----------------------------------------
function bodyOf(name) {
	const at = JS.indexOf(`function ${name}(`);
	assert.ok(at >= 0, `${name} が見つからない`);
	const open = JS.indexOf("{", at);
	let depth = 0;
	for (let i = open; i < JS.length; i += 1) {
		if (JS[i] === "{") depth += 1;
		else if (JS[i] === "}") {
			depth -= 1;
			if (depth === 0) return JS.slice(open + 1, i);
		}
	}
	throw new Error(`${name} の波括弧が閉じない`);
}
const filterOk = new Function(
	"cardFilter",
	"labFilter",
	"depState",
	"dueOf",
	"todayISO",
	"c",
	"pool",
	bodyOf("cardFilterOk"),
);
const run = (c, { cardFilter = "", labFilter = "", dep = "ok" } = {}) =>
	filterOk(cardFilter, labFilter, () => dep, () => null, () => "2024-01-01", c, [c]);

// --- 1. ラベルだけで絞れる（cardFilterOk の中身） ------------------------------
test("labFilter が一致しないカードは cardFilterOk が false", () => {
	assert.equal(run({ id: 1, text: "a", col: "todo", labels: ["bug"] }, { labFilter: "bug" }), true);
	assert.equal(run({ id: 2, text: "b", col: "todo", labels: ["feature"] }, { labFilter: "bug" }), false);
	// ラベル無しも落ちる（「bug で絞る」に無印を混ぜない）
	assert.equal(run({ id: 3, text: "c", col: "todo" }, { labFilter: "bug" }), false);
});

test("複数ラベルのどれか 1 つ一致すれば通る／labFilter=\"\" は素通り", () => {
	const c = { id: 1, text: "a", col: "todo", labels: ["bug", "調査"] };
	assert.equal(run(c, { labFilter: "調査" }), true);
	assert.equal(run(c, { labFilter: "" }), true);
	assert.equal(run({ id: 2, text: "b", col: "todo" }, { labFilter: "" }), true);
});

test("ラベル絞り込みは cardFilter と共存する（ok かつ bug だけ通る）", () => {
	const c = { id: 1, text: "a", col: "todo", labels: ["bug"] };
	assert.equal(run(c, { labFilter: "bug", cardFilter: "ok", dep: "ok" }), true);
	assert.equal(run(c, { labFilter: "bug", cardFilter: "ok", dep: "blocked" }), false);
	assert.equal(run(c, { labFilter: "chore", cardFilter: "ok", dep: "ok" }), false);
});

// --- 2. filtered の判定（renderProject。GLOBAL 欄の削除で 1 箇所になった） ------
test("filtered の判定が labFilter を見る（該当なし表示）", () => {
	const hits = JS.match(/var filtered = search \|\| projPick !== "" \|\| cardFilter !== ""[^\n]*/g) || [];
	assert.equal(hits.length, 1, `filtered の判定が 1 箇所でない: ${hits.length}`);
	for (const line of hits) assert.match(line, /labFilter !== ""/, `labFilter を見ていない: ${line}`);
});

// --- 3. カード行の表示 --------------------------------------------------------
const DASH = {
	host: "t",
	now: new Date().toISOString(),
	stats: { sessions: 0, active: 0, todo: 2, doing: 0, done: 0, serve: 0, media: 0 },
	project: {
		id: "pi-kanban-board",
		counts: { todo: 2, doing: 0, done: 0 },
		cards: [
			{ id: 1, text: "バグ修正", col: "todo", labels: ["bug", "調査"] },
			{ id: 2, text: "ラベル無し", col: "todo" },
		],
	},
	sessions: [],
	serve: [],
};

async function boot(dash = DASH) {
	const byId = {};
	const el = (t) => makeEl(t);
	const document = {
		getElementById: (id) => byId[id] || (byId[id] = el("div")),
		createElement: (t) => el(t),
		documentElement: el("html"),
	};
	const reply = (body) => ({ ok: true, status: 200, json: () => Promise.resolve(body) });
	const sandbox = {
		document,
		window: {},
		URL,
		localStorage: { getItem: () => null, setItem() {} },
		matchMedia: () => ({ matches: false, addEventListener() {} }),
		fetch: () => Promise.resolve(reply(dash)),
		setTimeout: () => 0,
		clearTimeout() {},
		console,
	};
	vm.createContext(sandbox);
	vm.runInContext(JS, sandbox);
	for (let i = 0; i < 4; i++) await flush();
	return { byId, sandbox };
}

test("カード行に .lab が順序どおり出る（ボード）", async () => {
	const d = await boot();
	const chips = labs(d.byId.project);
	assert.deepEqual(chips.map((c) => c.textContent), ["bug", "調査"], "ラベルの小片が順序どおり出ていない");
	for (const c of chips) assert.equal(c.tagName, "SPAN");
});

test("ラベル無しのカードには小片を出さないし、ラベルは本文を壊さない", async () => {
	const d = await boot();
	assert.equal(labs(d.byId.project).length, 2, "ラベル無しのカードに小片が付いた");
	const rows = all(d.byId.project, (e) => e.className === "card" && textOf(e).includes("ラベル無し"));
	assert.equal(rows.length, 1, "ラベル無しのカード行が引けない");
	assert.equal(labs(rows[0]).length, 0, "ラベル無しの行に .lab が付いた");
});

// --- 4. 絞り込み UI と配線 ----------------------------------------------------
test("<select id=lab> は固定 4 種＋全部を持ち、change が labFilter を更新する", async () => {
	const d = await boot();
	const sel = d.byId.lab;
	assert.ok(sel, "id=lab の select が無い");
	// 初期化時に option が入る実装ではなく HTML 直書き（値は語彙そのもの）
	assert.equal(sel.value, "", "初期値が「全部」でない");
	assert.match(html, /<select id="lab"[^>]*aria-label="ラベルで絞り込み"/);
	for (const v of ["bug", "feature", "chore", "調査"]) {
		assert.ok(html.includes(`<option value="${v}">`), `${v} の option が無い`);
	}
	assert.equal((sel._lis.change || []).length, 1, "change の配線が無い");
});

// --- 5. 生成物が古くない（web/ だけ直して緑になるのを防ぐ） ---------------------
test("配信 HTML（dashboard.generated.ts）にもラベルの行と select が入っている", () => {
	const gen = readGen();
	assert.ok(gen.includes('el("span", "lab"'), "生成物にカード行のラベル描画が無い（npm run build 忘れ）");
	assert.ok(gen.includes('id="lab"'), "生成物に id=lab の select が無い（npm run build 忘れ）");
	assert.ok(gen.includes('labFilter'), "生成物に labFilter が無い（npm run build 忘れ）");
});
