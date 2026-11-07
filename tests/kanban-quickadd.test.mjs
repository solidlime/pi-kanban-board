// #50: Quick Add 行パーサ。HTTP 層（/api/quickadd の route）は対象外、parseQuickAdd だけを見る。
// サーバは起動しない。HOME だけ差し替えて本番の ~/.pi/kanban に触れないようにする。
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";

const HOME_DIR = tmpdir() + "/kb-quickadd-home";
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(`${HOME_DIR}/.pi/kanban/sessions`, { recursive: true });
process.env.HOME = HOME_DIR;
process.env.USERPROFILE = HOME_DIR; // Windows: os.homedir() は USERPROFILE を優先する

const { createJiti } = createRequire(import.meta.url)(
	process.env.KANBAN_JITI ?? createRequire(import.meta.url).resolve("jiti"),
);
const mod = await createJiti(import.meta.url).import(fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url)));
const { parseQuickAdd } = mod;

const ok = (r) => {
	assert.equal(r.ok, true, r.ok ? "" : `parse が落ちた: ${r.error}`);
	return r.cards;
};

test("quickadd: 素の1行は todo のカード1枚", () => {
	const cards = ok(parseQuickAdd("牛乳を買う", 1));
	assert.equal(cards.length, 1);
	assert.deepEqual({ id: cards[0].id, text: cards[0].text, col: cards[0].col }, { id: 1, text: "牛乳を買う", col: "todo" });
	assert.equal(cards[0].project, undefined);
	assert.equal(cards[0].due, undefined);
	assert.equal(cards[0].estimate, undefined);
});

test("quickadd: #project は normalizeProject を通る", () => {
	const cards = ok(parseQuickAdd("#pi-kanban 板を直す", 1));
	assert.equal(cards[0].project, "pi-kanban");
	assert.equal(cards[0].text, "板を直す");
});

test("quickadd: !N は estimate で 1..5 に clamp", () => {
	assert.deepEqual(ok(parseQuickAdd("!2 中くらい", 1))[0].estimate, 2);
	assert.deepEqual(ok(parseQuickAdd("!9 重い", 1))[0].estimate, 5);
	assert.deepEqual(ok(parseQuickAdd("!0 軽い", 1))[0].estimate, 1);
	// 数字でない !x はトークンではない → 本文に残る
	const t = ok(parseQuickAdd("!x ただの本文", 1))[0];
	assert.equal(t.text, "!x ただの本文");
	assert.equal(t.estimate, undefined);
});

test("quickadd: due: は parseDue と同じ規約、不正は ok:false", () => {
	assert.equal(ok(parseQuickAdd("due:2026-12-01 締切", 1))[0].due, "2026-12-01");
	const r = parseQuickAdd("due:2026-13-01 締切", 1);
	assert.equal(r.ok, false);
	assert.match(r.error, /due must be YYYY-MM-DD/);
});

test("quickadd: 3種トークンの併用と重複（最初の1個だけ採用）", () => {
	const c = ok(parseQuickAdd("#a #b !2 !4 due:2026-01-02 due:2027-03-04 本文 続き", 1))[0];
	assert.equal(c.project, "a");
	assert.equal(c.estimate, 2);
	assert.equal(c.due, "2026-01-02");
	assert.equal(c.text, "本文 続き");
});

test("quickadd: 複数行 + インデントで子カード（blocks = [親id]）", () => {
	const cards = ok(parseQuickAdd("親のカード\n\t子1\n  子2\n別の親", 7));
	assert.equal(cards.length, 4);
	assert.deepEqual(cards.map((c) => c.id), [7, 8, 9, 10]);
	assert.deepEqual(cards.map((c) => c.text), ["親のカード", "子1", "子2", "別の親"]);
	assert.equal(cards[0].blocks, undefined);
	assert.deepEqual(cards[1].blocks, [7]);
	assert.deepEqual(cards[2].blocks, [7]);
	assert.equal(cards[3].blocks, undefined);
});

test("quickadd: トークンだけの行は skip、// と空行も skip", () => {
	const cards = ok(parseQuickAdd("#proj !2 due:2026-05-06\n\n// コメント行\n本文だけ", 1));
	assert.equal(cards.length, 1);
	assert.equal(cards[0].text, "本文だけ");
	// skip した行は id を消費しない（親の無い子行は独立カード）
	const lone = ok(parseQuickAdd("\t親の無い子", 1));
	assert.equal(lone.length, 1);
	assert.equal(lone[0].text, "親の無い子");
	assert.equal(lone[0].blocks, undefined);
});

test("quickadd: text が 8KB を超えたら ok:false", () => {
	const over = "あ".repeat(2800); // UTF-8 で 8.2KB
	const r = parseQuickAdd(over, 1);
	assert.equal(r.ok, false);
	assert.match(r.error, /8KB/);
	assert.equal(parseQuickAdd("あ".repeat(2700), 1).ok, true);
});
