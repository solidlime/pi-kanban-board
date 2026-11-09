// v2.5 ダッシュボードのスモーク。旧 HTML 用の kanban-dashboard-*.test.mjs は
// 旧実装とセットで死んだので削除した（#42-#48）。ここは「構造が在るか」だけを見る高速テスト。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assemble } from "../scripts/build-web.mjs";

const read = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
const HTML = read("web/dashboard.html");
const PARTS = ["web/dash/_head.html", "web/dash/_a.css", "web/dash/_b.css", "web/dash/_c.css", "web/dash/_app.js"];

test("dashboard.html: 必須 id が揃っている", () => {
	for (const id of ["board", "allview", "groups", "swline", "pal", "toast", "sv-todo", "sv-doing", "sv-done", "sv-due", "sv-stall", "sv-proj"]) {
		assert.ok(HTML.includes(`id="${id}"`), `id="${id}" が無い`);
	}
});

test("dashboard.html: ビルド用プレースホルダが残っていない", () => {
	// __KB_HOST__ / __KB_MD_JS__ / __KB_MEMORY_JS__ は実行時・生成時に埋まるのが正しい。
	// 組み立て用の /*CSS_x*/ と /*APP*/ だけが残ってはいけない。
	for (const ph of ["/*CSS_A*/", "/*CSS_B*/", "/*CSS_C*/", "/*APP*/"]) {
		assert.ok(!HTML.includes(ph), `${ph} が残っている`);
	}
	assert.ok(HTML.includes("dashboard v2.5"));
	assert.ok(HTML.includes("__KB_HOST__"), "ホスト名の差し込み口が消えている（#94）");
});

test("dashboard.html: id が重複していない", () => {
	const ids = [...HTML.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
	const seen = new Set();
	for (const id of ids) {
		assert.ok(!seen.has(id), `id="${id}" が重複`);
		seen.add(id);
	}
});

test("dashboard.html は dash/* の結合結果と一致する", () => {
	// 組み立て規則は build-web.mjs が持つ。ここで二重に持たない。
	const out = assemble();
	assert.equal(read("web/dashboard.html").replace(/\r\n?/g, "\n"), out.replace(/\n+$/, "") + "\n");
	for (const f of PARTS) assert.ok(read(f).length > 0);
});

test("kanban.ts: /api/halt が resume と同じ形で在る（#48）", () => {
	const src = read("extensions/kanban.ts");
	assert.ok(src.includes("const haltRequests = new Set<string>();"), "haltRequests が無い");
	assert.ok(src.includes('case "/api/halt":'), "/api/halt ルートが無い");
	assert.ok(src.includes("haltRequests.add("), "halt の受付が無い");
	assert.ok(src.includes("haltRequests.delete(sid)"), "poll の消費が無い");
	// GET の書き込み面（#80-⑥）と global 拒否（#26）の両方に載っていること
	const writeList = src.slice(src.indexOf("function isWritePath"), src.indexOf("function methodNotAllowedOnGet"));
	assert.ok(writeList.includes('"/api/halt"'), "/api/halt が isWritePath に無い");
	const globalReject = src.match(/parseScope\(q\.get\("scope"\)\) === "global" && \[[^\]]*\]/);
	assert.ok(globalReject, "global 拒否リストが読めない");
	assert.ok(globalReject[0].includes('"/api/halt"'), "/api/halt が global 拒否に無い");
});

test("kanban.ts: TUI widget から GLOBAL 行が消えている（#47）", () => {
	const src = read("extensions/kanban.ts");
	const i = src.indexOf("ctx.ui.setWidget(\n\t\tWIDGET_KEY");
	assert.ok(i > 0, "setWidget の呼び出しが読めない");
	const block = src.slice(i, src.indexOf("placement: \"aboveEditor\"", i));
	assert.ok(!block.includes("GLOBAL:"), "GLOBAL 行がまだ出る");
	assert.ok(block.includes("PROJECT:"), "PROJECT 行が消えている");
});

test("dashboard: pause は双方向（#43/#48）", () => {
	const app = read("web/dash/_app.js");
	assert.ok(app.includes('"/api/halt"'), "halt を叩いていない");
	assert.ok(app.includes('"/api/resume"'), "resume を叩いていない");
	assert.ok(!app.includes('aria-disabled", "true"'), "pause が無効のまま");
	assert.ok(!app.includes("resume は /kanban resume"), "旧 title が残っている");
});

test("dashboard: ラベル・遷移・モーダル・DnD の骨（#44/#45/#46）", () => {
	const app = read("web/dash/_app.js");
	assert.ok(!HTML.includes("pick on 完了"), "「pick on 完了」が残っている");
	assert.ok(app.includes("cm-text") && app.includes("cm-save"), "カードモーダルの field が無い");
	assert.ok(app.includes('"/api/schedule"'), "実行予約が無い");
	assert.ok(app.includes('"/api/priority"'), "priority が無い");
	assert.ok(app.includes("draggable"), "DnD が無い");
	assert.ok(app.includes('dataset.slug'), "group の slug が無い");
});

test("dashboard: カードモーダルから添付できる（#49）", () => {
	// 面（input/ドロップ領域/サムネ入れ）と、送信先・事前拒否の骨だけを見る。
	const app = read("web/dash/_app.js");
	for (const id of ["cm-file", "cm-drop", "cm-thumbs", "cm-attstatus"]) {
		assert.ok(HTML.includes(`id="${id}"`), `id="${id}" が無い`);
	}
	assert.ok(HTML.includes('id="cm-file" multiple accept="'), "multiple + accept が無い");
	assert.ok(app.includes('"/api/upload"'), "アップロードを叩いていない");
	assert.ok(app.includes("UP_EXTS"), "accept 外の事前拒否が無い");
	assert.ok(app.includes('"Content-Type": "application/octet-stream"'), "生バイナリで送っていない");
});

test("dashboard: DOING のボードを左、溢れタブは +N に畳む（#84）", () => {
	const app = read("web/dash/_app.js");
	const css = read("web/dash/_a.css");
	// 並び: DOING 有り(0) → 選択中(1) → その他(2)。doing の判定が先。
	assert.match(app, /counts\.doing > 0\) return 0/);
	assert.match(app, /return a === state\.cur \? 1 : 2/);
	// クリック: .ptab-more のトグルが .ptab の pick より前に在る。
	const more = app.indexOf('closest(".ptab-more")');
	const pick = app.indexOf('closest(".ptab")');
	assert.ok(more > 0 && pick > more, ".ptab-more の分岐が pick より前");
	assert.match(app, /state\.ptabsOpen = !state\.ptabsOpen/);
	assert.match(app, /ptabsOpen: false/);
	// 折り畳みと CSS
	assert.match(app, /function foldTabs\(nav, all, tabs, b\)/);
	assert.match(app, /classList\.add\("over"\)/);
	assert.match(app, /full \|\| used \+ ws\[i\] > avail/, "一度畳んだら以降も畳む");
	assert.match(app, /tabs\[i\]\.dataset\.p === state\.cur\) \{ used \+= ws\[i\]; continue; \}/, "選択中のボードは畳まない");
	assert.match(css, /\.ptab\.over\{display:none\}/);
	assert.match(css, /\.ptabs\.open\{[^}]*flex-wrap:wrap/);
	assert.match(css, /\.ptab-more\{/);
	// shortcut: 文字列一致のみで foldTabs の幅計算は守っていない。ブラウザ DOM テストを入れる時に置換。
});

test("dashboard: #ptabs は poll ごとに作り直さない（#85）", () => {
	const app = read("web/dash/_app.js");
	const i = app.indexOf("function renderPtabs()");
	const fn = app.slice(i, app.indexOf("function foldTabs(", i));
	assert.ok(i > 0 && fn.length > 0, "renderPtabs が読めない");
	assert.ok(!fn.includes('clear($("#ptabs"))'), "#ptabs を毎回 clear している");
	assert.ok(fn.includes("keep["), "既存ノードの使い回しが無い");
	assert.ok(fn.includes("nav.scrollLeft = sl"), "scrollLeft を戻していない");
	assert.ok(fn.includes("focused.focus()"), "フォーカスを戻していない");
});

test("dashboard: 成果物タイルはどこを押してもプレビュー（#98）", () => {
	const app = read("web/dash/_app.js");
	const css = read("web/dash/_b.css");
	// クリックの入口はタイル全体。見出し限定（.del-cap）の分岐は無い。
	assert.ok(!app.includes('closest(".del-cap")'), ".del-cap 限定の分岐が残っている");
	assert.match(app, /closest\("\.del-tile"\)/);
	assert.match(app, /if \(dt\.classList\.contains\("thumb"\)\) showLb/, "タイル全体が lightbox に行かない");
	assert.match(app, /else openDelivModal\(Number\(dt\.dataset\.deliv\)\)/, "添付なしタイルのモーダルが死んでいる");
	// 添付のあるタイルは全部 .thumb + data-lb（動画・音声も prev/next に載る）。
	assert.match(app, /if \(imgs\.length\) \{ t\.classList\.add\("thumb"\); t\.dataset\.lb = name; \}/);
	// 編集への入口（鉛筆）が残る。
	assert.match(app, /el\("span", "del-edit"/);
	assert.match(app, /ed\.title = "成果物を編集"/);
	// #105: × は廃止（タイルのクリック面と競合する）。外す導線は右クリックメニューだけ。
	assert.ok(!app.includes("del-x"), "del-x が残っている");
	assert.ok(!css.includes("del-x"), "del-x の CSS が残っている");
	assert.match(app, /ed\.onclick = function \(ev\) \{ ev\.stopPropagation\(\); openDelivModal/);
	// 種別ごとの器が HTML に在る。
	for (const id of ["lbvid", "lbaud", "lbtxt"]) assert.ok(HTML.includes(`id="${id}"`), `id="${id}" が無い`);
	// ソースは textContent で出す（.js を lightbox で走らせない）。
	const i = app.indexOf("function showLb(");
	const showLb = app.slice(i, app.indexOf("function closeLb(", i));
	assert.ok(i > 0 && showLb.length > 0, "showLb が読めない");
	assert.match(showLb, /tx\.textContent = body/);
	assert.ok(!showLb.includes("innerHTML"), "lightbox が innerHTML で書いている");
	// html だけ sandbox。allow-same-origin は絶対に付けない（コメントでは言及してよい）。
	assert.ok(!/sandbox="[^"]*allow-same-origin/.test(app + HTML), "allow-same-origin が付いている");
	// 見切れない。
	assert.match(css, /object-fit:contain/);
	assert.match(css, /\.lb pre\{[^}]*overflow:auto/);
});

test("dashboard: 列ヘッダの sticky top は実測の --topbar-h（#88）", () => {
	const app = read("web/dash/_app.js");
	const css = read("web/dash/_b.css");
	assert.match(app, /new ResizeObserver\(put\)\.observe\(tb\)/);
	assert.match(app, /setProperty\("--topbar-h"/);
	assert.match(css, /\.colhead\{position:sticky; top:var\(--topbar-h,56px\)/);
	// 決め打ちが残っていたら、モバイルの折り返しでまたズレる
	assert.ok(!/top:56px/.test(css), "56px の決め打ちが残っている");
});

test("dashboard: 右クリック操作（#95）— 器は 1 個・3 分岐・閉じ方", () => {
	const app = read("web/dash/_app.js");
	const css = read("web/dash/_c.css");
	// 器は 1 個だけ。項目は JS が組み立てる（HTML に 3 つ並べない）。
	assert.equal((HTML.match(/id="ctxmenu"/g) || []).length, 1, "ctxmenu の器が 1 個でない");
	assert.match(app, /function ctxClose\(\) \{ \$\("#ctxmenu"\)\.hidden = true; \}/, "JS が器を引いて閉じていない");
	assert.ok(!/id="ctx-(card|deliv|col)"/.test(HTML), "メニューを用途別に増やしている");
	// モーダル(#cm=70)/lightbox(#lb=75)より上に出る。
	const zi = Number((css.match(/\.ctxmenu\{[^}]*z-index:(\d+)/) || [])[1]);
	assert.ok(zi > 75, `ctxmenu の z-index ${zi} が lightbox の下`);

	// 委譲は 1 本。card / del-tile / 列の 3 分岐が同じハンドラに居る（順序が preventDefault の前提）。
	const at = app.indexOf('document.addEventListener("contextmenu"');
	assert.ok(at > 0, "contextmenu の委譲が無い");
	const body = app.slice(at, app.indexOf("\n  document.addEventListener", at + 1));
	for (const t of ['closest("article.card")', 'closest(".del-tile")', 'closest("#board .col")']) {
		assert.ok(body.includes(t), `${t} の分岐が contextmenu ハンドラに無い`);
	}
	// 入力欄では既定メニューを残す = 止めるのはメニューを出す時だけ。
	assert.ok(body.includes('t.closest("input, textarea, pre")'), "入力欄で既定メニューを止めている");
	const pd = body.indexOf("e.preventDefault()");
	assert.ok(pd > body.indexOf('t.closest("#board .col")'), "preventDefault が分岐より前（器が無くても止める）");
	// モーダル・lightbox・パレットが開いている間は出さない。
	assert.ok(body.includes("if (modalOpen() ||"), "開いている間の抑止が無い");
	for (const id of ["#pal", "#lb"]) assert.ok(body.includes(`$("${id}").hasAttribute("open")`), `${id} の抑止が無い`);

	// 項目は <button>（キーボードで押せる）で、今の列は disabled。
	assert.match(app, /var b = el\("button", it\.cls \|\| null, it\.label\);/);
	assert.match(app, /off: c\.col === col/);
	assert.match(app, /b\.disabled = !!it\.off/);
	// 画面外へはみ出す時は右・下の余白を見て位置を寄せる（測ってから決める）。
	assert.match(app, /var r = m\.getBoundingClientRect\(\), pad = 4;/);
	assert.match(app, /x \+ r\.width > window\.innerWidth - pad \? x - r\.width : x/);
	assert.match(app, /y \+ r\.height > window\.innerHeight - pad \? y - r\.height : y/);
	// 閉じ方: Esc / 外側クリック / スクロール。
	assert.match(app, /if \(e\.key === "Escape" && !\$\("#ctxmenu"\)\.hidden\) \{ ctxClose\(\); return; \}/);
	assert.match(app, /if \(!\$\("#ctxmenu"\)\.hidden && !\(e\.target\.closest && e\.target\.closest\("#ctxmenu"\)\)\) ctxClose\(\);/);
	assert.match(app, /document\.addEventListener\("scroll", ctxClose, true\);/);
});

test("dashboard: 右クリックの各項目は既存 API を既存の引数で呼ぶ（#95）", () => {
	const app = read("web/dash/_app.js");
	// 引数の形は既存の呼び出しと同じ（/api/remove は id、/api/attach/del は deliv + n）。
	for (const [needle, why] of [
		['act("/api/add", { text: txt.trim(), col: col })', "列への追加"],
		['act("/api/priority", { id: id, n: next })', "優先度 ±1（n は絶対値）"],
		['act("/api/remove", { id: id })', "カード削除"],
		['act("/api/attach/del", { p: p, deliv: d.id, n: 0 })', "添付を外す"],
		['act("/api/deliv/remove", { p: p, id: d.id })', "成果物削除"],
		['moveCard(id, col)', "列移動"],
		['openModal(id)', "カード編集（既存モーダル）"],
		['openDelivModal(d.id)', "成果物編集（既存モーダル）"],
		['addCard("deliverable")', "成果物の追加（既存の + と同じ導線）"],
	]) assert.ok(app.includes(needle), `${why} が ${needle} を呼んでいない`);
	// 消す系は必ず confirm を挟む（右クリック 1 発で消えない）。
	const i = app.indexOf("function ctxCardItems(");
	const j = app.indexOf("function ctxColItems(");
	const cards = app.slice(i, j);
	assert.ok(cards.includes('window.confirm("#" + id + " を削除する？")'), "カード削除に confirm が無い");
	const deliv = app.slice(app.indexOf("function ctxDelivItems("), j);
	assert.ok(deliv.includes('window.confirm("成果物 #" + d.id + " を削除する？")'), "成果物削除に confirm が無い");
	// 添付を外すは添付がある時だけ（空でも押せると n 範囲外の 400 になる）。
	assert.ok(deliv.includes("off: !imgs.length"), "添付なしでも外せる");
});

test("dashboard: 右クリックの生成物が最新（#95）", () => {
	// 生成物は手で直さず build する。ここが落ちたら build-web.mjs を回す。
	assert.ok(HTML.includes('id="ctxmenu"'), "dashboard.html に器が無い");
	assert.ok(HTML.includes(".ctxmenu button"), "CSS が dashboard.html に入っていない");
	assert.ok(read("extensions/dashboard.generated.ts").includes('id="ctxmenu"'), "generated.ts が古い");
});

// #106: 携帯からの追加。送信経路が Ctrl/Cmd+Enter だけだと、ソフトキーボードには Ctrl が無く、
// textarea の Enter は改行なので送信できない（実機では打てるのに送れない）。addrow に submit ボタンを常設する。
test("#106: 追加行に送信ボタンがある（タッチに Ctrl+Enter は無い）", () => {
	const app = read("web/dash/_app.js");
	const addRow = (app.match(/function addRow\(col\) \{[\s\S]*?\n  \}/) ?? [""])[0];
	assert.ok(addRow.length > 0, "addRow が見つからない");
	assert.match(addRow, /btn\.type = "submit"/, "addRow に submit ボタンが無い（携帯から送信できない）");
	assert.match(addRow, /className = "addbtn"/, ".addbtn が付いていない");
	assert.match(addRow, /f\.appendChild\(btn\)/, "ボタンが form に入っていない");
	assert.match(addRow, /f\.onsubmit = function \(e\)/, "form の送信配線が無い（ボタンが素の GET になる）");
	const head = read("web/dash/_head.html");
	assert.match(head, /\.addrow\{[^}]*display:flex/, ".addrow が flex でない（ボタンが textarea の下に落ちる）");
	assert.match(head, /\.addrow \.addin\{[^}]*flex:1 1 0/, ".addin が横を引き受けない");
	assert.match(head, /\.addrow \.addbtn\{[^}]*min-height:36px/, ".addbtn のタップ領域が36px 未満");
});
