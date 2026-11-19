// The md() renderer: blocks are detected on the raw lines (`> ` quoting needs the `> `), and
// every text exit from a block goes through inline() or esc(), so a raw `<script>` in the
// source never reaches the page. Inline markup is applied per line, except inside fenced code
// where only escaping happens.
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
    '<p><a href="https://example.com/a" target="_blank" rel="noopener noreferrer">docs</a></p>');
  const bad = md("[click](javascript:alert(1))");
  assert.equal(bad, "<p>[click](javascript:alert(1))</p>");
  assert.equal(md("[c](JaVaScRiPt:alert(1))").includes("<a "), false);
  assert.equal(md("[c](data:text/html,x)").includes("<a "), false);
});

test("no new tag can be smuggled through a link url", () => {
  // The URL group stops at the first closing paren, so this is not a link at all.
  const out = md('[x](http://a" onerror="alert(1))');
  assert.equal(out.includes('onerror="alert(1)>'), false);
});

test("bold and inline code", () => {
  assert.equal(md("**done** and `npm test`"), "<p><strong>done</strong> and <code>npm test</code></p>");
});

test("a heading, a list and a trailing paragraph are separate blocks", () => {
  // Was `# head<br><ul>...` before block parsing: `# head` now renders as a real heading and
  // loose text gets its own paragraph instead of being glued on with <br>.
  assert.equal(
    md("# head\n- one\n- two\ntail"),
    "<h1>head</h1><ul><li>one</li><li>two</li></ul><p>tail</p>");
});

test("headings keep their level", () => {
  assert.equal(md("### mid"), "<h3>mid</h3>");
  assert.equal(md("###### six"), "<h6>six</h6>");
  assert.equal(md("#nospace is not a heading"), "<p>#nospace is not a heading</p>");
});

test("fenced code is escaped but never inline-formatted", () => {
  assert.equal(
    md("```js\n**x** and [a](https://e.com)\n```"),
    '<pre><code class="language-js">**x** and [a](https://e.com)</code></pre>');
  assert.equal(md("```js\n**x**\n```").includes("<strong>"), false);
  assert.equal(md("~~~\n<b>\n~~~"), "<pre><code>&lt;b&gt;</code></pre>");
  // Unclosed fence runs to the end of the document.
  assert.equal(md("```\nline"), "<pre><code>line</code></pre>");
});

test("a table with a separator row becomes thead/tbody", () => {
  assert.equal(
    md("| a | b |\n|---|---|\n| 1 | 2 |"),
    "<table><thead><tr><th>a</th><th>b</th></tr></thead>" +
      "<tbody><tr><td>1</td><td>2</td></tr></tbody></table>");
});

test("table cells are inlined and padded or trimmed to the header width", () => {
  assert.equal(
    md("| h | i |\n|:-:|---|\n| **a** | `x` | extra |"),
    "<table><thead><tr><th>h</th><th>i</th></tr></thead>" +
      "<tbody><tr><td><strong>a</strong></td><td><code>x</code></td></tr></tbody></table>");
  assert.equal(
    md("| h | i |\n|---|---|\n| 1 |"),
    "<table><thead><tr><th>h</th><th>i</th></tr></thead>" +
      "<tbody><tr><td>1</td><td></td></tr></tbody></table>");
});

test("a quote block holds its own blocks", () => {
  assert.equal(md("> a\n> - b"), "<blockquote><p>a</p><ul><li>b</li></ul></blockquote>");
  assert.equal(md("> # h"), "<blockquote><h1>h</h1></blockquote>");
});

test("ordered lists accept a dot or a paren", () => {
  assert.equal(md("1. a\n2) b"), "<ol><li>a</li><li>b</li></ol>");
});

test("thematic breaks", () => {
  assert.equal(md("a\n\n---\n\nb"), "<p>a</p><hr><p>b</p>");
  assert.equal(md("***"), "<hr>");
  assert.equal(md("___"), "<hr>");
});

test("images render, and only from safe urls", () => {
  assert.equal(md("![alt](https://e.com/i.png)"), '<p><img src="https://e.com/i.png" alt="alt"></p>');
  assert.equal(md("![alt](./i.png)"), '<p><img src="./i.png" alt="alt"></p>');
  assert.equal(md("![a](javascript:alert(1))").includes("<img"), false);
  assert.equal(md("![a](DATA:image/png;base64,x)").includes("<img"), false);
});

test("a C0 control character in a url does not make a link", () => {
  // C0 survives esc() and is stripped when a browser resolves the URL, so
  // "\u0001javascript:" would still navigate.
  assert.equal(md("[x](\u0001javascript:alert(1))").includes("<a "), false);
  assert.equal(md("[x](http://e.com/\u0001a)").includes("<a "), false);
});

test("table cells split on every pipe, escaped or not", () => {
  // shortcut: no \| escape; a cell containing a pipe splits. Upgrade if a table needs one.
  assert.equal(
    md("| a \\| b | c |\n|---|---|\n| 1 | 2 |"),
    "<table><thead><tr><th>a \\</th><th>b</th><th>c</th></tr></thead>" +
      "<tbody><tr><td>1</td><td>2</td><td></td></tr></tbody></table>");
});

test("a separator row needs a pipe, so `---` under a pipe line is still an hr", () => {
  assert.equal(md("a | b\n---"), "<p>a | b</p><hr>");
});

test("the alt text is escaped", () => {
  assert.equal(md('![a"b](https://e.com/i.png)'), '<p><img src="https://e.com/i.png" alt="a&quot;b"></p>');
});

test("emphasis and strikethrough", () => {
  assert.equal(md("*x*"), "<p><em>x</em></p>");
  assert.equal(md("_x_"), "<p><em>x</em></p>");
  assert.equal(md("~~x~~"), "<p><del>x</del></p>");
  // snake_case must survive `_em_`.
  assert.equal(md("a_b_c"), "<p>a_b_c</p>");
});

test("a paragraph keeps its <br> line breaks", () => {
  assert.equal(md("a\nb\n\nc"), "<p>a<br>b</p><p>c</p>");
});

test("a long run of unmatched '[' stays linear", () => {
  // Attachments are user uploads now: [^\]] here backtracked quadratically and hung the
  // synchronous /view handler for minutes on a 256 KiB file. 200k brackets is a hard guard.
  // Block rendering now wraps the run in a <p>, so the length is >= the source rather than
  // exactly equal; the point of this test is the elapsed time.
  const started = Date.now();
  const out = md("[".repeat(200_000));
  assert.ok(out.length >= 200_000);
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started}ms`);
});

test("nested quotes stay linear", () => {
  // block() used to be called twice per line (the paragraph loop threw the result away and
  // the outer loop parsed it again), so 2^depth reparses; ~1 KiB of `> ` froze /view.
  const src = Array.from({ length: 30 }, (_, k) => "> ".repeat(k) + "x").join("\n");
  const started = Date.now();
  const out = md(src);
  const took = Date.now() - started;
  assert.ok(out.includes("<blockquote>"), out);
  assert.ok(took < 2000, `took ${took}ms`);
});

test("quote recursion is capped, so a deep quote cannot blow the stack", () => {
  const src = "> ".repeat(50_000) + "x";
  const out = md(src);
  // esc() turns every `>` into `&gt;` (4x) and `&gt; ` is 5 chars for 2 of source, so the
  // floor is ~2.5x the input; what this pins is that the output stays linear (no 2^depth).
  assert.ok(out.length < 3 * src.length, `len ${out.length}`);
  assert.ok(out.includes("<blockquote>"));
  // The cap is 8, so a 50k-deep quote nests exactly 9 blockquotes (depth 0..8).
  assert.equal((out.match(/<blockquote>/g) ?? []).length, 9);
});

test("an empty string renders empty", () => {
  assert.equal(md(""), "");
});

test("relative links stay links, other schemes do not", () => {
  assert.equal(md("[docs](./a.md)"),
    '<p><a href="./a.md" target="_blank" rel="noopener noreferrer">docs</a></p>');
  assert.equal(md("[x](#top)").includes('<a href="#top"'), true);
  assert.equal(md("[x](javascript:alert(1))").includes("<a href"), false);
});

test("a fence info string may carry spaces and still closes", () => {
  // Was `<p>```js title="x"</p>` and then the closing fence opened a new fence that swallowed
  // the rest of the file into <pre>.
  assert.equal(md('```js title="x"\ncode\n```'),
    '<pre><code class="language-js">code</code></pre>');
});

test("a closing fence is at least as long as the opening one", () => {
  // A shorter run of the same char is body text, not a close (CommonMark).
  assert.equal(md("````\na\n```\nb\n````"), "<pre><code>a\n```\nb</code></pre>");
});

test("the fence language cannot break out of its attribute", () => {
  // \S* in the fence regex accepts a quote, so an unescaped class would close the attribute.
  assert.equal(md('```x"onmouseover="alert(1)\nc\n```'),
    '<pre><code class="language-x&quot;onmouseover=&quot;alert(1)">c</code></pre>');
});

test("a stashed fragment inside a link label is expanded", () => {
  // replace() never rescans what it wrote: the label used to come out as the raw
  // placeholder, so `[`x`](url)` and README's `[![v](badge)](url)` rendered as garbage.
  assert.equal(md("[`x`](https://e.com)"),
    '<p><a href="https://e.com" target="_blank" rel="noopener noreferrer"><code>x</code></a></p>');
  assert.equal(md("[**b**](https://e.com)").includes("<strong>b</strong>"), true);
  const badge = md("[![v](https://e.com/b.svg)](https://e.com)");
  assert.equal(badge.includes("\uE000"), false, badge);
  assert.equal(badge.includes("<img"), true, badge);
});

test("protocol-relative urls are refused", () => {
  assert.equal(md("[x](//host/a)").includes("<a href"), false);
  assert.equal(md("![x](//host/a.png)").includes("<img"), false);
});

test("a private-use placeholder typed by the author cannot recurse", () => {
  // esc() closes the placeholder alphabet: without it `restore()` chased a slot the
  // author's own text could name (undefined slot, or a code span containing itself)
  // and blew the stack on plain text.
  assert.equal(md("a\uE0000\uE001b"), "<p>a&#xE000;0&#xE001;b</p>");
  assert.equal(md("`x\uE0000\uE001y`"), "<p><code>x&#xE000;0&#xE001;y</code></p>");
});

test("protocol-relative urls are refused however the slashes are written", () => {
  for (const u of ["//host/a", "/\\host/a", "\\\\host/a"]) {
    assert.equal(md(`[x](${u})`).includes("<a href"), false, u);
  }
});

test("image alt is plain text, not emphasis", () => {
  assert.equal(md("![**b**](https://e.com/i.png)").includes("<strong"), false);
});
