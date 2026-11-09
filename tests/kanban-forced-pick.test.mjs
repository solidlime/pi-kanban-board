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

// #101: 書き込みは mutateBoard の中なので、成否は「ロックの中で立てた writeOk」と
// 「mutateBoard の戻り値が null（throw していない）」の両方で持つ。writeOk だけだと
// BEGIN IMMEDIATE の失敗（戻り値が文字列）を見落とし、保存できていないのに wake が出る。
const SUCCESS = "persistError === null && writeOk";

test("+ の TODO 追加は永続化が通ったときだけ stamp する", () => {
	assert.ok(ADD.includes("const persistError = mutateBoard(path, (b) => {"), "/api/add がロック内の書き込みと成否の受け取りを使っていない");
	const stamp = ADD.indexOf("userPickAt.set(");
	assert.ok(stamp > 0, "/api/add が合図を置かない");
	const line = ADD.slice(ADD.lastIndexOf("\n", stamp) + 1, ADD.indexOf("\n", stamp));
	assert.ok(line.includes(SUCCESS), "合図の条件に書き込み成功が入っていない");
	assert.ok(line.includes('col === "todo"'), "TODO 以外でも合図を置いている");
});

test("stamp の slug は書き込み先と同じボードキー", () => {
	// poll 側は storedProjectKey(projectSlugOf(cwd)) で照合する。slug を引き直すと綴りがズレ得る。
	assert.match(ADD, /userPickAt\.set\(storedProjectKey\(boardKeyOf\(path\)\.sid\), Date\.now\(\)\)/);
});

test("#108: quickadd は入力欄の列を使う（常に todo に作らない）", () => {
	assert.match(QUICK, /parseQuickAdd\(q\.get\("text"\) \?\? "", b\.nextId, col\)/, "quickadd が列を落としている");
	assert.match(QUICK, /const col = parseCol\(colParam\) \?\? "todo";/, "quickadd が col を既定 todo で受けない");
	assert.ok(QUICK.includes('colParam === "deliverable"'), "quickadd が deliverable を列として受ける");
});

test("+ の複数行経路（quickadd）も 1 枚以上かつ TODO のときだけ合図を置く", () => {
	// 入力欄は 1 行なら /api/add、複数行やトークン付きなら /api/quickadd に振り分けられる
	// （web/dash/_app.js:891）。quickadd はトークンだけの行を捨てて cards 0 件を返し得るので、
	// 0 件で stamp すると「#tag と打っただけ」で wake が出る。
	// #108: 列が可変になったので、DOING/DONE 直行（ループの仕事ではない）でも発火しないよう
	// 列の条件まで固定する（/api/add:5058 と同じ門）。条件を書かないと、誰かが消しても通る。
	assert.ok(QUICK.includes("added > 0 && col === "), "quickadd の合図が列を見ていない");
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
