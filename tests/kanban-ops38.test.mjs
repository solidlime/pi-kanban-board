// #38 操作系 (3 インライン追加 / 4 カードへ画像ドロップ / 5 本文折り畳み /
// 6 キーボード操作 / 10 注入の DOING 経過時間 / 11 GUI の stale ⏳) の自己検証 (#011)。
// フレームワーク無しで `node tests/kanban-ops38.test.mjs`。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
// 実ブラウザ操作は #057 領域なので、ここは配信 HTML の文字列 + サーバ側の実応答まで。
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as netServer } from "node:net";
import { createRequire } from "node:module";

const HOME_DIR = "/tmp/kb-ops38-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/media`, { recursive: true });
process.env.HOME = HOME_DIR;
const PORT = await new Promise((resolve) => {
	const s = netServer();
	s.listen(0, "127.0.0.1", () => {
		const { port } = s.address();
		s.close(() => resolve(port));
	});
});
process.env.KANBAN_PORT = String(PORT);
const BASE = `http://127.0.0.1:${PORT}`;

const { createJiti } = createRequire(import.meta.url)(
	"/root/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.cjs",
);
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(new URL("../extensions/kanban.ts", import.meta.url).pathname);
const { renderInjectionText } = mod;

const failures = [];
let passed = 0;
async function check(name, fn) {
	try {
		await fn();
		passed += 1;
	} catch (err) {
		failures.push(`${name}: ${err.message}`);
	}
}

// --- サーバ起動 (このテスト専用ポート) ----------------------------------------
// board ツールの check アクションを実際に叩くため、registerTool の spec を保持する。
const toolSpecs = [];
const pi = {
	registerCommand() {},
	registerTool(spec) {
		toolSpecs.push(spec);
	},
	appendEntry() {},
	on() {},
	sendUserMessage() {},
};
mod.default(pi);
for (let i = 0; i < 40; i++) {
	try {
		if ((await fetch(`${BASE}/api/kanban`)).ok) break;
	} catch {
		// まだ listen していない
	}
	await new Promise((r) => setTimeout(r, 100));
}
// #67: /api/kanban.html is gone; the template is exported for the tests that pin it.
const html = mod.KANBAN_HTML;

// --- 3. インライン追加: + ボタン → 入力欄 → Enter で add ----------------------
await check("#38-3 + ボタンで入力欄を開き、Enter で add を送る", () => {
	assert.ok(html.includes('addBtn.className = "addbtn"'), "+ ボタン生成が無い");
	assert.ok(html.includes("addBtn.onclick = function(){ showInput(true); }"), "+ クリックで入力欄を開かない");
	assert.ok(html.includes("showInput(false);"), "初期状態で入力欄を閉じていない");
	assert.ok(html.includes('input.style.display = on ? "" : "none"'), "入力欄の表示切替が無い");
	assert.ok(html.includes('send(board, "add?col=" + col + "&text=" + encodeURIComponent(v))'), "Enter の add 送信が無い");
	assert.ok(html.includes('input.placeholder = "+ \\u8ffd\\u52a0"'), "追加プレースホルダが無い");
	assert.ok(html.includes('addBtn.setAttribute("aria-label"'), "+ ボタンの aria-label が無い");
});

// --- 4. カードに画像を落とす (クライアント側の配線) ---------------------------
await check("#38-4 カードへのファイル drop は id 付きで upload に渡す", () => {
	assert.ok(html.includes("function upload(board, col, file, id)"), "upload が id を受けていない");
	assert.ok(html.includes('(id === undefined ? "" : "&id=" + id)'), "upload が id を URL に付けていない");
	assert.ok(html.includes("upload(board, c.col, f, c.id);"), "カード drop がカード id を渡していない");
	assert.ok(html.includes('e.dataTransfer.types.indexOf("Files") < 0'), "ファイル以外の drop を弾いていない");
	assert.ok(html.includes("if (!f) return; // card move"), "カード移動 drag を素通ししていない");
});

// --- 4. サーバ側: id 付き upload は新規カードを作らず既存カードに紐付く -------
const SID = "ops38-session";
const boardFile = `${HOME_DIR}/.pi/kanban/sessions/${SID}.json`;
// upload の書き込みは scope=global を使う（#55 で scope=session も 403 にならなくなったが、
// このテストは GLOBAL 側の id 付き upload を見るので分岐を維持する）。
const globalFile = `${HOME_DIR}/.pi/kanban/global.json`;
const readCards = () => JSON.parse(readFileSync(boardFile, "utf8")).cards;
const readGlobal = () => JSON.parse(readFileSync(globalFile, "utf8")).cards;
writeFileSync(
	boardFile,
	JSON.stringify({ cards: [{ id: 1, text: "既存カード", col: "doing" }], nextId: 50 }, null, 2),
);
writeFileSync(
	globalFile,
	JSON.stringify({ cards: [{ id: 1, text: "既存カード", col: "doing" }], nextId: 50 }, null, 2),
);
// 1x1 PNG の最小バイト列 (media に書ければ中身は問わない)。
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	"base64",
);
await check("#38-4 /api/upload?id= は既存カードに紐付き、新規カードを作らない", async () => {
	const before = readGlobal().length;
	const r = await fetch(`${BASE}/api/upload?scope=global&ext=png&id=1`, {
		method: "POST",
		body: PNG,
		headers: { "Content-Type": "application/octet-stream" },
	});
	const j = await r.json();
	assert.equal(j.ok, true, JSON.stringify(j));
	const after = readGlobal();
	assert.equal(after.length, before, "id 指定なのにカードが増えた");
	const card = after.find((c) => c.id === 1);
	assert.ok(typeof card.img === "string" && card.img.endsWith(".png"), `img が付いていない: ${JSON.stringify(card)}`);
	assert.equal(card.text, "既存カード", "id 指定で本文が書き換わった");
});

// --- 5. 本文折り畳み ----------------------------------------------------------
await check("#38-5 60 字超は 3 行クランプ + クリックで開閉", () => {
	assert.ok(html.includes("-webkit-line-clamp:3"), "3 行クランプ CSS が無い");
	assert.ok(html.includes('tt.classList.add("clampable")'), "clampable 付与が無い");
	assert.ok(html.includes('(c.text || "").length > 60'), "長文判定が無い");
	assert.ok(html.includes('tt.classList.toggle("open")'), "クリック開閉が無い");
});

// --- 6. キーボード操作 --------------------------------------------------------
await check("#38-6 Tab で入り ←→ / Enter / m が効く", () => {
	assert.ok(html.includes("el.tabIndex = 0"), "カードが focus 可能でない");
	assert.ok(html.includes('e.key === "ArrowLeft" && ci > 0'), "← の列移動が無い");
	assert.ok(html.includes('e.key === "ArrowRight" && ci < COLS.length - 1'), "→ の列移動が無い");
	assert.ok(html.includes('e.key === "Enter"'), "Enter の処理が無い");
	assert.ok(html.includes('"move?id=" + c.id + "&col=doing"'), "Enter で DOING へ行かない");
	assert.ok(html.includes('e.key === "m"'), "m のメモ起動が無い");
	assert.ok(html.includes("if (e.target !== el) return;"), "子要素のキーを奪っている");
});

// --- 10. 注入の DOING 経過時間 (renderInjectionText は純関数) -----------------
await check("#38-10 DOING 行に movedAt から「N分前から」が出る", () => {
	const now = Date.now();
	const b = {
		cards: [
			{ id: 1, text: "作業中", col: "doing", movedAt: now - 5 * 60_000 },
			{ id: 2, text: "未着手", col: "todo" },
		],
		nextId: 3,
	};
	const out = renderInjectionText(b);
	assert.ok(out !== null, "注入テキストが null");
	const doingLine = out.split("\n").find((l) => l.startsWith("DOING"));
	assert.ok(doingLine.includes("(5分前から)"), `経過分が無い: ${doingLine}`);
	const todoLine = out.split("\n").find((l) => l.startsWith("TODO"));
	assert.ok(!todoLine.includes("分前から"), `TODO に経過が出た: ${todoLine}`);
});

await check("#38-10 movedAt 無しの DOING は何も足さない (「0分」を出さない)", () => {
	const out = renderInjectionText({ cards: [{ id: 1, text: "x", col: "doing" }], nextId: 2 });
	const doingLine = out.split("\n").find((l) => l.startsWith("DOING"));
	assert.ok(!doingLine.includes("分前から"), `未スタンプなのに経過が出た: ${doingLine}`);
});

// --- 11. GUI の stale ⏳ ------------------------------------------------------
await check("#38-11 2 時間超の DOING に ⏳ を付ける (削除はしない)", () => {
	assert.ok(html.includes("STALE_GUI_MS = 2 * 60 * 60 * 1000"), "stale 閾値が無い");
	assert.ok(html.includes('c.col === "doing" && typeof c.movedAt === "number"'), "DOING 判定が無い");
	assert.ok(html.includes("Date.now() - c.movedAt > STALE_GUI_MS"), "経過判定が無い");
	assert.ok(html.includes('st.textContent = "\u23f3"'), "⏳ の表示が無い");
	assert.ok(!/if \(.*STALE_GUI_MS.*\)\s*\{[^}]*remove/i.test(html), "stale カードを消している");
});

// --- 14. /api/kanban?fields= の射影 (既存呼び出しは無指定で不変) --------------
await check("#38-14 fields 射影は指定キーだけ返し、無指定は従来どおり", async () => {
	writeFileSync(
		boardFile,
		JSON.stringify(
			{ cards: [{ id: 7, text: "t", col: "todo", img: "x.png", priority: 3 }], nextId: 8 },
			null,
			2,
		),
	);
	const proj = await (await fetch(`${BASE}/api/kanban?sid=${SID}&fields=id,col,text`)).json();
	const c = proj.session.cards[0];
	assert.deepEqual(Object.keys(c).sort(), ["col", "id", "text"], `余計なキー: ${JSON.stringify(Object.keys(c))}`);
	assert.equal(c.id, 7);
	const full = await (await fetch(`${BASE}/api/kanban?sid=${SID}`)).json();
	assert.ok("img" in full.session.cards[0] && "priority" in full.session.cards[0], "無指定で射影された");
});

// --- 1/2. selftest (API とツール check が同じ JSON を返す) --------------------
await check("#38-1 /api/selftest は {ok, checks:[{name,ok,detail}]} を返す", async () => {
	const r = await fetch(`${BASE}/api/selftest`, { method: "POST" });
	const j = await r.json();
	assert.equal(typeof j.ok, "boolean");
	assert.ok(Array.isArray(j.checks) && j.checks.length >= 4, `checks が足りない: ${JSON.stringify(j)}`);
	for (const c of j.checks) {
		assert.equal(typeof c.name, "string");
		assert.equal(typeof c.ok, "boolean");
		assert.equal(typeof c.detail, "string");
	}
	const names = j.checks.map((c) => c.name).sort();
	assert.deepEqual(names, ["board", "media", "modes", "serve"], `層の名前: ${names}`);
});

// --- 1/2. selftest: API とツール check が同じ JSON を返す ---------------------
// ツール名は実装上 "kanban"（"board" ではない）。戻り値は content[0].text に JSON 文字列で
// 入る（details は scope/cards/nextId でレポートを含まない）。
await check("#38-2 board ツール check は /api/selftest と同じ JSON を返す", async () => {
	const spec = toolSpecs.find((s) => s.name === "kanban");
	assert.ok(spec, `kanban ツールが登録されていない: ${toolSpecs.map((s) => s.name).join(",")}`);
	const ctx = {
		hasUI: false,
		isIdle: () => true,
		ui: { notify() {}, setWidget() {} },
		sessionManager: {
			getSessionId: () => SID,
			getSessionName: () => "ops38",
			getEntries: () => [],
		},
	};
	const res = await spec.execute("test-call", { action: "check", scope: "session" }, undefined, undefined, ctx);
	assert.ok(!res.isError, `check が失敗した: ${res.content[0].text}`);
	const fromTool = JSON.parse(res.content[0].text);
	const fromApi = await (await fetch(`${BASE}/api/selftest`, { method: "POST" })).json();
	// 除外キーなし: selftest の detail に時刻・乱数は含まれない（board=activeSessionId と
	// ファイル数、modes/serve=パスと件数、media=パスと件数）。全て同じプロセス状態を見るので
	// 厳密一致で固定できる。
	assert.deepEqual(fromTool, fromApi, "ツール check と /api/selftest の JSON が違う");
	assert.equal(fromTool.ok, true, `selftest が落ちている: ${JSON.stringify(fromTool)}`);
});

// --- 結果 ---------------------------------------------------------------------
for (const f of failures) console.error(`FAIL ${f}`);
console.log(`kanban-ops38: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
