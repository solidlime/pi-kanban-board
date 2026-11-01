// #19: 「次にやること」を最上部に出す（クライアント側）。web/dashboard.html を直接読み、
// ブラウザ側 JS を vm で走らせる（サーバは要らない）。履歴: tests/kanban-dashboard-stale.test.mjs と同型。
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
const all = (n, pred, out = []) => {
	if (!n) return out;
	if (pred(n)) out.push(n);
	for (const c of n.children || []) all(c, pred, out);
	return out;
};
/** className に cls が単語として入っている要素（"next-t" が "next" に化けないよう境界を見る） */
const byCls = (n, cls) => all(n, (e) => String(e.className).split(/\s+/).includes(cls));
const one = (n, cls) => byCls(n, cls)[0];
const chips = (n) => all(n, (e) => /^sched( |$)/.test(String(e.className)));

const iso = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
const DASH = {
	host: "t",
	now: new Date().toISOString(),
	stats: { todo: 1, doing: 0, done: 0, serve: 0, media: 0 },
	global: { counts: { todo: 1, doing: 0, done: 0 }, cards: [] },
	project: { id: "me", counts: { todo: 1, doing: 0, done: 0 }, cards: [], next: null },
	serve: [],
};

async function boot(dash) {
	const byId = {};
	let nextId = 1;
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
		fetch: () => Promise.resolve(reply(dash)),
		setTimeout: () => nextId++,
		clearTimeout() {},
		console,
		JSON,
		Math,
		Date,
		encodeURIComponent,
	};
	vm.createContext(sandbox);
	vm.runInContext(JS, sandbox);
	for (let i = 0; i < 4; i++) await flush();
	return { byId };
}
const withNext = (next) => ({ ...DASH, project: { ...DASH.project, next } });

const CARD = { id: 19, text: "「次にやること」を最上部に出す", col: "todo", priority: 5 };

test("#nextsec はボードペインで #statsec の前・hidden でない（静的マークアップ）", () => {
	const pane = html.slice(html.indexOf('id="pane-board"'), html.indexOf('id="pane-projects"'));
	assert.ok(pane.includes('id="nextsec"'), "pane-board に nextsec が無い");
	assert.ok(!/id="nextsec"[^>]*hidden/.test(html), "nextsec に hidden が付いている");
	assert.ok(pane.indexOf('id="nextsec"') < pane.indexOf('id="statsec"'), "#statsec より後ろにある");
	// 見出しの無い領域を live にすると、無関係なカード 1 枚でも読み上げが走る
	assert.ok(!/id="nextsec"[^>]*aria-live/.test(html), "nextsec が aria-live");
});

// --- あるとき -----------------------------------------------------------------
test("project.next があると #nextsec にラベル・#id・本文・優先度が出る", async () => {
	const d = await boot(withNext(CARD));
	const sec = d.byId.nextsec;
	const lbl = one(sec, "next-lbl");
	assert.ok(lbl, `#nextsec に next-lbl が無い: ${JSON.stringify(sec.children.map((c) => c.className))}`);
	assert.equal(lbl.textContent, "次にやる", "ラベルの文言が違う");
	assert.equal(one(sec, "next-id").textContent, "#19", "#19 が出ていない");
	assert.equal(one(sec, "next-t").textContent, CARD.text, "本文が出ていない");
	assert.equal(one(sec, "prio").textContent, "P5", "優先度チップが出ていない");
	assert.ok(one(sec, "next"), "パネル（.next）が無い");
});

test("優先度 0 は チップを出さない（カードと同じ規則）", async () => {
	const d = await boot(withNext({ ...CARD, priority: 0 }));
	assert.equal(one(d.byId.nextsec, "prio"), undefined, "P0 を出している");
});

// --- 空のとき -----------------------------------------------------------------
// next: null は「TODO が 0 枚」ではない（nextTodo は blocked / 予約中を落とす）。
test("next が null で TODO も 0 枚なら「TODO が空」", async () => {
	const d = await boot(withNext(null));
	const sec = d.byId.nextsec;
	assert.ok(sec.children.length > 0, "空のメッセージが無い（セクションが空になった）");
	const txt = all(sec, (e) => typeof e.textContent === "string" && e.textContent.length > 0)
		.map((e) => e.textContent)
		.join(" | ");
	assert.match(txt, /TODO が空/, `空メッセージが無い: ${txt}`);
	assert.doesNotMatch(txt, /着手できない/, "TODO が無いのに「着手できない」と言っている");
	assert.equal(one(sec, "next-id"), undefined, "空なのに #id を出している");
});

test("next が null でも TODO が残っていれば「着手できない」と言う", async () => {
	const d = await boot({ ...DASH, project: { ...DASH.project, cards: [CARD], next: null } });
	const sec = d.byId.nextsec;
	const txt = all(sec, (e) => typeof e.textContent === "string" && e.textContent.length > 0)
		.map((e) => e.textContent)
		.join(" | ");
	assert.match(txt, /着手できない/, `TODO が残っているのに理由を言っていない: ${txt}`);
	assert.doesNotMatch(txt, /TODO が空/, "TODO が残っているのに「空」と言っている");
	assert.equal(one(sec, "next-id"), undefined, "next が null なのに #id を出している");
});

// --- 期限チップ ---------------------------------------------------------------
test("期限が過去なら bad + 「期限切れ」と超過日数（カードと同じチップ）", async () => {
	const d = await boot(withNext({ ...CARD, due: iso(-1) }));
	const c = chips(d.byId.nextsec);
	assert.equal(c.length, 1, `期限チップが 1 個でない: ${JSON.stringify(c.map((e) => e.className))}`);
	assert.equal(c[0].className, "sched bad", "過去の期限が bad でない");
	assert.match(c[0].textContent, /期限切れ/, "超過なのに語が「期限」のまま");
	assert.equal(c[0].title, "1 日超過", "超過日数のホバーが無い");
});

test("期限が 2 日以内なら sched warn", async () => {
	const d = await boot(withNext({ ...CARD, due: iso(2) }));
	const c = chips(d.byId.nextsec);
	assert.equal(c.length, 1, "期限チップが無い");
	assert.equal(c[0].className, "sched warn", "2 日以内が warn でない");
	assert.doesNotMatch(c[0].textContent, /期限切れ/, "未来の期限を「期限切れ」と言っている");
	assert.equal(c[0].title, "期限まで 2 日", "残り日数のホバーが無い");
});

test("期限なしなら期限チップを出さない", async () => {
	const d = await boot(withNext({ ...CARD }));
	assert.equal(chips(d.byId.nextsec).length, 0, "期限なしで期限チップが出ている");
});

// --- 長い本文 ----------------------------------------------------------------
test("本文は 60 字で切る", async () => {
	const long = "あ".repeat(70);
	const d = await boot(withNext({ ...CARD, text: long }));
	const t = one(d.byId.nextsec, "next-t").textContent;
	assert.notEqual(t, long, "切っていない");
	assert.equal(t.length, 61, `60 字 + 省略記号でない: ${t.length}`);
	assert.equal(t, "あ".repeat(60) + "…", "切れ目が 60 字でない");
});

test("60 字で切ってもサロゲートペア（絵文字）を割らない", async () => {
	const d = await boot(withNext({ ...CARD, text: "あ".repeat(59) + "😀" + "い".repeat(5) }));
	const t = one(d.byId.nextsec, "next-t").textContent;
	assert.equal(t, "あ".repeat(59) + "😀" + "…", `60 文字目が絵文字でない: ${JSON.stringify(t.slice(-3))}`);
	assert.ok(t.endsWith("😀…"), "絵文字が割れている");
	assert.equal(t.includes("\uFFFD"), false, "置換文字（U+FFFD）が混じっている");
});
