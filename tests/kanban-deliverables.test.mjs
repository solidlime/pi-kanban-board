// #58: 第4帯『成果物』。TODO/DOING/DONE の下に全幅で添付/ref を並べる帯。
// ここは「構造が在るか」だけを見る高速テスト（dashboard の実描画はブラウザ側の担当）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
const HTML = read("web/dashboard.html");
const B = read("web/dash/_b.css");
const APP = read("web/dash/_app.js");

test("#58: dashboard.html に第4帯『成果物』が居る", () => {
	assert.ok(HTML.includes('id="deliverables"'), 'id="deliverables" が無い');
	assert.ok(HTML.includes('class="deliverables"'), 'class="deliverables" が無い');
	assert.ok(HTML.includes('class="del-grid"'), 'class="del-grid" が無い');
	assert.ok(HTML.includes('aria-label="成果物"'), "aria-label が無い");
	// 全幅の帯はボード列より後ろ（DOM 順）。rail を押し下げないよう rail の後ろに置く。
	assert.ok(HTML.indexOf('id="deliverables"') > HTML.indexOf('id="allview"'), "pview より後ろに置く");
	assert.ok(HTML.indexOf('id="deliverables"') > HTML.indexOf('id="rail"'), "rail より後ろに置く");
});

test("#58: .deliverables は全幅、.del-grid は 230px の自動詰め", () => {
	assert.match(B, /\.deliverables\{[^}]*grid-column:1\/-1/, ".deliverables{grid-column:1/-1} が無い");
	assert.match(B, /\.del-grid\{[^}]*grid-template-columns:repeat\(auto-fill, ?minmax\(230px, ?1fr\)\)/, "del-grid の格栅が無い");
	assert.match(B, /\.del-tile\{[^}]*overflow:hidden/, ".del-tile が無い");
	assert.match(B, /\.del-body\{[^}]*height:140px/, "サムネ高さ 140px が無い");
	// #105: 成果物タイルの添付はアス比維持（contain）で縮める。見切れさせない。
	assert.match(B, /\.del-body img\{[^}]*object-fit:contain/, ".del-body img が contain でない");
	assert.match(B, /\.del-body video\{[^}]*object-fit:contain/, ".del-body video が contain でない");
	assert.match(HTML, /\.vthumb\{[^}]*pointer-events:none/, ".vthumb が無い（タイルの動画がクリックを奪う）");
	// #105: カード内の動画も箱に収める（.vthumb は max-width だけだと縦動画が縦に膨らむ）。
	assert.match(B, /\.attline video\{[^}]*height:120px[^}]*object-fit:contain/, ".attline video が箱に入っていない");
	assert.match(B, /\.del-tile \.refbad\{/, "不在オーバーレイ (.refbad) が無い");
});

test("#58: _app.js に renderDeliverables() があり render() から呼ばれる", () => {
	assert.ok(APP.includes("function renderDeliverables()"), "renderDeliverables が無い");
	const r = APP.slice(APP.indexOf("function render() {"), APP.indexOf("function visibleCards()"));
	assert.ok(r.includes("renderDeliverables()"), "render() が renderDeliverables を呼んでいない");
});

test("#82: 帯のデータは deliv（card の col ではない）", () => {
	const src = APP.slice(APP.indexOf("function delItems()"), APP.indexOf("function renderRail()"));
	assert.ok(src.includes("imgsOf("), "添付の有無は imgsOf で判定する（csv の any entry）");
	assert.ok(src.includes("state.payload.global.deliverables"), "横断ビューは global.deliverables を使う");
	assert.ok(src.includes("rep.deliverables"), "proj ビューは project.deliverables を使う");
	// 画像/html のサムネは既存 thumbBody（media path と .thumb クリック面）を使う。
	assert.ok(src.includes("thumbBody("), "サムネは thumbBody を使う");
	// #60: allow-forms が interactive 添付（アンケート）の submit を通す。
	assert.ok(/setAttribute\("sandbox", "[^"]*allow-scripts[^"]*"\)/.test(APP), "iframe の sandbox が無い");
	assert.ok(/setAttribute\("sandbox", "[^"]*allow-forms[^"]*"\)/.test(APP), "sandbox に allow-forms が無い");
	assert.ok(!/setAttribute\("sandbox",[^)]*allow-same-origin/.test(APP), "allow-same-origin を足してはいけない");
	assert.ok(src.includes("srcOf("), "URL は srcOf（/api/media と /api/ref）を使う");
	// #72/#79: この帯は成果物だけ。TODO/DOING/DONE のカードを混ぜない。
	// 添付の有無は問わない（#79: 添付なしの成果物も帯に出す）。
	assert.ok(!APP.includes('c.col === "deliverable"'), "成果物帯に card の col フィルタが残っている");
	assert.ok(!APP.includes('data-move="deliverable"'), "カードモーダルに deliverable への移動ボタンが残っている");
});

test("#58: 畳める（details + localStorage 記憶）", () => {
	assert.ok(/<details class="deliverables"[^>]*\bopen\b/.test(HTML), "details が open 既定で無い");
	assert.ok(APP.includes('"deliverables-open"'), "localStorage キー deliverables-open が無い");
	assert.ok(!APP.includes("__KB_MEMORY_JS__"), "memory.js のプレースホルダが混入");
	assert.equal((HTML.match(/__KB_MD_JS__/g) || []).length, 1, "md.js の注入は 1 箇所");
});
