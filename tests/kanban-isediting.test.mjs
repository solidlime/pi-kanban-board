// #70 回帰: 編集中判定が「打鍵を受け付ける入力」だけを拾い、静止要素では止まらないこと。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = new URL("../extensions/kanban.ts", import.meta.url).pathname;
const defs = [...readFileSync(SRC, "utf8").matchAll(/var NO_TYPE_INPUT[\s\S]*?\n  \}/g)].map(m => m[0]);

const el = (tagName, opts = {}) => ({
  tagName, type: opts.type, isContentEditable: opts.ce === true,
  closest: () => (opts.inRegion ? {} : null),
});
const evalTpl = (body, active) =>
  new Function("document", body + "\nreturn isEditing;")({ activeElement: active })();

const CASES = [
  // 止まるべき（打鍵を受け付ける）
  ["textarea.ted", el("TEXTAREA", { inRegion: true }), true],
  ["input[type=number] in #stats", el("INPUT", { type: "number", inRegion: true }), true],
  ["input[type=text] in #sessions", el("INPUT", { type: "text", inRegion: true }), true],
  ["input (type 未指定) in #global", el("INPUT", { inRegion: true }), true],
  ["input[type=datetime-local]", el("INPUT", { type: "datetime-local", inRegion: true }), true],
  ["contenteditable in #global", el("DIV", { inRegion: true, ce: true }), true],
  // 止まってはいけない
  ["#q 検索（領域外）", el("INPUT", { type: "text" }), false],
  ["input in #stats（領域外）", el("INPUT", { type: "text" }), false],
  ["checkbox in #serve", el("INPUT", { type: "checkbox", inRegion: true }), false],
  ["radio in #global", el("INPUT", { type: "radio", inRegion: true }), false],
  ["range in #stats", el("INPUT", { type: "range", inRegion: true }), false],
  ["button in #sessions", el("BUTTON", { inRegion: true }), false],
  ["body", { tagName: "BODY" }, false],
  ["activeElement null", null, false],
];

test("#70 isEditing: 両テンプレートに定義がある", () => {
  assert.equal(defs.length, 2, "DASHBOARD_HTML と KANBAN_HTML の2つ");
});

test("#70 isEditing: 打鍵要素だけを編集中と判定する（両テンプレート）", () => {
  for (const [i, body] of defs.entries()) {
    for (const [name, active, want] of CASES) {
      assert.equal(evalTpl(body, active), want, `template${i + 1}: ${name}`);
    }
  }
});
