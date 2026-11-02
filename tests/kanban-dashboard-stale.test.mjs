// #18: 停滞検知の表示（クライアント側）。web/dashboard.html を直接読み、ブラウザ側 JS を
// vm で走らせる（サーバは要らない）。履歴: 期限チップの tests/kanban-dashboard-dues.test.mjs と同型。
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
		set innerHTML(v) {
			e._html = String(v);
			e.textContent = ""; // 実 DOM と同じく innerHTML 代入は子テキストを捨てる
			e.children.length = 0; // 子も捨てる（render が箱を空にするのを再現）
			// 実ブラウザは innerHTML 代入で子要素ができる。tick が掴む .since だけは再現する――
			// 無いと sinceLive が box フォールバックに落ち、本物の経路を通らない。
			var m = /<span class="since">([\s\S]*?)<\/span>/.exec(e._html);
			e._since = m ? makeEl("span") : null;
			if (e._since) {
				e._since.className = "since";
				e._since.textContent = m[1];
			}
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
		querySelector(sel) {
			return sel === ".since" ? e._since || null : null;
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
/** ops 行の小片（期限チップと同じ規格なので className で拾う） */
const chips = (n) => all(n, (e) => /^sched( |$)/.test(e.className));
/** 停滞チップだけ（他の sched 小片＝依存/見積/発火と混ぜない） */
const staleChips = (n) => chips(n).filter((e) => /^停滞 \d+日$/.test(e.textContent));
/** 見出し（div.sess-hd）の .sess-cwd。件数はここに出る。 */
const headText = (box) => all(box, (e) => e.className === "sess-cwd").map((e) => e.textContent).join(" | ");

const D = 86400000;
const H = 3600000;
const NOW = Date.now();
const ago = (ms) => NOW - ms;

// 3 日（warn）/ 8 日（bad）/ 12 時間（出さない）/ 23時間59分（tick で 1 日に変わる）
const P = [
	{ id: 1, text: "古い未着手", col: "todo", movedAt: ago(10 * D) },
	{ id: 2, text: "三日", col: "doing", movedAt: ago(3 * D) },
	{ id: 3, text: "八日", col: "doing", movedAt: ago(8 * D) },
	{ id: 4, text: "半日", col: "doing", movedAt: ago(12 * H) },
	{ id: 5, text: "もうすぐ一日", col: "doing", movedAt: ago(D - 60_000) },
	{ id: 7, text: "十分", col: "doing", movedAt: ago(10 * 60_000) },
];
const G = [...P.map((c) => ({ ...c, sid: "me" })), { id: 6, text: "よその二日", col: "doing", sid: "other", movedAt: ago(2 * D) }];
const DASH = {
	host: "t",
	now: new Date(NOW).toISOString(),
	stats: { sessions: 0, active: 0, todo: 1, doing: 5, done: 0, serve: 0, media: 0 },
	global: { counts: { todo: 1, doing: 6, done: 0 }, cards: G },
	project: { id: "me", counts: { todo: 1, doing: 5, done: 0 }, cards: P },
	sessions: [],
	serve: [],
};

async function boot(dash = DASH) {
	const byId = {};
	const timers = [];
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
	vm.runInContext(JS, sandbox);
	for (let i = 0; i < 4; i++) await flush();
	return { byId, sandbox, timers };
}
/** カード本文 span.t（#dash は span.t > span.body） */
const cardsOf = (root) => all(root, (e) => /(^| )card( |$)/.test(e.className));
const tOf = (card) => all(card, (e) => /(^| )t( |$)/.test(e.className))[0];
const cardOf = (root, id) =>
	cardsOf(root).find((c) => all(c, (e) => e.className === "id" && e.textContent === "#" + id).length > 0);

// --- sinceText: 分 → 時間 → 日 の 3 段階（カードの経過表示で見る） -------------
test("経過表示は分・時間・日の 3 段階", async () => {
	const d = await boot();
	const t = (id) => {
		const c = cardOf(d.byId.project, id);
		assert.ok(c, `#${id} のカードが無い`);
		return String(tOf(c).innerHTML);
	};
	assert.match(t(7), /10分前から/, "1 時間未満が分の表示でない");
	assert.match(t(4), /12時間前から/, "1 時間以上が時間の表示になっていない");
	assert.match(t(5), /23時間前から/, "23 時間台が時間でない");
	assert.match(t(2), /3日前から/, "1 日以上が日の表示になっていない");
});

// --- カードの停滞チップ -------------------------------------------------------
test("1〜6日は warn の「停滞 Nd」で、title に日数", async () => {
	const d = await boot();
	const c = staleChips(d.byId.project).find((e) => e.textContent === "停滞 3日");
	assert.ok(c, `3日の停滞チップが無い: ${JSON.stringify(staleChips(d.byId.project).map((e) => e.textContent))}`);
	assert.equal(c.className, "sched warn", "3日が warn でない");
	assert.equal(c.title, "3 日動いていない", "title の日数が無い");
});

test("7日以上は bad の「停滞 Nd」", async () => {
	const d = await boot();
	const c = staleChips(d.byId.project).find((e) => e.textContent === "停滞 8日");
	assert.ok(c, "8日の停滞チップが無い");
	assert.equal(c.className, "sched bad", "7日以上が bad でない");
	assert.equal(c.title, "8 日動いていない");
});

test("7日ちょうどが badの境界（6日23時間59分は warn）", async () => {
	const edge = [
		{ id: 91, text: "七日起点", col: "doing", movedAt: ago(7 * D) },
		{ id: 92, text: "七日前", col: "doing", movedAt: ago(7 * D - 60_000) },
	];
	const d = await boot({
		...DASH,
		stats: { sessions: 0, active: 0, todo: 0, doing: 2, done: 0, serve: 0, media: 0 },
		global: { counts: { todo: 0, doing: 2, done: 0 }, cards: edge },
		project: { id: "me", counts: { todo: 0, doing: 2, done: 0 }, cards: edge },
	});
	const got = staleChips(d.byId.project);
	const bad = got.find((e) => e.textContent === "停滞 7日");
	const warn = got.find((e) => e.textContent === "停滞 6日");
	assert.ok(bad, `7日ちょうどのチップが無い: ${JSON.stringify(got.map((e) => e.textContent))}`);
	assert.equal(bad.className, "sched bad", "7日ちょうどが bad でない（>= の境界）");
	assert.ok(warn, "6日23時間59分のチップが無い");
	assert.equal(warn.className, "sched warn", "7日未満が warn でない");
});

test("1日未満の DOING と、TODO/DONE には停滞チップを出さない", async () => {
	const d = await boot();
	assert.equal(staleChips(d.byId.project).length, 2, "3日と8日以外に出ている");
	assert.ok(!staleChips(d.byId.project).some((e) => e.textContent === "停滞 0日"), "日数 0 を出している");
	assert.ok(!staleChips(d.byId.project).some((e) => e.textContent === "停滞 10日"), "TODO の停滞を出している");
});

// --- ヘッダ集計 --------------------------------------------------------------
// #17: GLOBAL 欄は削除したので、件数を出す見出しは project ボードの 1 つだけ。
test("ヘッダに絞り込み後の停滞件数を出す（project 2）", async () => {
	const d = await boot();
	assert.match(headText(d.byId.project), /停滞 2( |$)/, `project の件数が無い: ${headText(d.byId.project)}`);
});

test("検索で絞るとヘッダの件数も減る（見えているチップと一致）", async () => {
	const d = await boot();
	d.byId.q.value = "三日";
	d.byId.q._lis.input[0]();
	assert.match(headText(d.byId.project), /停滞 1( |$)/, `絞り込みが件数に効いていない: ${headText(d.byId.project)}`);
	assert.equal(staleChips(d.byId.project).length, 1, "見えている停滞チップと件数が食い違う");
});

test("停滞 0 件ならヘッダに何も出さない", async () => {
	const fresh = { id: 3, text: "始めたばかり", col: "doing", movedAt: NOW - 10 * 60_000 };
	const d = await boot({
		...DASH,
		stats: { sessions: 0, active: 0, todo: 0, doing: 1, done: 0, serve: 0, media: 0 },
		global: { counts: { todo: 0, doing: 1, done: 0 }, cards: [fresh] },
		project: { id: "me", counts: { todo: 0, doing: 1, done: 0 }, cards: [fresh] },
	});
	assert.ok(!headText(d.byId.project).includes("停滞"), `project に 0 件の停滞が出ている: ${headText(d.byId.project)}`);
});

// --- #74: 1 分ごとのポーリングの tick で日数に切り替わる -----------------------
test("次の 1 分のポーリングで「23時間前から」が「1日前から」に変わる", async () => {
	const dash = { ...DASH, project: { ...DASH.project, cards: P.map((c) => ({ ...c })) } };
	const d = await boot(dash);
	const c = cardOf(d.byId.project, 5);
	assert.ok(c, "#5 のカードが無い");
	const t = tOf(c);
	// 描画直後は innerHTML（sinceLead が文字列で組む）。tick は .since の文字だけ差し替える。
	assert.ok(String(t.innerHTML).includes("23時間前から"), `23時間の表示が無い: ${t.innerHTML}`);
	// now は payload 由来（baseOf）。1 分後の応答を返して既存のポーリングを 1 回回す。
	dash.now = new Date(NOW + 60_000).toISOString();
	const poll = d.timers.find((x) => x.ms === 5000);
	assert.ok(poll, "5 秒ポーリングのタイマーが無い");
	poll.fn();
	for (let i = 0; i < 4; i++) await flush();
	assert.ok(t._since, ".since 要素が無い（本物の経路を通っていない）");
	assert.equal(t._since.textContent, "1日前から", "tick が .since を日数の表示に切り替えていない");
	assert.ok(String(t.innerHTML).includes("23時間前から"), "tick が元の innerHTML を壊している");
});
