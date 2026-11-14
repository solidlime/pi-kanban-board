// `/kanban` argv splitting. This exists because the inline version read /\\s+/ — a literal
// backslash — which never split, so every subcommand fell through to "add a card".
import "./_load.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const { parseCommandArgs } = await import("../../src/core/command.ts");

test("splits on runs of whitespace, including the ideographic space", () => {
  assert.deepEqual(parseCommandArgs("add 買い物"), ["add", "買い物"]);
  assert.deepEqual(parseCommandArgs("  move   3   done  "), ["move", "3", "done"]);
  assert.deepEqual(parseCommandArgs("add\u3000全角"), ["add", "全角"]);
});

test("empty and undefined input yield no words (never a blank card)", () => {
  assert.deepEqual(parseCommandArgs(undefined), []);
  assert.deepEqual(parseCommandArgs("   "), []);
});

test("a subcommand never merges into the rest of the line", () => {
  // The regression: with the broken regex this returned ["add 買い物"], so the switch never
  // matched and the whole line became a card title.
  const argv = parseCommandArgs("move 3 done");
  assert.equal(argv.length, 3);
  assert.equal(argv[0], "move");
});
