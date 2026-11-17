// The viewer's only real decision is "which box does this file deserve": the client never sees a
// mime for a deliverable (only the ref's extension), and the server's EXT_MIME is the same table.
// The dialog wiring itself needs a DOM, so what a test can pin is the wiring's shape.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "./_load.mjs";

const { kindOf } = await import("../../web/src/viewer.ts");

test("an extension picks the box: image / video / pdf / markdown / html / other", () => {
  for (const n of ["a.png", "a.JPG", "a.jpeg", "a.gif", "a.webp"]) assert.equal(kindOf(n), "image", n);
  for (const n of ["clip.mp4", "clip.webm", "clip.mov"]) assert.equal(kindOf(n), "video", n);
  assert.equal(kindOf("doc.pdf"), "pdf");
  assert.equal(kindOf("notes.md"), "markdown");
  assert.equal(kindOf("notes.markdown"), "markdown");
  assert.equal(kindOf("notes.txt"), "markdown", "sendFileView renders text/* as the same article");
  assert.equal(kindOf("data.csv"), "markdown");
  assert.equal(kindOf("page.html"), "html");
  assert.equal(kindOf("page.htm"), "html", "an .htm page must not land in the markdown article");
  for (const n of ["pack.zip", "blob", ""]) assert.equal(kindOf(n), "other", n);
});

test("an attachment's stored mime outranks its name (the bytes are sniffed on upload)", () => {
  assert.equal(kindOf("photo", "image/png"), "image");
  assert.equal(kindOf("photo.bin", "video/mp4"), "video");
  assert.equal(kindOf("x", "application/pdf"), "pdf");
  assert.equal(kindOf("x", "text/html; charset=utf-8"), "html");
  assert.equal(kindOf("x", "application/zip"), "other");
});

const here = path.dirname(fileURLToPath(import.meta.url));
const read = f => readFileSync(path.resolve(here, "../../web/src", f), "utf8");
const viewer = read("viewer.ts");
const detail = read("detail.ts");

test("every close path exists: Esc, the ✕ button and a backdrop click", () => {
  assert.match(viewer, /addEventListener\('cancel'/);
  assert.match(viewer, /if \(ev\.target === dlg\) close\(\)/, "a click on the dialog itself is the backdrop");
  assert.match(viewer, /closeBtn\.addEventListener\('click', close\)/);
});

test("closing empties the body so a video cannot keep playing behind the dialog", () => {
  assert.match(viewer, /function reset\(\)[\s\S]*?body\.replaceChildren\(\)/);
  assert.match(viewer, /dlg\.addEventListener\('close', reset\)/, "the native close (Esc) must reset too");
});

test("arrows step the list; every other key stops at the dialog", () => {
  assert.match(viewer, /ev\.key === 'ArrowLeft'[\s\S]*?show\(at - 1\)/);
  assert.match(viewer, /ev\.key === 'ArrowRight'[\s\S]*?show\(at \+ 1\)/);
  assert.match(viewer, /ev\.stopPropagation\(\)/,
    "keys.ts listens on document: a modal owns every key while it is up, as v1's lightbox did");
  assert.doesNotMatch(viewer, /from '\.\/detail\.js'/, "viewer must not import detail.ts");
});

test("the counter is 1-based over the list, and hidden when there is nothing to step through", () => {
  assert.match(viewer, /count\.textContent = list\.length > 1 \? `\$\{at \+ 1\} \/ \$\{list\.length\}` : ''/);
});

test("html and markdown are sandboxed; a pdf is not", () => {
  assert.match(viewer, /if \(kind === 'html'\) fr\.setAttribute\('sandbox', 'allow-scripts allow-forms allow-popups'\)/);
  assert.match(viewer, /if \(kind === 'markdown'\) fr\.setAttribute\('sandbox', ''\)/);
  // v1 #91: the pdf plugin does not paint inside a sandboxed frame, so the pdf branch gets none.
  const sandboxAttrs = [...viewer.matchAll(/setAttribute\('sandbox'/g)].length;
  assert.equal(sandboxAttrs, 2, 'exactly the html and markdown frames carry a sandbox');
});

test("the deliverable list and the image thumbnails both go through the viewer", () => {
  assert.match(detail, /viewer\.open\(/, "detail.ts opens the viewer directly, no handler");
  assert.match(detail, /if \(d\.ref\)[\s\S]{0,400}viewer\.open\(/, 'a ref is what makes a deliverable viewable');
  assert.match(detail, /if \(onOpen\) img\.addEventListener\('click', onOpen\)/, "an image thumbnail is clickable");
  assert.match(detail, /atList\.append\(thumb\(a, card\.projectId,[\s\S]{0,300}openAtt\(a\)\)/,
    "the card's thumbnails share the viewer, each with its own strip");
});
