// Multi-select: right-click menu, marquee on empty board space, and the selection bar.
// The failure this guards is quiet — a card-press that starts a marquee breaks DnD, a marquee
// that clears the selection on a plain click loses work, and a selection that survives a board
// switch deletes cards nobody is looking at.
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

test("every card carries a contextmenu handler that opens the menu instead of the browser's", () => {
  // Assigned (not added) in the keyed loop: the node cache reuses the element across renders.
  assert.match(render, /node\.oncontextmenu = \(ev\) => \{\s*ev\.preventDefault\(\);\s*openCardMenu\(view, s, key, ev\.clientX, ev\.clientY\);/);
  assert.match(render, /function openCardMenu\(view: View, s: Store, key: CardKey, x: number, y: number\): void \{/);
  // The menu offers what v1's ctxCardItems offered, in the same order.
  assert.match(render, /\{ label: '編集…', run: \(\) => h\.onEdit\(key\) \}/);
  assert.match(render, /\{ label: '詳細を開く', run: \(\) => h\.onOpen\(key\) \}/);
  assert.match(render, /run: \(\) => h\.onMove\(key, id\) \}\)\),/);
  assert.match(render, /label: `優先度 \+1（今 \$\{n\}）`, run: \(\) => h\.onSetPriority\(key, n \+ 1\), disabled: n >= 99/);
  assert.match(render, /label: `優先度 −1（今 \$\{n\}）`, run: \(\) => h\.onSetPriority\(key, n - 1\), disabled: n <= -99/);
  assert.match(render, /\{ label: '削除', run: \(\) => h\.onDelete\(key\), danger: true \}/);
  // Outside click, Escape and scroll close it; the listeners exist only while it is open.
  assert.match(render, /document\.addEventListener\('pointerdown', onDoc, true\);/,
    "pointerdown, not click: a press that never moves still closes the menu");
  // The menu marks its own Esc handled, so keys.ts's Esc chain stops here instead of clearing
  // the selection underneath the menu that just closed.
  assert.match(render, /if \(ev\.key === 'Escape'\) \{ ev\.preventDefault\(\); closeCardMenu\(\); \}/);
  assert.match(render, /document\.addEventListener\('scroll', onDoc, true\);/);
});

test("a press that starts on a card is left to DnD, not turned into a marquee", () => {
  assert.match(render, /if \(ev\.button !== 0 \|\| ev\.pointerType === 'touch'\) return;/,
    "only the primary mouse button starts a marquee, and touch never does");
  assert.match(render, /if \(t\.closest\('\.card, button, input, textarea, select, a, \.col-h, \.addrow'\)\) return;/,
    "the card, every control and the column header must be excluded from the start condition");
});

test("the marquee picks by rect intersection and waits for 4px of movement", () => {
  assert.match(render, /const b = node\.getBoundingClientRect\(\);/);
  assert.match(render, /const on = b\.left < x2 && b\.right > x1 && b\.top < y2 && b\.bottom > y1;/,
    "a card the box only clips must still be selected (elementFromPoint would miss it)");
  assert.match(render, /board\.querySelectorAll<HTMLElement>\('\.card\[data-key\]'\)/);
  assert.match(render, /if \(Math\.abs\(ev\.clientX - drag\.x\) < 4 && Math\.abs\(ev\.clientY - drag\.y\) < 4\) return;/,
    "under 4px it is still a click, so the old selection survives");
  assert.match(render, /const picked = drag\.rect \? drag\.hits : null;\s*stop\(\);\s*(?:.*\n)*?\s*if \(picked\) h\.onSelect\(picked\);/,
    "the box and highlight must be gone before onSelect re-renders the board");
});

test("the selection bar moves through onMove and deletes through onDeleteMany", () => {
  assert.match(render, /const move = keys\.filter\(k => s\.cards\[k\]\.columnId !== id\);/,
    "only cards with somewhere to go are moved");
  assert.match(render, /b\.disabled = move\.length === 0;/,
    "a column everyone is already in cannot be a destination");
  assert.match(render, /for \(const k of move\) h\.onMove\(k, id\);\s*h\.onSelect\(\[\]\);/);
  assert.match(render, /del\.addEventListener\('click', \(\) => h\.onDeleteMany\(keys\)\);/);
  assert.match(render, /clear\.addEventListener\('click', \(\) => h\.onSelect\(\[\]\)\);/);
  assert.match(app, /onSelect: keys => \{ store\.selection = new Set\(keys\); render\(\); \}/);
  assert.match(app, /onDeleteMany: keys => \{ void doDeleteMany\(keys\); \}/);
  // The bar counts only cards still on the board, but never prunes the Set while rendering.
  assert.match(render, /const keys = \[\.\.\.s\.selection\]\.filter\(k => s\.cards\[k\]\);/);
  // The fixed side panels paint over the bar's corner; a visible-but-unpressable bar is worse.
  assert.match(render, /\|\| !view\.panelDeliv\.hidden \|\| !view\.panelHist\.hidden \|\| s\.pane !== 'none';/);
});

test("one confirmation deletes the lot, and both paths go through one scheduler", () => {
  assert.match(app, /if \(!window\.confirm\(`カード \$\{live\.length\} 件を削除する？`\)\) return;/);
  // doDelete and doDeleteMany must not each own a commit path.
  assert.equal((app.match(/pendingDeletes\.set\(/g) ?? []).length, 1, "pendingDeletes is written in scheduleDelete only");
  assert.match(app, /function scheduleDelete\(key: CardKey, card: Card, delay: number\): void \{/);
  // A delete nobody can undo must not keep the server waiting.
  assert.match(app, /scheduleDelete\(key, card, 0\);/);
  assert.match(app, /scheduleDelete\(key, card, UNDO_MS\);/);
  assert.match(app, /store\.selection = new Set\(\);\s*render\(\);\s*showToast\(view, `\$\{live\.length\} 件のカードを削除`\);/);
});

test("a card that leaves the board leaves the selection too", () => {
  // Undo would otherwise bring the card back already picked, and the bar back with it.
  assert.match(store, /export function vanishCard\(s: Store, key: CardKey\): void \{[\s\S]*?s\.selection\.delete\(key\);/);
});

test("switching boards drops the selection", () => {
  // Another board's keys would delete cards nobody can see.
  assert.match(store, /export function resetBoard\(s: Store, projectId: string \| null\): void \{[\s\S]*?s\.selection = new Set\(\);[\s\S]*?\n\}/);
  assert.match(store, /\/\*\* Cards picked by marquee or right-click; empty = none\. \*\/\s*selection: Set<CardKey>;/);
  assert.match(store, /pending: new Set\(\), selection: new Set\(\), vanishing: new Set\(\),/);
});
