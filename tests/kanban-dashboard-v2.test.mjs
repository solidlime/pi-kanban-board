// v2.5 ダッシュボードのスモーク。旧 HTML 用の kanban-dashboard-*.test.mjs は
// 旧実装とセットで死んだので削除した（#42-#48）。ここは「構造が在るか」だけを見る高速テスト。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
const HTML = read("web/dashboard.html");
const PARTS = ["web/dash/_head.html", "web/dash/_a.css", "web/dash/_b.css", "web/dash/_c.css", "web/dash/_app.js"];

test("dashboard.html: 必須 id が揃っている", () => {
	for (const id of ["board", "allview", "groups", "swline", "pal", "toast", "sv-todo", "sv-doing", "sv-done", "sv-due", "sv-stall", "sv-proj"]) {
		assert.ok(HTML.includes(`id="${id}"`), `id="${id}" が無い`);
	}
});

test("dashboard.html: ビルド用プレースホルダが残っていない", () => {
	for (const ph of ["__KB_HOST__", "__KB_MD_JS__", "__KB_MEMORY_JS__", "/*CSS_A*/", "/*CSS_B*/", "/*CSS_C*/", "/*APP*/"]) {
		assert.ok(!HTML.includes(ph), `${ph} が残っている`);
	}
	assert.ok(HTML.includes("dashboard v2.5"));
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
	const p = (f) => read(f).replace(/\r\n?/g, "\n");
	const out = p("web/dash/_head.html")
		.replace("/*CSS_A*/", p("web/dash/_a.css"))
		.replace("/*CSS_B*/", p("web/dash/_b.css"))
		.replace("/*CSS_C*/", p("web/dash/_c.css"))
		.replace("/*APP*/", p("web/dash/_app.js"));
	assert.equal(p("web/dashboard.html"), out, "web/dashboard.html が dash/* とずれている");
	for (const f of PARTS) assert.ok(p(f).length > 0);
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
