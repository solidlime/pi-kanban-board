// #57 注入文・widget 行の画像マーカーが `🖼` の 1 文字だけでどのファイルか
// 分からない問題の自己検証。フレームワーク無しで
// `node tests/kanban-img-marker.test.mjs`。HOME と KANBAN_PORT を差し替えるので
// 本番の ~/.pi/kanban と 8789 には触れない。
// `Card.img` は media/ 配下のファイル名そのもの（`1-b87bb83d.png`）。パスも
// basename 変換もせずそのまま出す、という契約を固定する。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";

const HOME_DIR = "/tmp/kb-img-marker-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/media`, { recursive: true });
process.env.HOME = HOME_DIR;
// Windows: os.homedir() prefers USERPROFILE over HOME, so keep them in step or the
// server writes its token to the real profile and this test reads a missing file.
process.env.USERPROFILE = process.env.HOME;
const PORT = await new Promise((resolve) => {
	const s = createServer();
	s.listen(0, "127.0.0.1", () => {
		const { port } = s.address();
		s.close(() => resolve(port));
	});
});
process.env.KANBAN_PORT = String(PORT);

const { createJiti } = createRequire(import.meta.url)(
	process.env.KANBAN_JITI ?? createRequire(import.meta.url).resolve("jiti"),
);
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url)));
const { renderInjectionText } = mod;

const failures = [];
let passed = 0;
function check(name, fn) {
	try {
		fn();
		passed += 1;
	} catch (err) {
		failures.push(`${name}: ${err.message}`);
	}
}

const IMG = "1-b87bb83d.png";
// 注入文は `LABELS[col]` + formatCard の並び。1 枚だけの列から
// formatCard の出力そのもの（ラベルを剥がした部分）を取り出す。
function injected(cards) {
	const out = renderInjectionText({ cards, nextId: cards.length + 1 });
	assert.ok(out !== null, "注入テキストが null");
	return out;
}
function cardLine(cards, col) {
	const line = injected(cards)
		.split("\n")
		.find((l) => l.startsWith(col));
	assert.ok(line !== undefined, `${col} 行が無い`);
	return line;
}

// --- 1. `🖼<img>` がファイル名付きで出る --------------------------------------
check("#57 画像付きカードのマーカーに img のファイル名が付く", () => {
	const line = cardLine([{ id: 3, text: "画像付き", col: "todo", img: IMG }], "TODO");
	assert.ok(line.includes(`🖼${IMG}`), `ファイル名付きマーカーが無い: ${line}`);
	assert.ok(!line.includes("🖼 "), `旧マーカーの空白区切りが残っている: ${line}`);
});

check("#57 img はパスを足さず basename 変換もしない（そのまま出す）", () => {
	const line = cardLine([{ id: 3, text: "画像付き", col: "todo", img: IMG }], "TODO");
	assert.ok(line.includes(IMG), `img がそのまま出ていない: ${line}`);
	assert.ok(!line.includes(`media/${IMG}`), `media/ が混ざっている: ${line}`);
	assert.ok(!line.includes("/api/"), `API パスが混ざっている: ${line}`);
});

// --- 2. img 無しカードに `🖼` は出ない ---------------------------------------
check("#57 img の無いカードに 🖼 は出ない", () => {
	const line = cardLine([{ id: 4, text: "文字だけ", col: "todo" }], "TODO");
	assert.ok(!line.includes("🖼"), `img 無しで 🖼 が出た: ${line}`);
	assert.ok(line.includes("#4 文字だけ"), `カードが壊れている: ${line}`);
});

// --- 3. 選択肢と比較 (:5145 / :5166) が同じ関数で一致する --------------------
// 選択肢の配列は formatCard で作り、選ばれた文字列を formatCard で引き当てる。
// 両方が同じ関数なので、入力が同じなら必ず一致し、img が違えば区別できる。
check("#57 同じカードは 2 回呼んでも同じ文字列になる（比較が一致する）", () => {
	const c = { id: 5, text: "同じ", col: "todo", img: IMG };
	assert.equal(
		cardLine([c], "TODO"),
		cardLine([{ ...c }], "TODO"),
		"同じカードの出力が揺れている（選択肢の比較が壊れる）",
	);
});

check("#57 text が同じでも img が違えば区別できる（現状より曖昧さが減る）", () => {
	const a = cardLine([{ id: 6, text: "同じ", col: "todo", img: "1-aaaa.png" }], "TODO");
	const b = cardLine([{ id: 7, text: "同じ", col: "todo", img: "2-bbbb.png" }], "TODO");
	assert.notEqual(a, b, `img 違いが区別できない: ${a} / ${b}`);
});

// --- 4. widget 行（1 行に ` / ` 連結）でも壊れない ---------------------------
check("#57 widget の連結行でもファイル名が残る", () => {
	const out = injected([
		{ id: 1, text: "A", col: "doing", img: IMG },
		{ id: 2, text: "B", col: "doing" },
	]);
	const line = out.split("\n").find((l) => l.startsWith("DOING"));
	assert.ok(line.includes(" / "), `連結されていない: ${line}`);
	assert.ok(line.includes(`🖼${IMG}`), `連結行でファイル名が消えた: ${line}`);
	assert.ok(line.includes("#2 B"), `img 無しカードが壊れた: ${line}`);
});

// --- 結果 -------------------------------------------------------------------
for (const f of failures) console.error(`FAIL ${f}`);
console.log(`kanban-img-marker: ${passed} passed, ${failures.length} failed`);
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 100);
