// The board's drag & drop is wiring, not logic: a card carries its key in text/plain and a
// column hands it to onMove. Guard the wiring statically — a browser is not needed to see
// that the render layer still owns no HTTP call of its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/src/render.ts"), "utf8",
);

test("board DnD: the card is the handle and the column routes the drop to onMove", () => {
  assert.match(source, /node\.draggable = true/, "cards are draggable");
  assert.match(source, /setData\('text\/plain', key\)/, "the card key rides in text/plain");
  assert.match(source, /h\.onMove\(key, id\)/, "a drop moves the card through the handler");
  assert.match(source, /addEventListener\('dragover'/, "a column accepts drags");
});

test("board DnD: the render layer never talks to the API itself", () => {
  assert.ok(!/fetch\(|moveCard\(|from '\.\/api\.js'/.test(source.replace(/^import[^;]*;$/gm, "")),
    "moves go through Handlers, so the store stays the single writer");
});
