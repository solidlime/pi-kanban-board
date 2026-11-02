// #35: /api/kanban?p= の応答が返る前に別の slug へ切り替えたら、古い応答で板を塗り替えない。
// カード id はボードローカルなので、A の板を B の選択で描くと、見えている id で別ボードの
// カードを動かすことになる。web/dashboard.html を直接読み、ブラウザ側 JS を vm で走らせる
// （サーバは要らない）。tests/kanban-dashboard-next.test.mjs と同型。
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
		textContent: "",
		title: "",
		value: "",
		style: {},
		dataset: {},
		_lis: {},
		_attrs: {},
		set innerHTML(v) {
			e._html = String(v);
			e.textContent = "";
			e.children.length = 0;
		},
		get innerHTML() {
			return e._html === undefined ? "" : e._html;
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
		querySelector() {
			return null;
		},
		classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
	};
	return e;
}
const all = (n, out = []) => {
	if (!n) return out;
	out.push(n);
	for (const c of n.children || []) all(c, out);
	return out;
};
const textOf = (root, txt) =>
	all(root).some((n) => n.textContent === txt || String(n.innerHTML || "") === txt);

const DASH = {
	host: "t",
	now: new Date().toISOString(),
	stats: { todo: 0, doing: 0, done: 0, serve: 0, media: 0 },
	// A / B を実在させないと #proj の「消えた slug は全部に戻す」で選択が消える。
	global: {
		counts: { todo: 2, doing: 0, done: 0 },
		cards: [
			{ id: 1, text: "a", col: "todo", project: "A" },
			{ id: 2, text: "b", col: "todo", project: "B" },
		],
	},
	project: { id: "cwd", counts: { todo: 0, doing: 0, done: 0 }, cards: [] },
	serve: [],
};
const board = (id, cardText) => ({
	ok: true,
	projectId: id,
	project: { id, counts: { todo: 1, doing: 0, done: 0 }, cards: [{ id: 1, text: cardText, col: "todo" }], next: null },
	modes: {},
});

// /api/kanban?p=<slug> だけ人手で解決する。それ以外は即座に答える。
function boot() {
	const byId = {};
	let nextId = 1;
	const waiting = {};
	const urls = [];
	const document = {
		getElementById: (id) => byId[id] || (byId[id] = makeEl("div")),
		createElement: (t) => makeEl(t),
		documentElement: makeEl("html"),
	};
	const reply = (body) => ({ ok: true, status: 200, json: () => Promise.resolve(body) });
	const sandbox = {
		document,
		window: {},
		URL,
		localStorage: { getItem: () => null, setItem() {} },
		matchMedia: () => ({ matches: false, addEventListener() {} }),
		fetch: (u) => {
			urls.push(String(u));
			const m = /\/api\/kanban\?p=([^&]*)/.exec(String(u));
			if (!m) return Promise.resolve(reply(JSON.parse(JSON.stringify(DASH))));
			const slug = decodeURIComponent(m[1]);
			return new Promise((resolve) => {
				waiting[slug] = () => resolve(reply(board(slug, slug + " card")));
			});
		},
		setTimeout: () => nextId++,
		clearTimeout() {},
		console,
		JSON,
		Math,
		Date,
		encodeURIComponent,
		decodeURIComponent,
	};
	vm.createContext(sandbox);
	vm.runInContext(JS, sandbox);
	return { byId, waiting, urls };
}
const pick = async (byId, v) => {
	byId["proj"].value = v;
	byId["proj"]._lis.change.forEach((fn) => fn({}));
	for (let i = 0; i < 4; i++) await flush();
};

test("?p= の往復中に別の slug へ切り替えたら、遅れて返ってきた古い板は捨てる", async () => {
	const { byId, waiting, urls } = boot();
	for (let i = 0; i < 4; i++) await flush();

	// A を選ぶ。応答はまだ返さない。
	await pick(byId, "A");
	assert.ok(waiting.A, "/api/kanban?p=A が呼ばれていない: " + JSON.stringify(urls));
	assert.ok(!waiting.B, "A の往復中に B を呼んでいる");

	// A が返る前に B へ切り替える。
	await pick(byId, "B");
	assert.ok(waiting.B, "/api/kanban?p=B が呼ばれていない");

	// B が先に返る。
	waiting.B();
	for (let i = 0; i < 4; i++) await flush();
	assert.ok(textOf(byId["project"], "B card"), "B の板が描かれていない");

	// A が遅れて返る。選択はもう B なので、塗り替えてはいけない。
	waiting.A();
	for (let i = 0; i < 4; i++) await flush();
	assert.ok(!textOf(byId["project"], "A card"), "古い A の板で塗り替えられた（別ボードの id を動かす）");
	assert.ok(textOf(byId["project"], "B card"), "B の板が消えた");
});
