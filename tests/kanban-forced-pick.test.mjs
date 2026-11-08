// #94: ダッシュボードの「+」で足した TODO は 5 分ゲートを待たずにループを起こす。
// 経路は「ルート (セッション ctx を持たない) -> モジュールスコープの郵便受け userPickAt ->
// 次の poll が forced として消費」なので、配線が抜けたら静かに 5 分待ちに戻る。
// tests/kanban-tool-schema.test.mjs と同じ流儀: ソースを文字列で読むだけで、server も
// jiti も要らない。挙動そのものは tests/kanban-auto-tick.test.mjs の実タイマー経路が守る。
// shortcut: ここは配線の静的な形だけ。forced の判定は autoTickVerdict の単体テスト、
// 合図の往復は kanban-auto-tick.test.mjs の liveTick (E)(F) が守っている。
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SOURCE = readFileSync(fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url)), "utf8");

const ADD_START = SOURCE.indexOf('case "/api/add": {');
const ADD_END = SOURCE.indexOf('case "/api/quickadd": {', ADD_START);
const MOVE = SOURCE.indexOf('case "/api/move": {', ADD_END);
if (ADD_START < 0 || ADD_END < 0 || MOVE < 0) throw new Error("/api/add / quickadd / move の case が見つからない");
const ADD = SOURCE.slice(ADD_START, ADD_END);
const QUICK = SOURCE.slice(ADD_END, MOVE);

// writeBoard は失敗を戻り値で返す（throw しない）。戻り値を見ない stamp は
// 「カードは保存されていないのに wake だけ出る」経路を作るので、ここで形を固定する。
const SUCCESS = "writeBoard(path, b) === null";

test("+ の TODO 追加は永続化が通ったときだけ stamp する", () => {
	assert.ok(ADD.includes(SUCCESS), "/api/add が writeBoard の戻り値を見ていない");
	const stamp = ADD.indexOf("userPickAt.set(");
	assert.ok(stamp > 0, "/api/add が合図を置かない");
	const line = ADD.slice(ADD.lastIndexOf("\n", stamp) + 1, ADD.indexOf("\n", stamp));
	assert.ok(line.includes(SUCCESS), "合図の条件に writeBoard の成功が入っていない");
	assert.ok(line.includes('col === "todo"'), "TODO 以外でも合図を置いている");
});

test("stamp の slug は書き込み先と同じボードキー", () => {
	// poll 側は storedProjectKey(projectSlugOf(cwd)) で照合する。slug を引き直すと綴りがズレ得る。
	assert.match(ADD, /userPickAt\.set\(storedProjectKey\(boardKeyOf\(path\)\.sid\), Date\.now\(\)\)/);
});

test("+ の複数行経路（quickadd）も 1 枚以上入ったときだけ合図を置く", () => {
	// 入力欄は 1 行なら /api/add、複数行やトークン付きなら /api/quickadd に振り分けられる
	// （web/dash/_app.js:891）。quickadd はトークンだけの行を捨てて cards 0 件を返し得るので、
	// 0 件で stamp すると「#tag と打っただけ」で wake が出る。
	assert.match(QUICK, /if \(parsed\.cards\.length > 0 && writeBoard\(path, b\) === null\) userPickAt\.set\(/);
});

test("poll は郵便受けを forced として渡し、発火したら消す", () => {
	assert.match(SOURCE, /const forcedAt = userPickAt\.get\(key\) \?\? 0;/);
	assert.match(SOURCE, /const forced = forcedAt > lastTickAt && now - forcedAt < AUTO_TICK_MS;/);
	assert.match(SOURCE, /\n\t{5}forced,\n/);
	const fire = SOURCE.indexOf("if (!v.fire) continue;");
	const drop = SOURCE.indexOf("userPickAt.delete(key);", fire);
	assert.ok(fire >= 0 && drop > fire, "delete は発火ブロックの中（1 回きりの合図）");
});

test("期限切れの合図は読んだ場所で捨てる（Map が溜まらない）", () => {
	assert.match(SOURCE, /if \(!forced && forcedAt !== 0\) userPickAt\.delete\(key\);/);
});

test("trace は強制発火を fire:forced として区別する", () => {
	// v.fire だけだと「interval 300s なのに 8 秒で撃った」行が説明できず、README とも食い違う。
	assert.match(SOURCE, /v\.reason === "forced" \? "fire:forced" : "fire"/);
	assert.match(SOURCE, /return \{ fire: true, quiet, reason: "forced" \}/);
});
