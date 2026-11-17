// v1's global key map, ported. What breaks quietly: a key that fires while typing in a field,
// an Esc that clears the selection on top of closing the menu that was open, and a j/k that
// walks the store's order instead of the order on screen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = f => readFileSync(path.resolve(here, "../../web/src", f), "utf8");
const keys = read("keys.ts");
const render = read("render.ts");
const app = read("app.ts");

test("one document-level keydown listener, installed once", () => {
  assert.equal(keys.match(/document\.addEventListener\('keydown'/g)?.length, 1);
  assert.equal(keys.match(/installKeys\(/g)?.length, 1, "the listener lives inside installKeys");
  assert.equal(app.match(/^installKeys\(\{/gm)?.length, 1);
});

test("repeat, modifiers and typing fields are dead before any key is read", () => {
  assert.match(keys, /if \(ev\.repeat\) return;/);
  assert.match(keys, /if \(ev\.metaKey \|\| ev\.ctrlKey \|\| ev\.altKey\) return;/,
    "v1 had no other chord; Ctrl/Cmd+K is not wired yet");
  assert.match(keys, /if \(typing\) return;/);
  assert.match(keys, /return tag === 'input' \|\| tag === 'textarea' \|\| n\.isContentEditable === true;/);
});

test("Esc stops at the first surface that handled it, and a dialog is that surface", () => {
  assert.match(keys, /if \(ev\.defaultPrevented\) return;/);
  assert.match(keys, /if \(typing\) \{ \(ev\.target as HTMLElement\)\.blur\(\); return; \}/);
  assert.match(keys, /if \(document\.querySelector\('dialog\[open\]'\)\) return;/);
  // The three v2 surfaces must mark their own Esc, or keys.ts would run the next stage too.
  assert.match(render, /if \(ev\.key === 'Escape'\) \{ ev\.preventDefault\(\); closeCardMenu\(\); \}/);
  assert.match(render, /if \(ev\.key === 'Escape'\) \{ ev\.preventDefault\(\); h\.onCloseSearch\(\); q\.blur\(\); \}/);
  assert.match(render, /if \(ev\.key === 'Escape' && !qres\.hidden\) \{ ev\.preventDefault\(\); h\.onCloseSearch\(\); \}/);
});

test("j/k walk the screen order and hold at the ends", () => {
  assert.match(keys, /querySelectorAll<HTMLElement>\('\.card\[data-key\], \.focus-row\[data-key\]'\)/);
  assert.match(keys, /if \(!n\.closest\('\[hidden\]'\)\) out\.push/,
    "the hidden surface (focus rows vs board) keeps its nodes across renders");
  assert.match(keys, /Math\.max\(0, Math\.min\(keys\.length - 1, at \+ delta\)\)/,
    "v1 clamped instead of wrapping");
  assert.match(keys, /\.scrollIntoView\(\{ block: 'nearest' \}\)/);
});

test("Enter opens the detail dialog, d jumps into DOING, / and c focus a field", () => {
  assert.match(keys, /case 'Enter':[\s\S]*?actions\.onOpen\(key\);/);
  assert.match(keys, /case 'd':[\s\S]*?actions\.doingFirst\(\)/);
  assert.match(keys, /querySelector<HTMLInputElement>\('input\.q'\)/);
  assert.match(keys, /\.board \.col\[data-col="todo"\] \.addrow input/);
  assert.match(keys, /\.board \.col \.addrow input/, "a project without a todo column still gets a field");
  // The wiring: the selection is the store's, and `d` reads the doing-kind column, not an id.
  assert.match(app, /onSelect: keys => \{ store\.selection = new Set\(keys\); render\(\); \}/);
  assert.match(app, /store\.columnOrder\.find\(c => store\.columns\[c\]\?\.kind === 'doing'\)/);
  assert.match(app, /onOpen: key => detail\.open\(key\)/);
});

test("1-9 switch boards through the picker, and 0 is absent (v2 has no aggregate board)", () => {
  assert.match(keys, /if \(ev\.key >= '1' && ev\.key <= '9'\)/);
  assert.match(keys, /querySelector<HTMLSelectElement>\('\.pick select'\)/);
  assert.match(keys, /sel\.dispatchEvent\(new Event\('change'\)\)/);
  assert.doesNotMatch(keys, /'0'/, "v1's 0 = 全ボード has no v2 target");
});

test("no key v1 did not have, and no palette behind Ctrl/Cmd+K yet", () => {
  assert.doesNotMatch(keys, /'Arrow(Left|Right|Up|Down)'/);
  for (const k of ["g", "p", "r", "s", "x", "?"]) assert.doesNotMatch(keys, new RegExp(`case '${k.replace("?", "\\?")}'`));
  assert.match(keys, /TODO: Ctrl\/Cmd\+K belongs to a search palette v2 does not draw yet/);
  assert.doesNotMatch(keys, /ctrlKey \|\| ev\.metaKey\) && ev\.key\.toLowerCase\(\) === 'k'/);
});
