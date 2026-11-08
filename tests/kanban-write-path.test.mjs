// #101: HTTP ルートは「盤面まるごと置換」ではなく mutateBoard（読み・コールバック・書き戻しが
// 1 つのロックの中）を通る。ここが writeBoard に戻れば、別プロセスのカードがまた deleteStaleCards
// に食われるが、挙動テスト（kanban-parallel）は mutateBoard を直叩きするので信号が出ない。
// 数で固定する。増減があったら、その変更がロックの外に出ていないかを必ず見てから数字を更新すること。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../extensions/kanban.ts", import.meta.url), "utf8");
const count = (re) => (SRC.match(re) ?? []).length;

// writeBoard は定義・内部委譲・global 分岐 2 本（どちらも手前の return fail で到達不能）だけ。
assert.equal(
	count(/writeBoard\(/g),
	4,
	"writeBoard の呼び口が増えた（ルートが盤面まるごと置換に戻っている疑い。ロックの外の書き込み）",
);
// mutateBoard は 25 箇所 = 定義 1 + コメント中の言及 1 + 実呼び口 23。
// （extensions/kanban.ts:1857 の "mutateBoard() holds the lock" も文字列としては数えられる）
assert.equal(count(/mutateBoard\(/g), 25, "mutateBoard の呼び口が変わった（ロックの内側にあるか確認して数字を更新）");
