// #16: /kanban のドリルダウンは scope=global では全 project ボードの集約を読み、
// 書き込みは列ループ先頭の 1 か所のガードで止める。ガードが黙って消えると、global が
// 「空の看板」に戻るか、GLOBAL_JSON への書き込みが復活する。
// ctx.ui.select を 5 段モックする代わりに SOURCE の構造を固定する
// （tests/kanban-disk-snapshot.test.mjs と同じ流儀、サーバもブラウザも要らない）。
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url));
const SOURCE = readFileSync(SRC, "utf8");

// ドリルダウン = registerCommand("kanban", ...) から次に始まる pi.registerTool( まで。
const START = SOURCE.indexOf('pi.registerCommand("kanban"');
const END = SOURCE.indexOf("pi.registerTool({", START);
if (START < 0 || END < 0) throw new Error("kanban コマンドの範囲が見つからない");
const DRILL = SOURCE.slice(START, END);

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

const occurrences = (haystack, needle) => {
	const out = [];
	for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + 1)) out.push(i);
	return out;
};

// --- 1: global の読み取りは集約から -------------------------------------------------
check("ドリルダウンが readBoard(boardPath(scope, sid)) を直接呼ぶのは drillBoard の中だけ", () => {
	const hits = occurrences(DRILL, "readBoard(boardPath(scope, sid))");
	assert.equal(
		hits.length,
		1,
		`直接読みが ${hits.length} か所ある（global では GLOBAL_JSON = 移行後は常に空を読む）`,
	);
});

check("drillBoard の global 分岐は aggregateGlobal() の集約から組む", () => {
	assert.match(
		DRILL,
		/scope === "global"\s*\?\s*\{\s*cards: aggregateGlobal\(\)\.cards/,
		"global 分岐が aggregateGlobal() を使っていない",
	);
});

// --- 2: 書き込みは列ループ先頭のガードの後ろだけ -------------------------------------
check("writeBoard(boardPath(scope, sid)) はすべてガードの直後から始まる列ループの中", () => {
	const writes = occurrences(DRILL, "writeBoard(boardPath(scope, sid)");
	assert.ok(writes.length > 0, "書き込みが見つからない（テストの切り出しが壊れている）");
	for (const w of writes) {
		const loop = DRILL.lastIndexOf("for (;;) {", w);
		const guard = DRILL.lastIndexOf("if (globalReadOnly()) break;", w);
		assert.ok(loop >= 0, "列ループの外に書き込みがある");
		assert.ok(guard > loop, `列ループ先頭のガードより前に書き込みがある（index ${w}）`);
		assert.ok(guard - loop < 200, `ガードが列ループ先頭ではない（ループ先頭から ${guard - loop} 文字）`);
	}
});

check("globalReadOnly() の呼び出しは 2 か所（優先度 + 列ループ）だけ", () => {
	// 列ごとの個別ガード（＋新規カード / 移動・削除）はループ先頭の 1 本に畳んである。
	const calls = occurrences(DRILL, "globalReadOnly()");
	assert.equal(calls.length, 2, `globalReadOnly() の呼び出しが ${calls.length} か所ある`);
	assert.match(DRILL, /if \(globalReadOnly\(\)\) continue;/, "優先度のガードが無い");
	assert.match(DRILL, /if \(globalReadOnly\(\)\) break;/, "列ループ先頭のガードが無い");
});

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
