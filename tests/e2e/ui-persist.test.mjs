// The board's toggles are memory-only state that must survive a reload. The failure is quiet:
// a toggle that writes but never restores looks fine until the next refresh, when the done
// column comes back 60 cards long.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = f => readFileSync(path.resolve(here, "../../web/src", f), "utf8");
const render = read("render.ts");
const app = read("app.ts");
const store = read("store.ts");

test("the done column folds to its newest few, and only a done-kind column folds", () => {
  assert.match(store, /export const DONE_PREVIEW = \d+;/);
  // A project may name its done column anything; the kind is the truth, not the id.
  assert.match(render, /const foldable = isDoneColumn\(s, id\);/);
  assert.match(render, /foldable && !s\.doneOpen \? visible\.slice\(0, DONE_PREVIEW\)/,
    "the fold must slice the cards the column would otherwise draw");
  assert.match(render, /cv\.more\.hidden = !foldable \|\| visible\.length <= DONE_PREVIEW/,
    "the unfurl button belongs to the done column and appears only when it hides something");
});

test("the fold is a button under the column, and it only toggles display", () => {
  assert.match(render, /more\.addEventListener\('click', \(\) => h\.onToggleDone\(\)\)/);
  assert.match(render, /cv\.more\.setAttribute\('aria-pressed', String\(s\.doneOpen\)\)/);
  assert.match(app, /onToggleDone: \(\) => \{\s*store\.doneOpen = !store\.doneOpen;/);
  // The column count still reports every done card: folding is display only, never a filter.
  assert.match(render, /const n = cardsInColumn\(s, id\)\.length;/);
});

test("all three toggles ride in one key and are restored before the first render", () => {
  assert.match(app, /const UI_KEY = 'kb\.v2\.ui'/);
  assert.match(app, /deliverables: s\.panels\.deliverables, timeline: s\.panels\.timeline, doneOpen: s\.doneOpen/);
  // Module scope, not mount(): mount() renders immediately, so a later restore loses the first paint.
  assert.match(app, /const savedUi = readSavedUi\(\);[\s\S]*store\.doneOpen = savedUi\.doneOpen;/);
  assert.match(app, /store\.panels\.deliverables = savedUi\.deliverables;/);
});

test("every close path saves, not just the toggle buttons", () => {
  // Opening a pane and saving a template both hide the panels; an unsaved hide comes back on reload.
  assert.match(app, /function openPane[\s\S]*?saveUi\(store\);/, "openPane hides the panels");
  assert.match(app, /store\.pane = 'templates';\s*saveUi\(store\);/, "doSaveTemplate hides them too");
  assert.match(app, /onToggleDone: \(\) => \{[\s\S]*?saveUi\(store\);/, "onToggleDone saves the fold");
});

test("a broken or denied store falls back to closed instead of throwing", () => {
  assert.match(app, /if \(!raw \|\| typeof raw !== 'object'\) return none;/, "null must not reach the cast");
  assert.match(app, /catch \{ return none; \}/, "unparseable JSON must not take the board down on load");
  assert.match(app, /catch \{ \/\* private mode: the toggles just won't persist \*\/ \}/);
});
