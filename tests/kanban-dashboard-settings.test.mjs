// #11 設定タブ（ボードのループ集約 / 保存データ / 自己診断）の自己検証。
// サーバは要らない: web/dashboard.html を直接読み、ブラウザ側 JS を vm で走らせる。
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
		disabled: false,
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
const texts = (n) => all(n, (e) => typeof e.textContent === "string" && e.textContent !== "").map((e) => e.textContent);

const DB = { file: "boards.sqlite", bytes: 123456, boards: 3, cards: 6, projects: 2, decisions: 4 };

// GLOBAL + 2 セッション。s1 は上限で停止中（#58 の文言が設定行にも出る）。
const DASH = {
	host: "t",
	now: new Date().toISOString(),
	stats: { sessions: 2, active: 1, todo: 2, doing: 3, done: 1, serve: 0, media: 0 },
	global: {
		counts: { todo: 1, doing: 1, done: 0 },
		modes: { doingLoop: true, autoPick: false, intervalMin: 7, maxLoops: 10 },
		cards: [{ id: 21, text: "g", col: "doing" }],
	},
	sessions: [
		{
			id: "s1",
			name: "kotomi",
			cwd: "/tmp",
			isActive: true,
			updatedAt: "2026-01-01T00:00:00.000Z",
			modes: { session: { doingLoop: false, autoPick: true, intervalMin: 10, maxLoops: 3 }, global: {} },
			counts: { todo: 1, doing: 1, done: 0 },
			cards: [
				{ id: 1, text: "a", col: "todo" },
				{ id: 4, text: "d", col: "doing" },
			],
			halted: { halted: "limit" },
			loops: 3,
		},
		{
			id: "s2",
			name: "other",
			cwd: "/tmp",
			isActive: false,
			updatedAt: "2026-01-01T00:00:00.000Z",
			modes: { session: { doingLoop: true, autoPick: true, intervalMin: 5 }, global: {} },
			counts: { todo: 0, doing: 1, done: 0 },
			cards: [{ id: 3, text: "c", col: "doing" }],
			halted: null,
			loops: 0,
		},
	],
	serve: [],
	db: DB,
};

async function boot({ dash = DASH, selftest, hold = false } = {}) {
	const byId = {};
	const urls = [];
	const held = [];
	let selftestAt = 0;
	const document = {
		getElementById: (id) => byId[id] || (byId[id] = makeEl("div")),
		createElement: (t) => makeEl(t),
		createTextNode: (t) => Object.assign(makeEl("#text"), { textContent: String(t) }),
		documentElement: makeEl("html"),
	};
	const state = { dash };
	const reply = (body) => ({ ok: true, status: 200, json: () => Promise.resolve(body) });
	const sandbox = {
		document,
		window: { confirm: () => true },
		URL,
		localStorage: { getItem: () => null, setItem() {} },
		matchMedia: () => ({ matches: false, addEventListener() {} }),
		fetch: (u, init) => {
			const url = String(u);
			urls.push(url);
			if (url.includes("/api/selftest")) {
				// 自己診断は書き込み（サーバ側で走らせる）ので POST でなければならない。
				assert.equal(init && init.method, "POST", "selftest が POST で叩かれていない");
				selftestAt += 1;
				// NG は 503 で返る（本文は正常な診断結果）。api() は通せない理由。
				const body = () => ({ ok: false, status: 503, json: () => Promise.resolve(selftest) });
				// hold: 応答を止めたまま（実行中の再描画を再現する）
				if (hold) return new Promise((res) => held.push(() => res(body())));
				return Promise.resolve(body());
			}
			return Promise.resolve(reply(state.dash));
		},
		setTimeout: () => 0,
		clearTimeout() {},
		console,
	};
	vm.createContext(sandbox);
	vm.runInContext(JS, sandbox);
	for (let i = 0; i < 4; i++) await flush();
	return { byId, urls, state, selftestCount: () => selftestAt, release: () => held.forEach((f) => f()) };
}

const rows = (byId) => all(byId["settings-loops"], (e) => e.className === "srow");
const rowLabels = (byId) => all(byId["settings-loops"], (e) => e.className === "rowlabel").map((e) => e.textContent);
const writeButtons = (root) =>
	all(root, (n) => n._lis.click && n._lis.click.length && (n.className.includes("mini") || n.className.includes("sw")));

// --- 行の並び ---------------------------------------------------------------
test("#11: 設定ペインに GLOBAL 先頭で全ボードの行が並ぶ", async () => {
	const { byId } = await boot();
	assert.deepEqual(rowLabels(byId), ["GLOBAL（全セッション共有）", "kotomi", "other"]);
	// 各ボードに ctl（ループ/ピック/間隔/上限/DOING 全停止）が 1 つずつ
	const ctls = all(byId["settings-loops"], (e) => e.className === "ctl");
	assert.equal(ctls.length, 3);
});

test("#11: セッションカードと GLOBAL ボードからは ctl が消えている", async () => {
	const { byId } = await boot();
	assert.equal(all(byId["sessions"], (e) => e.className === "ctl").length, 0, "セッションカードに ctl が残っている");
	assert.equal(all(byId["global"], (e) => e.className === "ctl").length, 0, "GLOBAL に ctl が残っている");
});

// --- 書き込み先のボード ------------------------------------------------------
test("#11: 設定行の書き込みはそのボードの scope= / sid= を載せる", async () => {
	const { byId, urls } = await boot();
	const want = [
		["kotomi", "scope=global", "sid=s1"], // GLOBAL の modes は active sid で引く（従来どおり）
		["kotomi", "scope=session", "sid=s1"],
		["other", "scope=session", "sid=s2"],
	];
	const list = rows(byId);
	assert.equal(list.length, 3);
	for (let i = 0; i < list.length; i++) {
		const start = urls.length;
		for (const b of writeButtons(list[i])) {
			b._lis.click[0]();
			await flush();
		}
		const wrote = urls.slice(start).filter((u) => !u.startsWith("/api/dashboard"));
		assert.ok(wrote.length >= 5, `行 ${i} の書き込みが少なすぎる: ${wrote.length}`);
		const [, scope, sid] = want[i];
		for (const u of wrote) {
			assert.ok(u.includes(scope), `scope が違う: ${u}`);
			assert.ok(u.includes(sid), `sid が違う: ${u}`);
			assert.ok(u.includes("&"), u);
		}
	}
});

test("#11: 停止中の行には理由を添える（スイッチだけ見て効くと思わせない）", async () => {
	const { byId } = await boot();
	const [global, s1, s2] = rows(byId);
	assert.equal(all(global, (e) => e.className === "halt").length, 0, "GLOBAL に halt がある");
	assert.equal(all(s2, (e) => e.className === "halt").length, 0, "停止していない s2 に halt がある");
	const halt = all(s1, (e) => e.className === "halt");
	assert.equal(halt.length, 1, "s1 の halt が無い");
	assert.match(halt[0].textContent, /ループ上限（3回）/, `上限の回数が違う: ${halt[0].textContent}`);
});

// --- 保存データ --------------------------------------------------------------
test("#11: d.db があるとサイズと件数を出す", async () => {
	const { byId } = await boot();
	const shown = texts(byId["settings-db"]);
	assert.ok(shown.includes("boards.sqlite"), "ファイル名が無い");
	assert.ok(shown.includes("120.6 KB"), `サイズ表記が違う: ${shown.join(" / ")}`);
	assert.ok(
		shown.some((t) => t === "ボード 3 / カード 6 / プロジェクト 2 / 決定 4"),
		`件数が違う: ${shown.join(" / ")}`,
	);
	assert.ok(!shown.join(" ").includes("/tmp"), "絶対パスを出している");
});

test("#11: d.db が無い（旧サーバー）と何も描かない", async () => {
	const dash = { ...DASH };
	delete dash.db;
	const { byId } = await boot({ dash });
	assert.equal(byId["settings-db"].children.length, 0, "db が無いのに何か描いている");
});

// --- 自己診断 ----------------------------------------------------------------
test("#11: 診断ボタンは POST /api/selftest を 1 回だけ叩き、OK を出す", async () => {
	const { byId, urls, selftestCount } = await boot({
		selftest: { ok: true, checks: [{ name: "boards", ok: true }, { name: "modes", ok: true }] },
	});
	const btn = writeButtons(byId["settings-selftest"])[0];
	assert.ok(btn, "診断ボタンが無い");
	// 連打しても flightGate で 1 回
	btn._lis.click[0]();
	btn._lis.click[0]();
	for (let i = 0; i < 6; i++) await flush();
	assert.equal(selftestCount(), 1, `selftest を ${selftestCount()} 回叩いた`);
	assert.ok(urls.includes("/api/selftest"));
	assert.ok(texts(byId["settings-selftest"]).some((t) => t === "OK（2 件）"), texts(byId["settings-selftest"]).join(" / "));
});

test("#11: 503（NG）の本文も通常の結果として表示する", async () => {
	const { byId, selftestCount } = await boot({
		selftest: { ok: false, checks: [{ name: "boards", ok: false }, { name: "modes", ok: true }] },
	});
	writeButtons(byId["settings-selftest"])[0]._lis.click[0]();
	for (let i = 0; i < 6; i++) await flush();
	assert.equal(selftestCount(), 1);
	const shown = texts(byId["settings-selftest"]);
	assert.ok(shown.some((t) => t === "NG: boards"), `NG の表示が無い: ${shown.join(" / ")}`);
});

// #11 (BLOCK): 実行中フラグは btn() の flightGate ではなくモジュールに持つ。flightGate は
// ボタンの DOM ノードに残るので、5 秒ポーリングの再描画で新品ノードが生えると 2 回目が通る。
test("#11: 実行中に再描画されても診断の再送は起きない", async () => {
	const { byId, state, selftestCount, release } = await boot({
		selftest: { ok: true, checks: [{ name: "boards", ok: true }] },
		hold: true,
	});
	const first = writeButtons(byId["settings-selftest"]);
	assert.equal(first.length, 1, "診断ボタンが無い");
	first[0]._lis.click[0]();
	for (let i = 0; i < 2; i++) await flush();
	assert.equal(selftestCount(), 1, `1 回目のクリックで ${selftestCount()} 回叩いた`);

	// 5 秒ポーリング相当の再描画（render → renderSettings → renderSelfTest）
	state.dash = { ...DASH, stats: { ...DASH.stats, todo: 99 } };
	writeButtons(rows(byId)[1])[0]._lis.click[0]();
	for (let i = 0; i < 6; i++) await flush();

	// モック DOM は box.innerHTML = "" を再現しないので、最新のノード（末尾）が今のボタン。
	const nowBtn = () => {
		const list = all(byId["settings-selftest"], (n) => n.tagName === "BUTTON");
		assert.ok(list.length, "再描画後に診断ボタンが無い");
		return list[list.length - 1];
	};
	const b2 = nowBtn();
	if (b2._lis.click) b2._lis.click[0](); // 旧実装はここで 2 回目が通る
	for (let i = 0; i < 2; i++) await flush();
	assert.equal(selftestCount(), 1, `再描画後に再送した（${selftestCount()} 回）`);
	assert.equal(b2.disabled, true, "実行中なのに再描画後のボタンが有効");

	release();
	for (let i = 0; i < 6; i++) await flush();
	assert.equal(nowBtn().disabled, false, "完了後もボタンが死んでいる");
	assert.ok(texts(byId["settings-selftest"]).some((t) => t === "OK（1 件）"), texts(byId["settings-selftest"]).join(" / "));
});

test("#11: 診断結果は再描画でも残る", async () => {
	const { byId, state } = await boot({ selftest: { ok: true, checks: [{ name: "boards", ok: true }] } });
	writeButtons(byId["settings-selftest"])[0]._lis.click[0]();
	for (let i = 0; i < 6; i++) await flush();
	// 中身が変わったデータで再描画させる（書き込み → reload → render）
	state.dash = { ...DASH, stats: { ...DASH.stats, todo: 99 } };
	writeButtons(rows(byId)[1])[0]._lis.click[0]();
	for (let i = 0; i < 6; i++) await flush();
	const shown = texts(byId["settings-selftest"]);
	assert.ok(shown.some((t) => t === "OK（1 件）"), `再描画で消えた: ${shown.join(" / ")}`);
});
