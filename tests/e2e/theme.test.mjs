// Theme and density are two <html> attributes over one token set. The failure that matters is
// silent: a new token that only dark defines leaves light half-painted, and nobody sees it until
// somebody flips the switch. These guards read the stylesheet the way the browser will.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.resolve(here, "../../web/src/styles.css"), "utf8");
const render = readFileSync(path.resolve(here, "../../web/src/render.ts"), "utf8");

/** The custom properties declared by the first block matching `selector`. */
function tokens(selector) {
  const at = css.indexOf(selector);
  assert.notEqual(at, -1, `${selector} is missing from styles.css`);
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  const body = css.slice(open + 1, close);
  return new Set([...body.matchAll(/(--[a-z0-9-]+)\s*:/g)].map(m => m[1]));
}

test("light overrides every colour token, so no surface stays dark", () => {
  const root = tokens(":root{");
  const light = tokens('html[data-theme="light"]');
  // Spacing tokens are deliberately not part of the palette: light swaps colours only.
  const spacing = new Set(["--gap", "--cards-gap", "--card-pad"]);
  const missing = [...root].filter(t => !light.has(t) && !spacing.has(t));
  assert.deepEqual(missing, [], "html[data-theme=light] does not override these tokens");
});

test("compact swaps spacing tokens, not colours", () => {
  const compact = tokens('html[data-density="compact"]');
  assert.deepEqual([...compact].sort(), ["--card-pad", "--cards-gap", "--gap"]);
});

test("every colour below the token blocks comes from a token", () => {
  // The token blocks themselves are the only place a literal colour belongs. Shadows and the
  // dialog backdrop stay literal on purpose: a scrim is dark in both themes.
  const after = css.slice(css.indexOf('html[data-density="compact"]{'));
  assert.doesNotMatch(after, /#[0-9a-f]{3,8}\b/i);
});

test("both switches persist under v1's keys", () => {
  assert.match(render, /localStorage\.getItem\('kb-theme'\)/);
  assert.match(render, /localStorage\.setItem\('kb-theme'/);
  assert.match(render, /localStorage\.getItem\('kb-density'\)/);
  assert.match(render, /localStorage\.setItem\('kb-density'/);
});

test("a stored private-mode failure still applies the default instead of throwing", () => {
  // getItem throws when storage is denied; the catch must still call both appliers.
  assert.match(render, /catch \{ applyTheme\(false\); applyDensity\(false\); \}/);
});

test("v1 and v2 write the same four values, or a shared key restores nothing", () => {
  const v1 = readFileSync(path.resolve(here, "../../web/dash/_app.js"), "utf8");
  for (const word of ["light", "dark", "compact", "normal"]) {
    const quoted = new RegExp(`["']${word}["']`);
    assert.match(v1, quoted, `v1 no longer writes "${word}"`);
    assert.match(render, quoted, `v2 does not write "${word}", so a v1 choice restores nothing`);
  }
});

test("the stored theme lands before the first paint, not after mount()", () => {
  // mount() runs once the module graph loads; that is already a dark frame for a light user.
  const index = readFileSync(path.resolve(here, "../../web/dist/index.html"), "utf8");
  const head = index.slice(0, index.indexOf("</head>"));
  assert.match(head, /<script>/, "the restore must be inline in <head>, not deferred");
  assert.match(head, /documentElement\.dataset\.theme/);
});
