// #8 プロジェクトタブ: 別エンドポイントの取り込み方と、描画の中身。
// web/dashboard.html を直接読み、ブラウザ側 JS を vm で走らせる（サーバは要らない）。
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SRC = fileURLToPath(new URL("../web/dashboard.html", import.meta.url));
const read = (f) => readFileSync(fileURLToPath(new URL("../web/" + f, import.meta.url)), "utf8");
// build-web.mjs と同じ組み立て（共有スクリプトを差し込む）しないと JS が ReferenceError で止まる
const html = read("dashboard.html")
	.replace("__KB_MD_JS__", () => read("md.js").trim())
	.replace("__KB_MEMORY_JS__", () => read("memory.js").trim());
// __KB_HOST__ は配信時に置換されるので残っていてよい
assert.ok(!/__KB_(MD|MEMORY)_JS__/.test(html), `未置換のスクリプトがある: ${SRC}`);
const JS = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
	.map((m) => m[1])
	.find((s) => s.includes('var API = "/api/dashboard"'));
assert.ok(JS, "dashboard のポーリング JS が見つからない");

const flush = () => new Promise((r) => setImmediate(r));

// 日付はテストが走る日を基準にする（"あとN日" を固定値で書かない）
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

const allText = (n) =>
	(n.textContent || "") + (n.children || []).map(allText).join(" ");
/** 深さ優先で最初に当てはまる要素を返す */
function find(n, pred) {
	if (!n) return null;
	if (pred(n)) return n;
	for (const c of n.children || []) {
		const hit = find(c, pred);
		if (hit) return hit;
	}
	return null;
}
const findText = (n, txt) => find(n, (e) => e.textContent === txt);
const bar = (n) => find(n, (e) => e._attrs && e._attrs.role === "progressbar");

const DASH = {
	host: "t",
	now: "2026-01-01T00:00:00.000Z",
	stats: { sessions: 0, active: 0, todo: 0, doing: 0, done: 0, serve: 0, media: 0 },
	global: { counts: { todo: 0, doing: 0, done: 0 }, cards: [] },
	sessions: [],
	serve: [],
};

/** ブラウザ側 JS を 1 回起動する。/api/projects は data を返す。 */
async function boot(data) {
	const byId = {};
	const calls = [];
	// /api/projects の応答だけ外から差し替える（失敗経路と取得中の多重要求を作るため）
	const ctl = { projectsFetch: null, projectsCalls: 0 };
	const timers = [];
	let nextId = 1;
	const el = (t) => makeEl(t);
	const document = {
		getElementById: (id) => byId[id] || (byId[id] = el("div")),
		createElement: (t) => el(t),
		documentElement: el("html"),
		body: el("body"),
	};
	const reply = (body) => ({ ok: true, status: 200, json: () => Promise.resolve(body) });
	const sandbox = {
		document,
		// 決定の削除は window.confirm を通る。テストから差し替えられるように外へ出す
		window: { confirm: () => true },
		URL,
		localStorage: { getItem: () => null, setItem() {} },
		matchMedia: () => ({ matches: false, addEventListener() {} }),
		fetch: (u) => {
			const url = String(u);
			calls.push(url);
			if (url.startsWith("/api/projects")) {
				ctl.projectsCalls++;
				if (ctl.projectsFetch) return ctl.projectsFetch();
				return Promise.resolve(reply(data));
			}
			if (url.startsWith("/api/decision")) return Promise.resolve(reply({ ok: true }));
			return Promise.resolve(reply(DASH));
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
	};
	vm.createContext(sandbox);
	vm.runInContext(JS, sandbox);
	for (let i = 0; i < 4; i++) await flush();
	ctl.document = document;
	return { byId, calls, timers, window: sandbox.window, ctl };
}

const decision = (id, text, why) => ({ id, slug: "", at: Date.now() - 3600000, text, ...(why ? { why } : {}) });

// --- 1. 骨組み: ペイン・取り込み口・アクセシビリティ -------------------------
test("#8 ペインと取り込み先がある", () => {
	// #12: 配信サーバーは設定ペインのセクションになったので、境界は pane-settings。
	const pane = html.slice(html.indexOf('id="pane-projects"'), html.indexOf('id="pane-settings"'));
	assert.ok(pane.includes('id="projects"'), "pane-projects に #projects が無い");
	assert.match(html, /id="pane-projects"[^>]*hidden/, "初期は隠れている");
	// 専用タイマーは作らない: 既存の 5 秒ポーリング（reload）に相乗りする
	assert.ok(html.includes('if (activeTab === "projects") loadProjects()'), "reload の末尾でだけ取りに行く");
	// #11/#13: 自己診断（/api/selftest）と DB メンテ（/api/db/*）は 503/500 を正常な応答として
	// 読むため生 fetch を持つ。api() は !ok で throw するので本文が読めない。
	assert.equal((html.match(/fetch\(/g) || []).length, 3, "fetch 点は api() + /api/selftest + /api/db/*");
});

test("#8 決定を打っている間はポーリングが描き直さない", () => {
	// #11: ループ設定の入力欄は #settings-loops に移ったので、そこも編集中の対象に含める。
	// phase0: project 看板の入力欄も再描画で消してはいけないので #project が加わった。
	assert.match(html, /closest\("#stats, #project, #sessions, #global, #serve, #projects, #settings-loops"\)/);
	assert.ok(html.includes("if (!isEditing()) renderProjects()"), "取得後も編集中は描かない");
});

test("#8 進捗バーは支援技術にも値が読める", () => {
	assert.match(html, /\.pbar\{/, "バーの CSS が無い");
	assert.ok(html.includes('bar.setAttribute("role", "progressbar")'));
	assert.ok(html.includes('bar.setAttribute("aria-valuenow", String(pct))'));
});

const all = (n, pred, out = []) => {
	if (pred(n)) out.push(n);
	for (const c of n.children || []) all(c, pred, out);
	return out;
};
const buttons = (n, label) => all(n, (e) => e.tagName === "BUTTON" && e.textContent === label);
const q = (url) => new URLSearchParams(url.slice(url.indexOf("?") + 1));

// 1 件だけ入ったプロジェクト（見積あり・未宣言・期限超過 1 枚）
const D10 = day(10);
const FULL = {
	ok: true,
	projects: [
		{
			slug: "alpha",
			name: "アルファ",
			declared: false,
			counts: { todo: 1, doing: 1, done: 2 },
			total: 4,
			done: 2,
			points: { total: 13, done: 8 },
			progress: 50,
			overdue: 1,
			milestones: [
				{ id: 3, text: "仮縫い", due: D10, col: "doing" },
				{ id: 4, text: "納品", due: day(-2), col: "todo" },
			],
			blockers: [{ id: 5, text: "素材待ち", blocked: "生地が届かない" }],
			decisions: [
				{ id: 7, slug: "alpha", at: Date.now() - 7200000, text: "袖は付けない", why: "動きづらいから" },
			],
		},
	],
	decisions: [decision(9, "全部 LF")],
};

// 描き直しを観測するための別データ（名前が違い、決定もマイルストーンも無い）
const BARE = { ok: true, projects: [{ ...FULL.projects[0], name: "ベータ", milestones: [], blockers: [], decisions: [] }], decisions: [] };
async function open(data) {
	const d = await boot(data);
	d.byId["tab-projects"]._lis.click[0]();
	for (let i = 0; i < 4; i++) await flush();
	// #projects は renderProjects が初めて getElementById するので、開いた後に取る
	d.box = d.byId["projects"];
	return d;
}

// --- 2. 取り込みのタイミング ------------------------------------------------
test("#8 タブを開くまで /api/projects は叩かない", async () => {
	const d = await boot({ ok: true, projects: [], decisions: [] });
	assert.equal(d.calls.filter((u) => u.startsWith("/api/projects")).length, 0);
});

test("#8 開いたら 1 回だけ取りに行き、名前と未宣言を出す", async () => {
	const d = await open(FULL);
	assert.equal(d.calls.filter((u) => u.startsWith("/api/projects")).length, 1);
	const txt = allText(d.box);
	assert.ok(txt.includes("アルファ"), "name ではなく slug を出している");
	assert.ok(txt.includes("未宣言"), "未宣言バッジが読めない");
});

// --- 3. 描画の中身 ------------------------------------------------------------
test("#8 name が無ければ slug を出す", async () => {
	const d = await open({ ok: true, projects: [{ ...FULL.projects[0], name: undefined }], decisions: [] });
	assert.ok(allText(d.box).includes("alpha"), "name 欠落時に slug へ落ちていない");
});

test("#8 完了済みマイルストーンは赤くしない（看板と同じ規則）", async () => {
	// FULL の期限超過マイルストーンは todo（id 4）なので、まず赤が出ることを確かめる
	const red = await open(FULL);
	const hit = find(red.box, (e) => e.className === "x bad");
	assert.equal(hit && hit.textContent, "2日超過", "期限超過の行に bad が付いていない");
	// 同じ期限・同じ超過日数でも done なら色は付かない（文字は事実として残る）
	const done = await open({
		ok: true,
		// overdue は done を数えないので 0。フィクスチャ側で矛盾を作らない
		projects: [{ ...FULL.projects[0], overdue: 0, milestones: [{ id: 4, text: "納品", due: day(-2), col: "done" }] }],
		decisions: [],
	});
	assert.ok(!find(done.box, (e) => e.className === "x bad"), "完了済みが赤い");
	assert.ok(allText(done.box).includes("2日超過"), "超過日数の文字まで消している");
});

test("#8 宣言済みなら未宣言バッジを出さない", async () => {
	const d = await open({ ok: true, projects: [{ ...FULL.projects[0], declared: true }], decisions: [] });
	const txt = allText(d.box);
	assert.ok(txt.includes("アルファ"));
	assert.ok(!txt.includes("未宣言"), "宣言済みなのに未宣言バッジが出ている");
});

test("#8 見積があれば pt 比で描き、どちらの比か読める", async () => {
	const d = await open(FULL);
	const b = bar(d.box);
	assert.ok(b, "progressbar が無い");
	assert.equal(b.getAttribute("aria-valuenow"), "62", "8/13pt = 62%");
	assert.ok(b.getAttribute("aria-label").includes("62%"), "aria-label に値が無い");
	assert.equal(b.children[0].style.width, "62%");
	assert.ok(allText(d.box).includes("13pt 中 8pt"), "pt で描いたことが読めない");
});

test("#8 見積が無ければ枚数比（サーバの progress）で描く", async () => {
	const noPoints = {
		ok: true,
		projects: [{ ...FULL.projects[0], points: { total: 0, done: 0 } }],
		decisions: [],
	};
	const d = await open(noPoints);
	assert.equal(bar(d.box).getAttribute("aria-valuenow"), "50");
	assert.ok(allText(d.box).includes("4 枚中 2 枚"), "枚数で描いたことが読めない");
});

test("#8 マイルストーン・ブロッカー・決定ログが出る", async () => {
	const d = await open(FULL);
	const txt = allText(d.box);
	assert.ok(txt.includes("マイルストーン"), "見出しが無い");
	assert.ok(txt.includes("仮縫い") && txt.includes("あと10日"), "期限の残り日数が無い");
	// 日付そのもの（MM/DD）も出す。残り日数だけだと日付の整形を壊しても気づけない
	assert.ok(txt.includes(D10.slice(5, 10).replace("-", "/")), "マイルストーンの日付が無い");
	assert.ok(!txt.includes(D10), "生の ISO 日付を出している");
	assert.ok(txt.includes("2日超過"), "超過が読めない");
	assert.ok(txt.includes("生地が届かない"), "ブロッカーの理由が無い");
	assert.ok(txt.includes("決定ログ") && txt.includes("袖は付けない"), "決定ログが無い");
	assert.ok(txt.includes("なぜ: 動きづらいから"), "why が無い");
	assert.ok(txt.includes("期限超過 1"), "超過枚数のまとめが無い");
	assert.ok(txt.includes("2/4 枚"), "完了枚数/総枚数が読めない");
});

test("#8 空のセクションは見出しごと出さない（フォームは残す）", async () => {
	const bare = {
		ok: true,
		projects: [
			{ ...FULL.projects[0], milestones: [], blockers: [], decisions: [] },
		],
		decisions: [],
	};
	const d = await open(bare);
	const txt = allText(d.box);
	for (const h of ["マイルストーン", "ブロッカー", "決定ログ"]) {
		assert.ok(!txt.includes(h), `${h} の空見出しが残っている`);
	}
	assert.equal(buttons(d.box, "追記").length, 2, "プロジェクト毎 + 横断のフォームが要る");
});

test("#8 横断ログは slug 空の決定で、プロジェクトが 0 件でも書ける", async () => {
	const d = await open({ ok: true, projects: [], decisions: [decision(9, "全部 LF")] });
	const txt = allText(d.box);
	assert.ok(txt.includes("全部 LF"), "横断の決定が無い");
	assert.ok(txt.includes("プロジェクト横断"), "横断の見出しが無い");
	assert.ok(find(d.box, (e) => e.className === "empty" && e.innerHTML.includes("プロジェクトはまだ無い")), "空状態が無い");
	assert.equal(buttons(d.box, "追記").length, 1, "0 件でもフォームは 1 つ残る");
});

// --- 3.5 決定ログ（#9） ---------------------------------------------------------
// 本文セル（span.t）の完全一致で行を引く。includes で探すと別の行に誤爆して TypeError になる
const rowOf = (d, text) =>
	find(d.box, (e) => e.className === "prow" && e.children.some((c) => c.className === "t" && c.textContent === text));
const delBtn = (row) => row.children.find((c) => c.tagName === "BUTTON");

test("#9 決定の削除は確認してから送る（キャンセルでは送らない）", async () => {
	const d = await open(FULL);
	const row = rowOf(d, "袖は付けない");
	assert.ok(row, "決定の行が無い");
	d.window.confirm = () => false;
	const before = d.calls.length;
	delBtn(row)._lis.click[0]();
	for (let i = 0; i < 4; i++) await flush();
	assert.equal(d.calls.slice(before).filter((u) => u.includes("action=delete")).length, 0, "キャンセルしたのに削除を送った");

	d.window.confirm = () => true;
	delBtn(row)._lis.click[0]();
	for (let i = 0; i < 4; i++) await flush();
	const url = d.calls.slice(before).find((u) => u.includes("action=delete"));
	assert.ok(url, "確認後に削除を送っていない");
	assert.equal(q(url).get("id"), "7");
});

test("#9 確認の文言に決定の本文が入る（どれを消すのか読める）", async () => {
	const d = await open(FULL);
	let asked = null;
	d.window.confirm = (msg) => { asked = msg; return false; };
	const row = rowOf(d, "袖は付けない");
	assert.ok(row, "決定の行が無い");
	delBtn(row)._lis.click[0]();
	for (let i = 0; i < 4; i++) await flush();
	assert.ok(asked && asked.includes("袖は付けない"), "確認の文言に本文が無い: " + asked);
});

test("#9 件数は 1 回だけ出る（プロジェクト毎は要約行、横断は見出し）", async () => {
	// 2 件にしておく: ds.length を 1 に固定する変異を落とすため
	const two = {
		ok: true,
		projects: [
			{
				...FULL.projects[0],
				decisions: [FULL.projects[0].decisions[0], { id: 8, slug: "alpha", at: Date.now(), text: "二つ目" }],
			},
		],
		decisions: [decision(9, "全部 LF")],
	};
	const d = await open(two);
	const txt = allText(d.box);
	assert.ok(txt.includes("決定 2 件"), "要約行に件数が無い: " + txt);
	const heads = all(d.box, (e) => e.className === "hd").map((e) => e.textContent);
	// 先に重複を見る: 「決定ログ」の完全一致を先に置くと、見出しに数字が戻った時に
	// 「見出しが無い」という誤解を招くメッセージで落ちる
	assert.ok(!heads.some((h) => /^決定ログ \d/.test(h)), "同じ件数を 2 回出している: " + heads.join(" / "));
	assert.ok(heads.includes("決定ログ"), "プロジェクトの見出しが無い: " + heads.join(" / "));
	assert.ok(heads.includes("プロジェクト横断 1"), "横断の件数が無い: " + heads.join(" / "));
});

test("#9 削除ボタンは title と aria-label の両方を持つ（accname が「×」にならない）", async () => {
	const d = await open(FULL);
	const row = rowOf(d, "袖は付けない");
	assert.ok(row, "決定の行が無い");
	const b = delBtn(row);
	assert.equal(b.getAttribute("aria-label"), "この決定を削除");
	assert.equal(b.title, "この決定を削除");
});

test("#9 フォームのラベルは書き込み先が読める（同じラベルが 2 つ並ばない）", async () => {
	const d = await open(FULL);
	const labels = all(d.box, (e) => e.tagName === "INPUT").map((e) => e.getAttribute("aria-label"));
	assert.equal(new Set(labels).size, labels.length, "同じラベルの入力欄がある: " + labels.join(" / "));
	assert.ok(labels.includes("決定（本文）— プロジェクト alpha"), labels.join(" / "));
	assert.ok(labels.includes("決定（本文）— プロジェクト横断"), labels.join(" / "));
});

test("#9 決定が 0 件でも要約行に件数が出る（見出しは消える）", async () => {
	const d = await open({ ok: true, projects: [{ ...FULL.projects[0], decisions: [] }], decisions: [] });
	const txt = allText(d.box);
	assert.ok(txt.includes("決定 0 件"), "0 件のとき件数が読めない");
	assert.ok(!txt.includes("決定ログ"), "0 件なのに見出しが出ている");
});

// --- 3.7 取り込みの失敗と多重取得（#10） ---------------------------------------

test("#10 取得に失敗しても前回の表示を消さない（「空」と「取れなかった」を取り違えない）", async () => {
	const d = await open(FULL);
	assert.ok(allText(d.box).includes("アルファ"), "前提: 初回は描けている");
	// fake DOM の innerHTML="" は子を消さないので、「消えていない」ではなく
	// 「1 文字も変わっていない」で確かめる（空と「取れなかった」を取り違えない契約）
	const before = allText(d.box);
	d.ctl.projectsFetch = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
	d.byId["tab-projects"]._lis.click[0]();
	for (let i = 0; i < 4; i++) await flush();
	assert.equal(allText(d.box), before, "失敗で表示が変わった");
	// 「何もしていないから変わらない」で通るテストにしない。失敗の通知が出たことを先に見る
	assert.equal(d.byId.note.textContent, "プロジェクトを取得できません", "失敗の通知が出ていない");
	// 失敗しても busy は解ける。解けないと loadProjects は 1434 行で永久に return し、
	// 5 秒ごとの reload() が呼び続けてもタブは再読み込みまで固まる
	const n = d.ctl.projectsCalls;
	d.ctl.projectsFetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(BARE) });
	d.byId["tab-projects"]._lis.click[0]();
	for (let i = 0; i < 4; i++) await flush();
	assert.equal(d.ctl.projectsCalls, n + 1, "失敗後に busy が解けていない（以後取りに行かない）");
	// before ではなく BARE で見る。同じ内容だと fake DOM の innerHTML 未実装で子が残り、
	// 描画を消しても通る空虚な assert になる
	assert.ok(allText(d.box).includes("ベータ"), "失敗後に復帰して描けていない");
});

test("#10 取得中に再要求しても積み増さない（古い応答で新しい表示を塗り替えない）", async () => {
	const d = await boot(FULL);
	let resolve1;
	d.ctl.projectsFetch = () => new Promise((r) => (resolve1 = r));
	// 1 回目を宙吊りにしてから、もう 2 回タブを押す
	d.byId["tab-projects"]._lis.click[0]();
	await flush();
	d.byId["tab-projects"]._lis.click[0]();
	d.byId["tab-projects"]._lis.click[0]();
	for (let i = 0; i < 4; i++) await flush();
	assert.equal(d.ctl.projectsCalls, 1, "取得中の多重 fetch");
	// 1 回目が返れば描ける（busy フラグが立ちっぱなしにならない）
	resolve1({ ok: true, status: 200, json: () => Promise.resolve(FULL) });
	for (let i = 0; i < 4; i++) await flush();
	assert.ok(allText(d.byId.projects).includes("アルファ"), "応答が返っても描いていない");
	// 次は普通に取りに行ける
	d.ctl.projectsFetch = null;
	d.byId["tab-projects"]._lis.click[0]();
	for (let i = 0; i < 4; i++) await flush();
	assert.equal(d.ctl.projectsCalls, 2, "完了後に busy が解けていない");
});

// 決定の本文を打っている最中にポーリングが来たら、データだけ差し替えて描画は次に回す
test("#10 決定を打っている間は描き直さず、打ち終わってから描く", async () => {
	const d = await open(FULL);
	// フォームは <form> ではなく div.pform（ボードの他ペインと同じ作り）
	const form = find(d.box, (e) => e.className === "pform");
	assert.ok(form, "決定のフォームが無い");
	const input = find(form, (e) => e.tagName === "TEXTAREA" || e.tagName === "INPUT");
	assert.ok(input, "入力欄が無い");
	// isEditing() は activeElement と closest だけ見るので、素のオブジェクトで足りる
	input.closest = () => d.box;
	d.ctl.document.activeElement = input;
	try {
		d.ctl.projectsFetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(BARE) });
		d.byId["tab-projects"]._lis.click[0]();
		for (let i = 0; i < 4; i++) await flush();
		// 描き直していれば BARE（ベータ）が現れる。fake DOM は子を消さないので
		// 「古いのが残っている」ではなく「新しいのが出ていない」で見る
		assert.ok(!allText(d.box).includes("ベータ"), "打っている最中に描き直している（入力が消える）");
	} finally {
		d.ctl.document.activeElement = d.ctl.document.body;
	}
	// 打ち終われば次で描かれる（データはもう取得済み）
	d.byId["tab-projects"]._lis.click[0]();
	for (let i = 0; i < 4; i++) await flush();
	const after = allText(d.byId.projects);
	assert.ok(after.includes("ベータ"), "打ち終わっても描いていない（新しいデータが反映されていない）");
	// fake DOM の innerHTML="" は子を消さない（既知）ので、「古いのが消えた」ではなく
	// 「新しいデータが出た」で確かめる。決定 0 件 は BARE でしか出ない行
	assert.ok(after.includes("決定 0 件"), "打ち終わっても新しいデータで描き直していない");
});

// --- 4. 書き込み ---------------------------------------------------------------
test("#8 決定の追記は本文と slug を送る", async () => {
	const d = await open(FULL);
	const form = find(d.box, (e) => e.className === "pform");
	const [text, why] = form.children.filter((c) => c.tagName === "INPUT");
	text.value = "  裏地は外す  ";
	why.value = "暑いから";
	const before = d.calls.length;
	buttons(d.box, "追記")[0]._lis.click[0]();
	for (let i = 0; i < 4; i++) await flush();
	const url = d.calls.slice(before).find((u) => u.startsWith("/api/decision"));
	assert.ok(url, "追記のリクエストが無い");
	const p = q(url);
	assert.equal(p.get("text"), "裏地は外す", "前後の空白は落とす");
	assert.equal(p.get("why"), "暑いから");
	assert.equal(p.get("project"), "alpha");
});

test("#8 横断フォームは project を付けない", async () => {
	const d = await open(FULL);
	const form = all(d.box, (e) => e.className === "pform").pop();
	form.children.filter((c) => c.tagName === "INPUT")[0].value = "全部 LF";
	const before = d.calls.length;
	buttons(d.box, "追記")[1]._lis.click[0]();
	for (let i = 0; i < 4; i++) await flush();
	const p = q(d.calls.slice(before).find((u) => u.startsWith("/api/decision")));
	assert.equal(p.get("project"), null, "slug 空は project を送らない");
});

test("#8 決定の削除は action=delete と id を送る", async () => {
	const d = await open(FULL);
	const before = d.calls.length;
	buttons(d.box, "\u00D7")[0]._lis.click[0]();
	for (let i = 0; i < 4; i++) await flush();
	const url = d.calls.slice(before).find((u) => u.startsWith("/api/decision"));
	assert.ok(url, "削除のリクエストが無い");
	assert.equal(q(url).get("action"), "delete");
	assert.equal(q(url).get("id"), "7");
});
