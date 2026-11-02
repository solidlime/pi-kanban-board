// 期限チップ（看板のカード）の色と文言。プロジェクトタブのマイルストーン行と
// 同じ規則（dueCls）を共有しているので、片方だけ直す退行をここで止める。
// web/dashboard.html を直接読み、ブラウザ側 JS を vm で走らせる（サーバは要らない）。
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SRC = fileURLToPath(new URL("../web/dashboard.html", import.meta.url));
const read = (f) => readFileSync(fileURLToPath(new URL("../web/" + f, import.meta.url)), "utf8");
const html = read("dashboard.html")
	.replace("__KB_MD_JS__", () => read("md.js").trim())
	.replace("__KB_MEMORY_JS__", () => read("memory.js").trim());
const JS = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
	.map((m) => m[1])
	.find((s) => s.includes('var API = "/api/dashboard"'));
assert.ok(JS, "dashboard のポーリング JS が見つからない");

const flush = () => new Promise((r) => setImmediate(r));
const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

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
/** className がちょうど "sched" で始まる期限チップ */
const chips = (n) => all(n, (e) => /^sched( |$)/.test(e.className));

const TODO = { id: 1, text: "期限切れの未完了", col: "todo", due: day(-2) };
const DONE = { id: 2, text: "期限切れの完了", col: "done", due: day(-5) };
// 境界そのものを踏む: 3 日後 = warn の上限、4 日後 = 色なしの下限
const SOON = { id: 3, text: "もうすぐ", col: "doing", due: day(3) };
const FAR = { id: 4, text: "まだ先", col: "todo", due: day(4) };
const DASH = {
	host: "t",
	now: new Date().toISOString(),
	// counts は実カードと一致させる（todo 2 = TODO + FAR）。矛盾したフィクスチャは assert を空にする
	stats: { sessions: 0, active: 0, todo: 2, doing: 1, done: 1, serve: 0, media: 0 },
	global: { counts: { todo: 2, doing: 1, done: 1 }, cards: [TODO, SOON, FAR, DONE] },
	// GLOBAL 欄は無くなったので、看板の描画は project 側で見る
	project: { id: "pi-kanban-board", counts: { todo: 2, doing: 1, done: 1 }, cards: [TODO, SOON, FAR, DONE] },
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

const md = (d) => d.slice(5, 10).replace("-", "/");

// --- 未完了の期限超過は赤く「期限切れ」と言う --------------------------------
test("期限超過の未完了カードは bad + 「期限切れ」", async () => {
	const d = await boot();
	const chip = chips(d.byId.project).find((c) => c.title === "2 日超過");
	assert.ok(chip, "期限チップが無い（due が描かれていない）");
	assert.equal(chip.className, "sched bad", "未完了の期限超過が赤くない");
	assert.equal(chip.textContent, "期限切れ " + md(day(-2)), "「期限切れ」と言っていない");
});

test("3日以内は warn、4日以上先は色なし", async () => {
	const d = await boot();
	const soon = chips(d.byId.project).find((c) => c.textContent === "期限 " + md(day(3)));
	assert.ok(soon, "ちょうど3日後のチップが無い");
	assert.equal(soon.className, "sched warn", "3日後が warn でない（境界がずれている）");
	const far = chips(d.byId.project).find((c) => c.textContent === "期限 " + md(day(4)));
	assert.ok(far, "先のチップが無い");
	assert.equal(far.className, "sched", "4日以上先に色が付いている");
});

// --- 完了済みは事実だけ残し、色も「期限切れ」の語も付けない -------------------
test("期限超過でも完了済みは色なし・「期限切れ」と言わない", async () => {
	const d = await boot();
	// 文言で引いてから title を別に assert する（title で引くと後段の assert が同語反復になる）
	const chip = chips(d.byId.project).find((c) => c.textContent === "期限 " + md(day(-5)));
	assert.ok(chip, "完了カードに期限チップが無い（事実は消さない）");
	assert.equal(chip.className, "sched", "完了済みが赤い");
	assert.ok(!chip.textContent.startsWith("期限切れ"), "完了済みに「期限切れ」と言っている");
	// 超過日数は title にだけ残す
	assert.equal(chip.title, "5 日超過");
});

// --- 集計と色が同じ規則であること --------------------------------------------
test("ヘッダの期限超過件数は未完了だけを数える（赤い行と一致）", async () => {
	const d = await boot();
	const bad = chips(d.byId.project).filter((c) => c.className === "sched bad");
	assert.equal(bad.length, 1, "赤い期限チップが 1 本ではない（フィクスチャが壊れている）");
	// stat は textContent では引けない（doing:1 や done:1 も "1" になる）。aria-label で特定する
	const stats = all(d.byId.stats, (e) => /^期限超過 /.test(e.getAttribute("aria-label") || ""));
	assert.equal(stats.length, 1, "期限超過の stat が無い");
	assert.equal(stats[0].getAttribute("aria-label"), "期限超過 " + bad.length,
		"件数と赤いチップが食い違う（cardStats が done を数えている／数えていない）");
});

// --- #16: 集約と自ボードの二重計上 --------------------------------------------
const tile = (d, label) =>
	all(d.byId.stats, (e) => new RegExp("^" + label + " ").test(e.getAttribute("aria-label") || ""))[0];

test("着手可能タイルは d.project を足さない（global は既に自ボードを含む）", async () => {
	const one = { id: 1, text: "一枚", col: "todo", sid: "own" };
	// global は全 project ボードの合成。自ボードのカードは既にそちらに入っているので、
	// d.project.cards を足すと同じカードを二重に数える。
	const d = await boot({
		...DASH,
		stats: { sessions: 0, active: 0, todo: 1, doing: 0, done: 0, serve: 0, media: 0 },
		global: { counts: { todo: 1, doing: 0, done: 0 }, cards: [one] },
		project: { id: "own", counts: { todo: 1, doing: 0, done: 0 }, cards: [{ ...one }] },
	});
	assert.equal(tile(d, "着手可能").getAttribute("aria-label"), "着手可能 1", "同じカードを 2 枚と数えている");
});

// --- #16: GLOBAL の由来はツール側の `[slug]` と同じ語彙で出す ----------------------
// ダッシュボードは 📁slug、ツールは [slug] で、同じ「project」タグと見分けが付かなかった。
test("ボードのカードは由来ボードを [slug] で出す", async () => {
	const one = { id: 1, text: "由来あり", col: "todo", sid: "alpha" };
	const d = await boot({
		...DASH,
		project: { id: "alpha", counts: { todo: 1, doing: 0, done: 0 }, cards: [one] },
	});
	const tags = all(d.byId.project, (e) => e.className === "proj" && e.textContent === "[alpha]");
	assert.equal(tags.length, 1, `由来の表示が [alpha] でない: ${JSON.stringify(
		all(d.byId.project, (e) => e.className === "proj").map((e) => e.textContent),
	)}`);
});

// --- #16: GLOBAL の依存解決は sid まで込みで引く --------------------------------
test("GLOBAL の blocks は同じ sid のカードで解く（別ボードの同じ id を引かない）", async () => {
	// ボードごとに id は 1 から。b:1 は todo のまま、a:1 は done。
	// id だけで引くと後勝ちで a:1 (done) を拾い、b:2 が着手可能に見えてしまう。
	const cards = [
		{ id: 1, text: "b1", col: "todo", sid: "b" },
		{ id: 1, text: "a1", col: "done", sid: "a" },
		{ id: 2, text: "b2", col: "todo", sid: "b", blocks: [1] },
	];
	const d = await boot({
		...DASH,
		stats: { sessions: 0, active: 0, todo: 2, doing: 0, done: 1, serve: 0, media: 0 },
		global: { counts: { todo: 2, doing: 0, done: 1 }, cards },
	});
	assert.equal(tile(d, "ブロック中").getAttribute("aria-label"), "ブロック中 1", "別ボードの id=1 で依存を解いている");
});
