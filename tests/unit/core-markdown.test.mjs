// The md() renderer ported from web/md.js: escaping runs FIRST, so a link label can carry
// markup but a raw `<script>` in the source never reaches the page.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./_load.mjs";

const { esc, md } = await import("../../src/core/markdown.ts");

test("esc closes the angle brackets, quotes and ampersand", () => {
  assert.equal(esc('<b>&"'), "&lt;b&gt;&amp;&quot;");
});

test("raw html in the source is escaped, not rendered", () => {
  const out = md('<script>alert(1)</script>');
  assert.equal(out.includes("<script>"), false);
  assert.ok(out.includes("&lt;script&gt;"));
});

test("links are made for http(s) only, javascript: stays text", () => {
  assert.equal(
    md("[docs](https://example.com/a)"),
    '<a href="https://example.com/a" target="_blank" rel="noopener noreferrer">docs</a>');
  const bad = md("[click](javascript:alert(1))");
  assert.equal(bad, "[click](javascript:alert(1))");
  assert.equal(md("[c](JaVaScRiPt:alert(1))").includes("<a "), false);
});

test("no new tag can be smuggled through a link url", () => {
  // The URL group stops at the first closing paren, so this is not a link at all.
  const out = md('[x](http://a" onerror="alert(1))');
  assert.equal(out.includes("onerror=\"alert(1)>"), false);
});

test("bold and inline code", () => {
  assert.equal(md("**done** and `npm test`"), "<strong>done</strong> and <code>npm test</code>");
});

test("`- ` lines become one list, everything else is joined with <br>", () => {
  assert.equal(md("# head\n- one\n- two\ntail"), "# head<br><ul><li>one</li><li>two</li></ul><br>tail");
});

test("a long run of unmatched '[' stays linear", () => {
  // Attachments are user uploads now: [^\]] here backtracked quadratically and hung the
  // synchronous /view handler for minutes on a 256 KiB file. 200k brackets is a hard guard.
  const started = Date.now();
  const out = md("[".repeat(200_000));
  assert.equal(out.length, 200_000);
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started}ms`);
});

test("an empty string renders empty", () => {
  assert.equal(md(""), "");
});
