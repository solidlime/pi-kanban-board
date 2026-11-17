// 成果物パネルの並びと絞込は store の純粋関数。API の返す順に頼らず、id で決める。
import test from "node:test";
import assert from "node:assert/strict";
import "./_load.mjs";

const { createStore, panelDeliverables } = await import("../../web/src/store.ts");

const del = (id, title) => ({ projectId: "demo", id, title, ref: `r${id}`, kind: "file" });
const withItems = (ids, extra = {}) => {
  const s = createStore();
  s.deliverables = ids.map(n => del(n, n === 9 ? "Design Doc" : `成果物 ${n}`));
  return Object.assign(s, extra);
};

test("既定は新→旧（id 降順）", () => {
  const s = withItems([3, 1, 2]);
  assert.equal(s.delSort, "new");
  assert.deepEqual(panelDeliverables(s).map(d => d.id), [3, 2, 1]);
});

test("old は id 昇順", () => {
  assert.deepEqual(panelDeliverables(withItems([3, 1, 2], { delSort: "old" })).map(d => d.id), [1, 2, 3]);
});

test("id は数値で比べる（文字列比較だと 10 が 9 より前に来る）", () => {
  assert.deepEqual(panelDeliverables(withItems([10, 9, 2], { delSort: "old" })).map(d => d.id), [2, 9, 10]);
  assert.deepEqual(panelDeliverables(withItems([10, 9, 2])).map(d => d.id), [10, 9, 2]);
});

test("並べ替えは元の配列を壊さない", () => {
  const s = withItems([3, 1, 2]);
  panelDeliverables(s);
  assert.deepEqual(s.deliverables.map(d => d.id), [3, 1, 2]);
});

test("検索語があるときは title の部分一致だけ（大小無視）", () => {
  const s = withItems([1, 9, 2], { q: "design" });
  assert.deepEqual(panelDeliverables(s).map(d => d.id), [9]);
  // 絞込でも並びは同じ規則
  assert.deepEqual(panelDeliverables(withItems([1, 9, 2], { q: "成果", delSort: "old" })).map(d => d.id), [1, 2]);
});

test("一致0件は空、空白だけの検索語は絞り込まない", () => {
  assert.deepEqual(panelDeliverables(withItems([1, 2], { q: "nope" })), []);
  assert.deepEqual(panelDeliverables(withItems([1, 2], { q: "   " })).map(d => d.id), [2, 1]);
});
