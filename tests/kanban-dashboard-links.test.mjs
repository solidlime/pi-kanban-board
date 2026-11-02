// #20: カードの会話タグ（sessionId / commit）の表示。
// リンクにはしない（pi-web の origin は拡張から分からない）。ID の小片を出すだけ。
// web/dashboard.html を直接読み、ブラウザ側 JS を vm で走らせる（サーバは要らない）。
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (f) => readFileSync(fileURLToPath(new URL("../web/" + f, import.meta.url)), "utf8");
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
const sess = (n) => all(n, (e) => e.className === "sess");
const commits = (n) => all(n, (e) => e.className === "commit");

const LONG = "abcdefgh-1234-5678-9abc";
const SHORT = "s-1";
const FULL_SHA = "0123456789abcdef0123456789abcdef01234567";
const PLAIN = { id: 4, text: "タグなし", col: "todo" };
const DASH = {
	host: "t",
	now: new Date().toISOString(),
	stats: { sessions: 0, active: 0, todo: 4, doing: 0, done: 0, serve: 0, media: 0 },
	project: {
		id: "pi-kanban-board",
		counts: { todo: 4, doing: 0, done: 0 },
		cards: [
			{ id: 1, text: "長い会話", col: "todo", sessionId: LONG, commit: FULL_SHA },
			{ id: 2, text: "短い会話", col: "todo", sessionId: SHORT },
			{ id: 3, text: "commit だけ", col: "todo", commit: FULL_SHA },
			PLAIN,
		],
	},
	sessions: [],
	serve: [],
};

async function boot(dash = DASH) {
	const byId = {};
	const timers = [];
	let nextId = 1;
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
	vm.runInContext(JS, sandbox);
	for (let i = 0; i < 4; i++) await flush();
	return { byId };
}

// --- sessionId は 8 文字 + …、全文は title ------------------------------------
test("長い sessionId は 8 文字 + … で出て、全文は title に残る", async () => {
	const d = await boot();
	const chip = sess(d.byId.project).find((c) => c.title === LONG);
	assert.ok(chip, "sessionId の小片が無い");
	assert.equal(chip.textContent, "abcdefgh\u2026", "短縮が 8 文字 + … でない");
});

test("8 文字以内の sessionId は切らない（… を付けない）", async () => {
	const d = await boot();
	const chip = sess(d.byId.project).find((c) => c.title === SHORT);
	assert.ok(chip, "短い sessionId の小片が無い");
	assert.equal(chip.textContent, SHORT);
});

// --- commit は 7 桁、全文は title ---------------------------------------------
test("commit は 7 桁で出て、全文は title に残る", async () => {
	const d = await boot();
	const chips = commits(d.byId.project);
	assert.equal(chips.length, 2, `commit の小片が 2 枚でない: ${chips.length}`);
	assert.equal(chips[0].textContent, "0123456", "7 桁でない");
	assert.equal(chips[0].title, FULL_SHA, "title に全文が無い");
});

// --- 無いときは何も出さない（project と同じ） ---------------------------------
test("sessionId も commit も無いカードは小片を出さない", async () => {
	const d = await boot();
	assert.equal(sess(d.byId.project).length, 2, "sessionId の無いカードに小片が出た");
	assert.equal(commits(d.byId.project).length, 2, "commit の無いカードに小片が出た");
	// タグなしカードは 1 枚だけで、その行には sess/commit が付いていない
	const rows = all(
		d.byId.project,
		(e) => e.className === "card" && e.children.some((c) => String(c.innerHTML || c.textContent || "").includes("タグなし")),
	);
	assert.equal(rows.length, 1, "タグなしカードの行が引けない");
	assert.equal(all(rows[0], (e) => e.className === "sess" || e.className === "commit").length, 0, "タグなしの行に小片が付いた");
});

// --- リンクにしない（決定 1） --------------------------------------------------
test("小片はリンクではない（href も a タグも作らない）", async () => {
	const d = await boot();
	for (const chip of [...sess(d.byId.project), ...commits(d.byId.project)]) {
		assert.equal(chip.tagName, "SPAN", "タグが span でない");
		assert.ok(!chip._attrs.href, "href が付いている");
	}
	assert.equal(all(d.byId.project, (e) => e.tagName === "A").length, 0, "a タグが作られている");
});
