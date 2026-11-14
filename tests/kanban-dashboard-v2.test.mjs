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
	assert.match(app, /if \(imgs\.length\) \{ t\.classList\.add\("thumb"\); t\.dataset\.lb = name; t\.dataset\.at = at; \}/);
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

// #107: 1) 末尾改行だけでも quickadd に倒れ、quickadd は TODO にしか作らないので、
// DOING の「+」で return を押しただけでカードが TODO に落ちていた。
// 2) quickadd が 0 件（コメント行・トークンだけの行）でも成功トーストが出ていた。
// 3) iOS Safari は 16px 未満の入力欄でフォーカス時に自動ズームする。
test("#107: 末尾改行で列が落ちない / 0件を成功に見せない / iOS で自動ズームしない", () => {
	const app = read("web/dash/_app.js");
	assert.match(app, /var multi = body\.trim\(\)\.indexOf\("\\n"\) >= 0/, "末尾改行を数えている（DOING から打つと TODO に落ちる）");
	assert.match(app, /var msg = !multi \?/, "0 件と成功を区別していない");
	assert.match(app, /act\("\/api\/quickadd", \{ text: body, col: col \}\)/, "quickadd へ trim した本文か列を渡していない（子カードのインデントが消える / 列が落ちる）");
	assert.match(app, /追加できる行が無い/, "0 件でも成功トーストが出る");
	const head = read("web/dash/_head.html");
	assert.match(head, /@media \(pointer:coarse\)\{\.addrow \.addin\{font-size:16px[^}]*\}/, "iOS の自動ズームを止めていない");
	assert.match(head, /@media \(pointer:coarse\)[^\n]*\.addbtn\{min-height:44px\}/, "粗いポインタのタップ領域が 44px 未満");
	assert.match(head, /\.addrow \.addin\{[^}]*min-height:36px/, "追加ボタンと下端が揃わない");
});


test("#109: 帯のタイルは複数添付を横ドラッグで切り替える", () => {
	const app = read("web/dash/_app.js");
	const css = read("web/dash/_b.css");
	// index 計算は純関数なので、実装を切り出して値で確かめる（文字列一致より強い）。
	const m = app.match(/function delIdx\(cur, n, d\) \{[\s\S]*?\n  \}/);
	assert.ok(m, "delIdx が無い");
	const delIdx = new Function(m[0] + "\nreturn delIdx;")();
	assert.equal(delIdx(undefined, 3, 0), 0, "未保存は先頭");
	assert.equal(delIdx(0, 2, 1), 1, "2 枚で次へ");
	assert.equal(delIdx(1, 2, 1), 0, "2 枚で末尾から先頭へ回る");
	assert.equal(delIdx(0, 2, -1), 1, "2 枚で先頭から末尾へ回る");
	assert.equal(delIdx(2, 3, 1), 0, "3 枚で wrap");
	assert.equal(delIdx(2, 2, 1), 0, "添付が減ったら clamp が効く（直後の 1 振りは空振りしうる）");
	assert.equal(delIdx(2, 2, -1), 0, "clamp 後の逆方向も効く（2/2 から 1/2）");
	assert.ok(app.includes("delAt[c.id] = delIdx(delAt[c.id], imgs.length, d);"), "切り替えが delIdx を通っていない");
	assert.ok(app.includes("var at = imgs.length ? delIdx(delAt[c.id], imgs.length, 0) : 0;"), "表示が delIdx を通っていない");
	assert.ok(app.includes("t.setPointerCapture(ev.pointerId)"), "タイル外で離すと pointerup が来ない");
	assert.ok(app.includes("if (!sw || sw.id !== ev.pointerId) return;"), "別ポインタの up で切り替わる");
	assert.ok(app.includes('(at + 1) + "/" + imgs.length'), "2/3 のカウンタが無い");
	assert.ok(app.includes("if (delSwipe.id === Number(dt.dataset.deliv) && Date.now() - delSwipe.at < 400) return;"), "振ったタイルのタップ抑止が無い");
	assert.ok(css.includes(".del-tile.thumb{touch-action:pan-y pinch-zoom}"), "横ドラッグ or ピンチズームが死んでいる");
	// #112: マウスでは img のネイティブドラッグが pointercancel を撃ち、sw が消える。打ち消しはタイル限定。
	const a0 = app.indexOf("if (imgs.length > 1) {");
	const a1 = app.indexOf('t.addEventListener("pointercancel"');
	assert.ok(a0 >= 0 && a1 > a0, "#112: スライス境界が取れない（アサートが空振りする）");
	const swipeBlock = app.slice(a0, a1);
	assert.ok(swipeBlock.includes('t.addEventListener("dragstart"') && swipeBlock.includes("ev.preventDefault()"), "#112: dragstart の打ち消しが複数添付タイルのブロックに無い");
	assert.equal(app.split('addEventListener("dragstart"').length - 1, 2, "#112: dragstart のリスナーはカード DnD とタイルの 2 本だけ");
});

test("#110: 成果物タイルの削除は編集の左（スマフォでは常時表示）", () => {
	const app = read("web/dash/_app.js");
	const css = read("web/dash/_b.css");
	assert.ok(app.includes('el("span", "del-del"'), "削除ボタンが無い");
	assert.ok(app.includes('de.title = "成果物を削除";'), "削除のツールチップが無い");
	assert.ok(app.includes("if (!window.confirm(\"成果物 #\" + c.id + \" を削除する？\")) return;"), "確認なしで消える");
	assert.ok(app.includes('act("/api/deliv/remove", { p: c.sid || state.cur, id: c.id })'), "削除の宛先がタイル側の決め方と違う");
	// 編集より先に append = DOM では左に来る（見た目の左右は CSS の right で決める）。
	assert.ok(app.indexOf('"del-del"') < app.indexOf('"del-edit"'), "削除が編集より後ろに append されている");
	assert.ok(css.includes("right:32px"), "削除が編集の左に置かれていない");
	assert.ok(css.includes("@media (hover:none){ .del-edit,.del-del{opacity:1} }"), "ホバーの無い端末で押せない");
});

// #113: 検索は既存の横断検索 #q を成果物にも効かせる（専用ボックスは作らない）。
// cardHit は blocked/labels/commit も見るが Deliv には無い項目なので、別関数にして持っている項目だけを見る。
test("#113: 成果物は #q で絞り、帯だけ新旧ソートする（表示順だけ）", () => {
	const app = read("web/dash/_app.js");
	const head = read("web/dash/_head.html");
	const css = read("web/dash/_b.css");

	const m = app.match(/function delivHit\(d\) \{[\s\S]*?\n  \}/);
	assert.ok(m, "delivHit が無い");
	assert.ok(m[0].includes('"#" + d.id'), "成果物 id を検索対象にしていない");
	assert.ok(m[0].includes("state.query"), "#q（state.query）と連動していない");
	assert.ok(app.includes(".filter(delivHit)"), "renderDeliverables が delivHit で絞っていない");

	// 並べ替えは純関数として値で確かめる（文字列一致より強い）。
	const s = app.match(/function sortDeliv\(list, dir\) \{[\s\S]*?\n  \}/);
	assert.ok(s, "sortDeliv が無い");
	const sortDeliv = new Function(s[0] + "\nreturn sortDeliv;")();
	const items = [{ id: 1, at: 100 }, { id: 2, at: 300 }, { id: 3 }, { id: 4, at: 300 }];
	assert.deepEqual(sortDeliv(items, -1).map((d) => d.id), [2, 4, 1, 3], "新→旧が at 降順・同値 id 昇順でない");
	assert.deepEqual(sortDeliv(items, 1).map((d) => d.id), [3, 1, 2, 4], "旧→新が at 昇順・at 欠落を 0 にしていない");
	assert.deepEqual(items.map((d) => d.id), [1, 2, 3, 4], "呼び元の配列を並べ替えている");

	// 署名に query と delSort が入っていないと、絞り込み/ソートが再描画されない。
	assert.match(app, /var sig = [^\n]*state\.query[^\n]*state\.delSort/, "sig に query/delSort が入っていない");
	assert.ok(app.includes('" / 全 " + all.length + " 枚"'), "絞り込み中の件数が「N / 全 M 枚」でない");

	const i0 = head.indexOf('id="delcount"'), i1 = head.indexOf('id="delsort"'), i2 = head.indexOf('id="deladd"');
	assert.ok(i0 >= 0 && i1 > i0 && i2 > i1, "#delsort が件数の後ろ・+ の前に無い");
	assert.ok(app.includes('if (t.id === "delsort") {'), "#delsort のクリックが委譲ハンドラに無い");
	const d0 = app.indexOf('if (t.id === "delsort") {');
	const d1 = app.indexOf("return;", d0);
	assert.ok(d0 >= 0 && d1 > d0, "#delsort のブロック境界が取れない（アサートが空振りする）");
	assert.ok(app.slice(d0, d1).includes("e.preventDefault()"), "summary 内なので details が開閉してしまう");
	assert.ok(app.includes('localStorage.setItem("del-sort", state.delSort)'), "向きを保存していない");
	assert.ok(app.includes('localStorage.getItem("del-sort")'), "保存した向きを読んでいない");
	assert.ok(app.includes('sbt.setAttribute("aria-pressed"'), "aria-pressed で現在値を出していない");
	assert.match(css, /\.delhead \.sort\{[^}]*color:var\(--muted\)/, "#delsort の見た目が無い");
});

test("#114: 帯は空き領域からの矩形選択で一括削除できる", () => {
	const app = read("web/dash/_app.js");
	const css = read("web/dash/_b.css");

	assert.equal(app.split("function marquee").length - 1, 1, "marquee が 1 実装に統一されていない");
	const q0 = app.indexOf("function marquee(box, itemSel, onPick)");
	assert.ok(q0 >= 0, "marquee の署名が仕様と違う");
	const qEnd = app.indexOf("\n  }", q0);
	assert.ok(qEnd > q0, "marquee のブロック境界が取れない（アサートが空振りする）");
	const marq = app.slice(q0, qEnd);
	assert.ok(marq.includes('ev.pointerType === "touch"'), "タッチで矩形を作っている（スマフォのタイル操作が壊れる）");
	assert.ok(marq.includes("ev.target.closest(itemSel)"), "タイル上から始まった押下を奪っている");
	// 除外リストは完全一致で固定する（.donefold は div[role=button] なので [role=button] が要る）。
	assert.ok(marq.includes('var skip = "summary, button, [role=button], input, textarea, select, a, .selbar, .addrow";'), "押下を奪う除外リストが仕様と違う");
	assert.ok(marq.includes("ev.button !== 0"), "右クリック・中クリックで矩形が始まる");
	// capture は使わない（click の再ターゲット・lostpointercapture の順序依存・子の capture 巻き込みを消す）。
	assert.ok(!app.includes("box.setPointerCapture"), "矩形選択が pointer capture を使っている");
	assert.ok(marq.includes('window.addEventListener("pointermove", move)'), "pointermove を window に張っていない");
	assert.ok(marq.includes('window.addEventListener("pointerup", up)'), "pointerup を window に張っていない");
	assert.ok(marq.includes('window.addEventListener("pointercancel", cancel)'), "pointercancel を window に張っていない");
	assert.ok(marq.includes('window.removeEventListener("pointercancel", cancel)'), "window のリスナーを外していない（stop が冪等でない）");
	assert.ok(marq.includes('window.addEventListener("blur", stop)'), "ウィンドウ外で離した時の取りこぼし対策が無い");
	// stop() は pointerdown で張った 4 本（move / up / cancel / blur）を全部外す。1 本でも漏れると stop が冪等でない。
	assert.equal(marq.split("window.removeEventListener").length - 1, 4, "stop が window のリスナーを 4 本とも外していない");
	// 4px 未満で離した時（クリック）は onPick を呼ばない。矩形が無いのに hits を渡すと空選択で選択が消える。
	const u0 = marq.indexOf("function up(ev) {");
	assert.ok(u0 >= 0, "up が見つからない");
	const u1 = marq.indexOf("\n    }", u0);
	assert.ok(u1 > u0, "up のブロック境界が取れない（アサートが空振りする）");
	assert.ok(marq.slice(u0, u1).includes("if (!d.rect) return;"), "クリック（4px 未満）で onPick を呼んでいる");
	assert.ok(marq.includes("function cancel() { stop(); }"), "cancel が選択を変えている");
	assert.ok(!marq.includes("lostpointercapture"), "lostpointercapture への依存が残っている");
	assert.ok(marq.includes("stop(); //"), "pointerdown で前回の途中状態を止めていない");
	assert.ok(marq.includes('el("div", "mq")'), "矩形の要素が無い");
	assert.ok(marq.includes("getBoundingClientRect()"), "交差判定が矩形ベースでない");
	assert.ok(marq.includes("// shortcut: タッチは矩形を作らない"), "shortcut コメントが無い");

	assert.ok(app.includes('marquee($("#deliverables"), ".del-tile"'), "帯に矩形選択が配線されていない");
	assert.ok(app.includes("state.dsel"), "選択の器が無い");
	assert.ok(!/state\.sel\[/.test(app), "キーボードカーソル state.sel を複数選択に流用している");
	assert.ok(app.includes("function applyDSel()"), "選択の描き直しが無い");
	assert.ok(app.includes('.classList.toggle("msel"'), "選択の見た目が付かない");
	// #q 側の 1 行で空振りしないよう、pick() のスライスの中で見る。
	const p0 = app.indexOf("function pick(slug, haveProjects) {");
	assert.ok(p0 >= 0, "pick が見つからない");
	const p1 = app.indexOf("\n  }", p0);
	assert.ok(p1 > p0, "pick のブロック境界が取れない（アサートが空振りする）");
	assert.ok(app.slice(p0, p1).includes("state.dsel = {};"), "板切替で選択を捨てていない");
	// render のスライス内で呼ばれていること（#115 の applyCSel と同じ検査）。
	const r0 = app.indexOf("function render() {");
	assert.ok(r0 >= 0, "render が見つからない");
	const r1 = app.indexOf("\n  }", r0);
	assert.ok(r1 > r0, "render のブロック境界が取れない（アサートが空振りする）");
	assert.ok(app.slice(r0, r1).includes("applyDSel();"), "render の末尾で帯の選択を付け直していない");

	// 操作バー: 1 実装（renderSelBar）を #delbar と #cardbar で共有する。
	assert.equal(app.split("function renderSelBar(").length - 1, 1, "選択バーの生成が 1 実装に統一されていない");
	const b0 = app.indexOf("function applyDSel()");
	assert.ok(b0 >= 0, "操作バーが無い");
	const b1 = app.indexOf("function applyCSel()", b0);
	assert.ok(b1 > b0, "applyDSel のブロック境界が取れない（アサートが空振りする）");
	const bar = app.slice(b0, b1);
	assert.ok(bar.includes("Promise.all(del.map("), "一括削除が N 発の Promise.all でない");
	assert.ok(bar.includes('window.confirm("成果物 " + del.length + " 件を削除する？")'), "confirm に件数が無い");
	assert.ok(bar.includes('"/api/deliv/remove"'), "削除 API が違う");
	assert.ok(bar.includes("delP("), "宛先（sid || cur）の解決が 1 箇所にまとまっていない");
	// global 行（sid === ""）は板が無いので一括削除に含めない（delP が "__all__" になり 404）。
	assert.ok(bar.includes('d.sid !== ""'), "global 行を一括削除の対象から除いていない");
	assert.ok(bar.includes("global の "), "除外した件数を toast で知らせていない");
	const s0 = app.indexOf("function renderSelBar(");
	const s1 = app.indexOf("\n  }", s0);
	assert.ok(s1 > s0, "renderSelBar のブロック境界が取れない（アサートが空振りする）");
	const sel = app.slice(s0, s1);
	assert.ok(sel.includes("bar.dataset.sig"), "sig で再構築を止めていない（ポーリングでボタンが差し替わる）");
	assert.ok(sel.includes("if (bar.dataset.sig === sig) return;"), "sig を比較せず書き込みだけで終わっている");
	assert.ok(sel.includes("sort("), "sig が選択 id のソート済み文字列でない");
	assert.ok(sel.includes("件選択"), "件数が出ていない");

	assert.ok(css.includes(".del-tile.msel{outline:2px solid var(--accent)"), ".msel の見た目が無い");
	// 矩形で選ばれる候補がドラッグ中に見えないと機能の核が死ぬ（.msel の実線と区別する破線）。
	assert.ok(css.includes(".del-tile.mq-on, .card.mq-on { outline: 2px dashed var(--accent); outline-offset: -2px; }"), "矩形中の選択候補の見た目が無い");
	assert.ok(css.includes(".mq{"), "矩形の CSS が無い");
	assert.ok(css.includes("position:fixed"), "矩形が fixed でない（スクロール中にズレる）");
});

// #115: カード（TODO/DOING/DONE）も空き領域からの矩形選択でまとめて移動・削除できる。
// 選択の器は state.csel。キーボードカーソルの state.sel / .card.sel とは混ぜない。
test("#115: カードは矩形選択で一括移動・一括削除できる", () => {
	const app = read("web/dash/_app.js");
	const css = read("web/dash/_b.css");

	// marquee は #114 の 1 実装をそのまま使う（2 実装に割らない）。
	assert.equal(app.split("function marquee").length - 1, 1, "marquee が 1 実装に統一されていない");
	assert.ok(app.includes('marquee($("#board"), ".card[data-id]"'), "#board に矩形選択が配線されていない");
	assert.ok(app.includes('marquee($("#deliverables"), ".del-tile"'), "帯側の配線が #115 で壊れた");

	// .sel（キーボードカーソル）のトグルは applySel の 1 か所だけ。state.csel は .sel を触らない。
	assert.equal(app.split('.classList.toggle("sel", i === state.sel)').length - 1, 1, ".card.sel のトグルが 1 か所でない");
	const c0 = app.indexOf("function applyCSel()");
	assert.ok(c0 >= 0, "applyCSel が無い");
	const c1 = app.indexOf("\n  }", c0);
	assert.ok(c1 > c0, "applyCSel のブロック境界が取れない（アサートが空振りする）");
	const csel = app.slice(c0, c1);
	assert.ok(csel.includes('.classList.toggle("msel"'), "選択の見た目が付かない");
	assert.ok(!/"sel"/.test(csel), "applyCSel が .sel（キーボードカーソル）を触っている");
	assert.ok(app.includes("applyCSel();"), "render から呼ばれていない");
	const r0 = app.indexOf("function render() {");
	assert.ok(r0 >= 0, "render が見つからない");
	const r1 = app.indexOf("\n  }", r0);
	assert.ok(r1 > r0, "render のブロック境界が取れない");
	assert.ok(app.slice(r0, r1).includes("applyCSel();"), "render の末尾で選択の見た目を付け直していない");

	// 操作バー: N 件選択 / → TODO / → DOING / → DONE / 削除 / 解除。
	const b0 = app.indexOf("function applyCSel()");
	assert.ok(b0 >= 0, "カードの操作バーが無い");
	const b1 = app.indexOf("function renderSelBar(", b0);
	assert.ok(b1 > b0, "操作バーのブロック境界が取れない（アサートが空振りする）");
	const bar = app.slice(b0, b1);
	assert.ok(bar.includes('["todo", "doing", "done"].forEach'), "列ごとの移動ボタンが無い");
	assert.equal(bar.split("Promise.all(").length - 1, 2, "一括移動と一括削除が Promise.all でない");
	assert.ok(bar.includes('act("/api/move"'), "移動 API が違う");
	assert.ok(bar.includes('act("/api/remove"'), "削除 API が違う");
	assert.ok(bar.includes('window.confirm("カード " + ids.length + " 件を削除する？")'), "confirm に件数が無い");
	assert.ok(bar.includes("c.col !== col"), "既にその列にいるカードを飛ばしていない");
	assert.ok(bar.includes("if (!move.length)"), "空配列を Promise.all に渡す経路が残っている");
	assert.ok(bar.includes("// shortcut: 取り消せない"), "取り消せない旨の shortcut コメントが無い");

	// 選択の後始末（板切替 / 検索変更）と、選択の器。
	assert.ok(app.includes("csel: {}"), "選択の器が無い");
	assert.ok(app.includes("state.csel = {}; // #115"), "板切替で選択を捨てていない");
	const q0 = app.indexOf('$("#q").addEventListener("input"');
	assert.ok(q0 >= 0, "#q のハンドラが見つからない");
	const q1 = app.indexOf("\n", q0);
	assert.ok(q1 > q0, "#q の行境界が取れない");
	assert.ok(app.slice(q0, q1).includes("state.csel = {}"), "検索語が変わったら選択を捨てていない");

	assert.ok(css.includes(".card.msel{outline:2px solid var(--accent)"), ".card.msel の見た目が無い");
	assert.ok(css.includes(".selbar{"), "操作バーの共通クラスが無い（#delbar と 2 つに割れている）");
	assert.ok(app.includes('el("div", "selbar")'), "バーが .selbar を使っていない");
	// #cardbar は .layout（main）の直下なので grid-column:1/-1 が効く。#delbar は #deliverables（details）の中なので効かない。
	// 指定は #cardbar のために共通クラス側に置く（帯側に出ても実害は無い）。
	assert.match(css, /\.selbar\{[^}]*grid-column:1\/-1/, ".selbar に #cardbar 用の grid-column が無い");
	assert.ok(!css.includes("#cardbar{grid-column"), "#cardbar の重複指定が残っている");

	// 横断ビューでは選択そのものを張らない（成果物 id が板を跨いで重複し、delivById の先頭一致が別の板を指す）。
	// ガードは共有ヘルパではなく選択を張る層（applyDSel）に置く。
	const ad0 = app.indexOf("function applyDSel()");
	assert.ok(ad0 >= 0, "applyDSel が見つからない");
	const ad1 = app.indexOf("\n  }", ad0);
	assert.ok(ad1 > ad0, "applyDSel のブロック境界が取れない（アサートが空振りする）");
	assert.ok(app.slice(ad0, ad1).includes("if (state.allview) state.dsel = {};"), "横断ビューで成果物の選択を張っている");
	const sb0 = app.indexOf("function renderSelBar(");
	const sb1 = app.indexOf("\n  }", sb0);
	assert.ok(sb1 > sb0, "renderSelBar のブロック境界が取れない");
	assert.ok(!app.slice(sb0, sb1).includes("state.allview"), "共有ヘルパに呼び元固有の allview 分岐が残っている");

	// 列の再利用判定が .msel を見ていないと、選択のたびに列が総入れ替えになる（チカチカ・スクロール消失）。
	assert.ok(app.includes('".card.sel, .card.msel"'), "renderBoard の列再利用判定が .msel を見ていない");
	assert.ok(app.includes('classList.remove("sel", "msel")'), ".msel を比較前に落としていない");
});
