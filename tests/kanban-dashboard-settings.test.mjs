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

// #17: 設定ペインの行は GLOBAL とこのプロジェクトの 2 つだけ。
// project は停止中（halted: true）で 3 回使っている。
const DASH = {
	host: "t",
	now: new Date().toISOString(),
	stats: { todo: 2, doing: 3, done: 1, serve: 0, media: 0 },
	global: {
		counts: { todo: 1, doing: 1, done: 0 },
		modes: { doingLoop: true, autoPick: false, intervalMin: 7, maxLoops: 10 },
		cards: [{ id: 21, text: "g", col: "doing" }],
		loops: 0,
		halted: false,
	},
	project: {
		id: "alpha",
		modes: { doingLoop: false, autoPick: true, intervalMin: 10, maxLoops: 3 },
		counts: { todo: 1, doing: 1, done: 0 },
		cards: [
			{ id: 1, text: "a", col: "todo" },
			{ id: 4, text: "d", col: "doing" },
		],
		loops: 3,
		halted: true,
	},
	serve: [],
	db: DB,
};

async function boot({ dash = DASH, selftest, hold = false, diagnose, vacuum, holdDb = null, dbReject = null } = {}) {
	const byId = {};
	const urls = [];
	const held = [];
	let selftestAt = 0;
	const dbAt = { diagnose: 0, vacuum: 0 };
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
			if (url.includes("/api/db/")) {
				// #13: 通信そのものが失敗する経路（throw 側の後始末を見るため）。
				if (dbReject) return Promise.reject(new Error("boom"));
				// #13: DB メンテは書き込み（VACUUM はファイルを触る）ので POST でなければならない。
				assert.equal(init && init.method, "POST", "db メンテが POST で叩かれていない");
				const action = url.includes("/api/db/vacuum") ? "vacuum" : "diagnose";
				dbAt[action] += 1;
				const body = action === "vacuum"
					? { ok: true, status: 200, json: () => Promise.resolve(vacuum) }
					: { ok: true, status: 200, json: () => Promise.resolve(diagnose) };
				if (holdDb === action) return new Promise((res) => held.push(() => res(body)));
				return Promise.resolve(body);
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
	return {
		byId,
		urls,
		state,
		selftestCount: () => selftestAt,
		dbCount: (action) => dbAt[action],
		release: () => held.forEach((f) => f()),
	};
}

const rows = (byId) => all(byId["settings-loops"], (e) => e.className === "srow");
const rowLabels = (byId) => all(byId["settings-loops"], (e) => e.className === "rowlabel").map((e) => e.textContent);
const writeButtons = (root) =>
	all(root, (n) => n._lis.click && n._lis.click.length && (n.className.includes("mini") || n.className.includes("sw")));

// --- 行の並び ---------------------------------------------------------------
test("#11: 設定ペインに GLOBAL 先頭で GLOBAL とこのプロジェクトの 2 行が並ぶ", async () => {
	const { byId } = await boot();
	assert.deepEqual(rowLabels(byId), ["GLOBAL（全プロジェクト共有）", "このプロジェクト（alpha）"]);
	// 各ボードに ctl（ループ/ピック/間隔/上限/DOING 全停止）が 1 つずつ
	const ctls = all(byId["settings-loops"], (e) => e.className === "ctl");
	assert.equal(ctls.length, 2);
});

test("#11: ボード本体（global / project）からは ctl が消えている", async () => {
	const { byId } = await boot();
	assert.equal(all(byId["project"], (e) => e.className === "ctl").length, 0, "project ボードに ctl が残っている");
	assert.equal(all(byId["global"], (e) => e.className === "ctl").length, 0, "GLOBAL に ctl が残っている");
});

// --- 書き込み先のボード ------------------------------------------------------
test("#11: 設定行の書き込みはそのボードの scope= を載せる（#17: sid は送らない）", async () => {
	const { byId, urls } = await boot();
	const want = [
		null, // GLOBAL 行は読み取り専用（boardCtx の active=false）。書き込みが出ないのが正しい
		"scope=project",
	];
	const list = rows(byId);
	assert.equal(list.length, 2);
	for (let i = 0; i < list.length; i++) {
		const start = urls.length;
		for (const b of writeButtons(list[i])) {
			b._lis.click[0]();
			await flush();
		}
		const wrote = urls.slice(start).filter((u) => !u.startsWith("/api/dashboard"));
		if (want[i] === null) {
			assert.equal(wrote.length, 0, `GLOBAL 行で書き込みが出た: ${wrote.slice(0, 2)}`);
			continue;
		}
		assert.ok(wrote.length >= 5, `行 ${i} の書き込みが少なすぎる: ${wrote.length}`);
		const scope = want[i];
		for (const u of wrote) {
			assert.ok(u.includes(scope), `scope が違う: ${u}`);
			assert.ok(!u.includes("sid="), `project なのに sid を送っている: ${u}`);
		}
	}
});

test("#11: 停止中の行には理由を添える（スイッチだけ見て効くと思わせない）", async () => {
	const { byId } = await boot();
	const [global, project] = rows(byId);
	assert.equal(all(global, (e) => e.className === "halt").length, 0, "GLOBAL に halt がある");
	const halt = all(project, (e) => e.className === "halt");
	assert.equal(halt.length, 1, "停止中の project 行に halt が無い");
	// #17: 停止の理由（文字列）は session 行と一緒に消えた。bool だけを見て「止まっている」
	// ことと解除先を示す。
	const spoken = texts(halt[0]).join(" ");
	assert.match(spoken, /ループ停止中/, `文言が違う: ${spoken}`);
	assert.match(spoken, /再開/, `解除の導線が無い: ${spoken}`);
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
	// 連打してもモジュールフラグで 1 回
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

// --- #13 DB メンテ（診断 / VACUUM）--------------------------------------------
const dbButtons = (byId) => all(byId["settings-db"], (n) => n.tagName === "BUTTON");
const dbResultNodes = (byId) => all(byId["settings-db"], (n) => n.id === "settings-db-result");
const DIAGNOSE = {
	ok: true,
	integrity: "ok",
	pages: 24,
	freelist: 0,
	pageSize: 4096,
	bytes: 4096,
	file: "boards.sqlite",
	boards: 3,
	cards: 6,
	projects: 2,
	decisions: 4,
};

test("#13: 保存データに DB 診断 / VACUUM のボタンと結果行がある", async () => {
	const { byId } = await boot({ diagnose: DIAGNOSE });
	assert.deepEqual(dbButtons(byId).map((b) => b.textContent), ["DB 診断", "VACUUM"]);
	const res = dbResultNodes(byId);
	assert.equal(res.length, 1, `結果行が ${res.length} 個ある`);
	assert.equal(res[0].getAttribute("aria-live"), "polite");
});

test("#13: DB 診断は POST /api/db/diagnose を 1 回だけ叩き、数値を出す", async () => {
	const { byId, urls, dbCount } = await boot({ diagnose: DIAGNOSE });
	const first = dbButtons(byId)[0];
	first._lis.click[0]();
	first._lis.click[0](); // 連打
	for (let i = 0; i < 6; i++) await flush();
	assert.equal(dbCount("diagnose"), 1, `診断を ${dbCount("diagnose")} 回叩いた`);
	assert.equal(dbCount("vacuum"), 0);
	assert.ok(urls.includes("/api/db/diagnose"));
	const shown = texts(byId["settings-db"]);
	assert.ok(shown.includes("整合性 ok / ページ 24 / 空き 0 / 4.0 KB"), `表示が違う: ${shown.join(" / ")}`);
	// 診断の数値は自前で作らず、サーバの数字（reload）を取り直す
	assert.ok(urls.filter((u) => u.startsWith("/api/dashboard")).length > 0);
});

// #13 (BLOCK): 実行中フラグは btn() の flightGate ではなくモジュールに持つ。flightGate は
// ボタンの DOM ノードに残るので、5 秒ポーリングの再描画で新品ノードが生えると 2 回目が通る。
test("#13: 実行中に再描画されても診断の再送は起きない", async () => {
	const { byId, state, dbCount, release } = await boot({ diagnose: DIAGNOSE, holdDb: "diagnose" });
	dbButtons(byId)[0]._lis.click[0]();
	for (let i = 0; i < 2; i++) await flush();
	assert.equal(dbCount("diagnose"), 1, `1 回目のクリックで ${dbCount("diagnose")} 回叩いた`);

	// 5 秒ポーリング相当の再描画（render → renderSettings → renderDb）
	state.dash = { ...DASH, stats: { ...DASH.stats, todo: 99 } };
	writeButtons(rows(byId)[1])[0]._lis.click[0]();
	for (let i = 0; i < 6; i++) await flush();

	// モック DOM は box.innerHTML = "" を再現しないので、最新のノード（末尾）が今のボタン。
	const now = dbButtons(byId);
	const [diag, vac] = now.slice(-2);
	assert.equal(diag.disabled, true, "実行中なのに再描画後の診断ボタンが有効");
	assert.equal(vac.disabled, true, "実行中なのに再描画後の VACUUM ボタンが有効");
	if (diag._lis.click) diag._lis.click[0]();
	if (vac._lis.click) vac._lis.click[0]();
	for (let i = 0; i < 2; i++) await flush();
	assert.equal(dbCount("diagnose"), 1, `再描画後に再送した（${dbCount("diagnose")} 回）`);
	assert.equal(dbCount("vacuum"), 0, "実行中に VACUUM が通った");

	release();
	for (let i = 0; i < 6; i++) await flush();
	const down = dbButtons(byId).slice(-2);
	assert.deepEqual(down.map((b) => b.disabled), [false, false], "完了後もボタンが死んでいる");
	assert.ok(texts(byId["settings-db"]).includes("整合性 ok / ページ 24 / 空き 0 / 4.0 KB"));
});

test("#13: VACUUM は before → after と削減率を出す", async () => {
	const { byId, dbCount } = await boot({
		vacuum: { ok: true, before: 4096, after: 3600, saved: 496, file: "boards.sqlite", boards: 3, cards: 6, projects: 2, decisions: 4 },
	});
	dbButtons(byId)[1]._lis.click[0]();
	for (let i = 0; i < 6; i++) await flush();
	assert.equal(dbCount("vacuum"), 1, `VACUUM を ${dbCount("vacuum")} 回叩いた`);
	assert.equal(dbCount("diagnose"), 0);
	const shown = texts(byId["settings-db"]);
	assert.ok(shown.includes("4.0 KB → 3.5 KB（-12%）"), `表示が違う: ${shown.join(" / ")}`);
});

test("#13: 縮まなかった VACUUM は「変化なし」と言う", async () => {
	const { byId, dbCount } = await boot({ vacuum: { ok: true, before: 4096, after: 4096, saved: 0 } });
	dbButtons(byId)[1]._lis.click[0]();
	for (let i = 0; i < 6; i++) await flush();
	assert.equal(dbCount("vacuum"), 1);
	assert.ok(texts(byId["settings-db"]).includes("4.0 KB（変化なし）"), texts(byId["settings-db"]).join(" / "));
});

test("#13: VACUUM が 500 で落ちたら本文を NG として出す", async () => {
	const { byId, dbCount } = await boot({ vacuum: { ok: false, error: "database is locked" } });
	dbButtons(byId)[1]._lis.click[0]();
	for (let i = 0; i < 6; i++) await flush();
	assert.equal(dbCount("vacuum"), 1);
	assert.ok(texts(byId["settings-db"]).includes("NG database is locked"), texts(byId["settings-db"]).join(" / "));
});

test("#13: 診断が 503（整合性 NG）でも本文を出す", async () => {
	const { byId, dbCount } = await boot({
		diagnose: { ok: false, integrity: "unavailable", pages: 0, freelist: 0, pageSize: 0, bytes: 0 },
	});
	dbButtons(byId)[0]._lis.click[0]();
	for (let i = 0; i < 6; i++) await flush();
	assert.equal(dbCount("diagnose"), 1);
	assert.ok(texts(byId["settings-db"]).includes("NG 整合性 unavailable"), texts(byId["settings-db"]).join(" / "));
});

// #13: 通信が失敗した時も dbBusy を解放する。解放しないとボタンが二度と押せなくなる。
test("#13: DB メンテの通信が失敗してもボタンは復活する", async () => {
	const { byId } = await boot({ dbReject: true });
	dbButtons(byId)[1]._lis.click[0]();
	for (let i = 0; i < 6; i++) await flush();
	assert.deepEqual(
		dbButtons(byId).slice(-2).map((b) => b.disabled),
		[false, false],
		"失敗したままボタンが無効化されている",
	);
	assert.ok(
		dbResultNodes(byId).map((n) => n.textContent).join("").includes("NG 実行できません"),
		"失敗理由が結果行に出ていない",
	);
});
