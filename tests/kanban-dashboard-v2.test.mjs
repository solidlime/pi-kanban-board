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
