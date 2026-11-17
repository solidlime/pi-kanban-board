// The keyboard cursor is pure arithmetic; the listener around it needs a real DOM, so the
// ordering (v1's clamping, which end an empty cursor lands on) is what a test can pin down.
import test from "node:test";
import assert from "node:assert/strict";
import "./_load.mjs";

const { stepKey, isTyping } = await import("../../web/src/keys.ts");

const rows = ["a#1", "a#2", "a#3"];

test("j from nothing selects the first card, k from nothing also lands there", () => {
  assert.equal(stepKey(rows, [], 1), "a#1");
  assert.equal(stepKey(rows, [], -1), "a#1", "v1 clamped state.sel at -1 instead of wrapping");
});

test("j/k walk one card and hold at both ends", () => {
  assert.equal(stepKey(rows, ["a#1"], 1), "a#2");
  assert.equal(stepKey(rows, ["a#2"], -1), "a#1");
  assert.equal(stepKey(rows, ["a#3"], 1), "a#3", "the last card is the end, not a wraparound");
  assert.equal(stepKey(rows, ["a#1"], -1), "a#1");
});

test("the last picked card is the cursor of a multi-card selection", () => {
  assert.equal(stepKey(rows, ["a#1", "a#2"], 1), "a#3");
});

test("a cursor that is no longer on screen restarts at the first card", () => {
  assert.equal(stepKey(rows, ["gone#9"], 1), "a#1");
  assert.equal(stepKey([], ["a#1"], 1), null, "an empty board has nowhere to go");
});

test("typing is any input, textarea or contenteditable — nothing else", () => {
  assert.equal(isTyping({ tagName: "INPUT" }), true);
  assert.equal(isTyping({ tagName: "TEXTAREA" }), true);
  assert.equal(isTyping({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(isTyping({ tagName: "DIV" }), false);
  assert.equal(isTyping({ tagName: "BUTTON" }), false, "a focused button still answers j/k");
  assert.equal(isTyping(null), false);
});
