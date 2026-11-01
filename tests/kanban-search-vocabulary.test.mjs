// #32: 検索欄が「何を探すか」を名乗っていない。cardHit は text/project/sid/sessionId/commit/
// blocked/labels を見るのに、placeholder は本文・#番号・project・commit しか書いていない。
// 画面と README が cardHit の語彙と 1 対 1 であることを固定する（片方だけ増やしたら落ちる）。
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const html = readFileSync(new URL("../web/dashboard.html", import.meta.url), "utf8");
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

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

// cardHit が読むフィールド ↔ 人間に見せる語。
const WORD = {
	id: "#番号",
	text: "本文",
	project: "project",
	sid: "sid",
	sessionId: "session",
	commit: "commit",
	blocked: "blocked",
	labels: "label",
};

const hitStart = html.indexOf("function cardHit(");
const hitBody = html.slice(hitStart, html.indexOf("\n  }", hitStart));
const fields = [...new Set([...hitBody.matchAll(/c\.(\w+)/g)].map((m) => m[1]))].sort();

const placeholder = (html.match(/id="q"[^>]*placeholder="([^"]*)"/) || [])[1] || "";
// 対象を列挙している行は README に 1 行だけ。増えたら find が両方拾って曖昧になるので固定する。
const readmeLines = readme.split("\n").filter((l) => l.includes("検索") && l.includes("#番号"));

check("cardHit の対象フィールドは WORD の見出しと一致する（語を足したら表も足す）", () => {
	assert.deepEqual(fields, Object.keys(WORD).sort(), `cardHit のフィールドが変わった: ${fields.join(",")}`);
});

check("placeholder は検索対象の語を全部名乗る", () => {
	assert.ok(placeholder !== "", "#q の placeholder が読めない");
	for (const f of fields) {
		assert.ok(placeholder.includes(WORD[f]), `placeholder に「${WORD[f]}」が無い: ${placeholder}`);
	}
});

check("README の Dashboard 節も同じ語彙を名乗る", () => {
	assert.equal(readmeLines.length, 1, `対象を列挙した行が ${readmeLines.length} 行ある`);
	for (const f of fields) {
		assert.ok(readmeLines[0].includes(WORD[f]), `README に「${WORD[f]}」が無い`);
	}
});

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exitCode = failures.length === 0 ? 0 : 1;
