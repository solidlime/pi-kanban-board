// #75 回帰: その場追加の入力欄（.addin / .add）が再描画で消えないこと。
//
// 起票内容: addIn は #sessions の内側にあり、データ変化の再描画で行ごと作り直されるため
// showAdd(false) に戻り、打鍵値も失われる。
//
// 実測した事実（Playwright、隔離 HOME + 別ポート）:
//   - フォーカス中は isEditing()（#70）が再描画そのものを止めるので再現しない。
//   - フォーカスを外した状態でデータ変化を起こすと再現する:
//     HEAD    step4_afterChange = display:"none"  value:""
//     修正後  step4_afterChange = display:"inline-block" value:"打ちかけ..."
//   ダッシュボード（#global .addin）と右パネル（input.add）の両方で同じ。
//
// 実装の要点: 「閉じる」と「打ちかけを捨てる」を分離した。showAdd/showInput は表示だけを
// 切り替え、破棄は clearAdd/clearInput が担う。blur は値が入っていれば捨てない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../extensions/kanban.ts", import.meta.url).pathname, "utf8");

const grab = (re) => [...SRC.matchAll(re)].map((m) => m[0]);

const showAdds = grab(/function showAdd\(on\)\{[\s\S]*?\n      \}/g);
const showInputs = grab(/var showInput = function\(on\)\{[\s\S]*?\n        \};/g);
const clearAdds = grab(/function clearAdd\(\)\{[\s\S]*?\n      \}/g);
const clearInputs = grab(/var clearInput = function\(\)\{[\s\S]*?\n        \};/g);
const blurAdds = grab(/addIn\.addEventListener\("blur", function\(\)\{[\s\S]*?\n      \}\);/g);
const blurInputs = grab(/input\.addEventListener\("blur", function\(\)\{[\s\S]*?\n        \}\);/g);

test("#75: addDraft が両テンプレートに定義されている", () => {
	const defs = grab(/var addDraft = \{\};[^\n]*/g);
	assert.equal(defs.length, 2, "DASHBOARD_HTML と KANBAN_HTML の2つであるべき");
});

test("#75: showAdd / showInput は表示の切替だけを行い、打ちかけを捨てない", () => {
	assert.equal(showAdds.length, 1, "showAdd が1つ見つかること");
	assert.equal(showInputs.length, 1, "showInput が1つ見つかること");
	for (const [name, body] of [["showAdd", showAdds[0]], ["showInput", showInputs[0]]]) {
		assert.ok(!body.includes("delete addDraft"), `${name} が打ちかけを捨てている（clear* に分離すること）`);
		assert.ok(!body.includes('= ""'), `${name} が値を消している（clear* に分離すること）`);
	}
});

test("#75: 破棄は clearAdd / clearInput が担う", () => {
	assert.equal(clearAdds.length, 1, "clearAdd が1つ見つかること");
	assert.equal(clearInputs.length, 1, "clearInput が1つ見つかること");
	for (const [name, body] of [["clearAdd", clearAdds[0]], ["clearInput", clearInputs[0]]]) {
		assert.ok(body.includes("delete addDraft[ckey]"), `${name} が addDraft を捨てていない`);
	}
});

test("#75: 描画時に addDraft から開閉と打ちかけを復元する", () => {
	// 復元は「値があれば input.value に戻し、キーの有無で開閉を決める」の2点。
	const restores = grab(/if \(addDraft\[ckey\] != null\) (?:addIn|input)\.value = addDraft\[ckey\];/g);
	assert.equal(restores.length, 2, "両テンプレートで復元していること");
	const opens = grab(/show(?:Add|Input)\(addDraft\[ckey\] != null\);/g);
	assert.equal(opens.length, 2, "キーの有無で開閉を決めていること");
});

test("#75: 入力イベントが addDraft に書き戻す", () => {
	const writers = grab(/addEventListener\("input", function\(\)\{ addDraft\[ckey\] = (?:addIn|input)\.value; \}\);/g);
	assert.equal(writers.length, 2, "両テンプレートで打鍵を保持していること");
});

test("#75: blur は値が入っていれば捨てない", () => {
	assert.equal(blurAdds.length, 1, "ダッシュボードの blur が1つ見つかること");
	assert.equal(blurInputs.length, 1, "右パネルの blur が1つ見つかること");
	// ダッシュボードは送信中も閉じない（既存の二重クローズ対策を残す）
	assert.ok(
		/if \(sending \|\| addIn\.value\.trim\(\)\) return;/.test(blurAdds[0]),
		"ダッシュボードの blur に「送信中 or 値あり」の早期 return が無い",
	);
	assert.ok(
		/if \(input\.value\.trim\(\)\) return;/.test(blurInputs[0]),
		"右パネルの blur に「値あり」の早期 return が無い",
	);
});

test("#75: Escape と Enter 確定は明示的に捨てる", () => {
	// Escape は値を捨てて閉じる。Enter は送信後に捨てる。どちらも clear* 経由。
	const escapes = grab(/if \(e\.key === "Escape"\) \{ e\.preventDefault\(\); clear(?:Add|Input)\(\); show(?:Add|Input)\(false\); return; \}/g);
	assert.equal(escapes.length, 2, "両テンプレートの Escape が clear* を通ること");
	assert.ok(
		/var v = addIn\.value\.trim\(\);\n        clearAdd\(\);/.test(SRC),
		"ダッシュボードの Enter 確定が clearAdd を通ること",
	);
	assert.ok(
		/var v = input\.value\.trim\(\);\n          clearInput\(\);/.test(SRC),
		"右パネルの Enter 確定が clearInput を通ること",
	);
});

test("#75: 打鍵のたびに再描画しない（addDraft を sig に載せない）", () => {
	// addDraft は保持マップであって sig の材料ではない。sigOf に現れたら打鍵ごとに描画が走る。
	const sigOf = SRC.match(/function sigOf\(d\)\{[\s\S]*?\n  \}/);
	assert.ok(sigOf, "sigOf が見つかること");
	assert.ok(!sigOf[0].includes("addDraft"), "sigOf が addDraft を参照している（打鍵のたびに再描画される）");
});
