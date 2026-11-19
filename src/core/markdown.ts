// Minimal Markdown for the deliverable viewer. No dependencies: the whole renderer is a line
// based block pass plus an inline pass.
// The ORDER is load-bearing:
//   1. inline() escapes first (and fences escape their body), so no raw tag survives.
//   2. inline() stashes code/links/images in private-use placeholders before emphasis, so a
//      `*` or `_` inside a URL never becomes <em>.
//   3. fenced code is escaped only, never inline-formatted.
const ESC: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  // The private-use pair is the placeholder alphabet in inline(). Escaping it here is what
  // keeps that alphabet closed: every \uE000 in the pipeline is then one put() wrote, so
  // restore() can never chase a placeholder a user typed (it would recurse forever).
  "\uE000": "&#xE000;", "\uE001": "&#xE001;",
};

export const esc = (s: unknown): string => String(s).replace(/[&<>"\uE000\uE001]/g, c => ESC[c]);

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;
const UL = /^\s*[-*+]\s+(.*)$/;
const OL = /^\s*\d+[.)]\s+(.*)$/;

/** Only http(s) and scheme-less relative URLs become links; `javascript:` etc. stay text. */
function urlOk(u: string): boolean {
  // C0 controls survive esc() and are stripped when a browser resolves the URL, so
  // "\u0001javascript:" would still navigate. Refuse any control character in a URL.
  if (/[\u0000-\u001F\u007F]/.test(u)) return false;
  const low = u.toLowerCase();
  if (/^[\/\\]{2}/.test(low)) return false;
  if (low.startsWith("http://") || low.startsWith("https://")) return true;
  return !/^[a-z][a-z0-9+.-]*:/.test(low);
}

function inline(raw: string): string {
  const keep: string[] = [];
  // \uE000/\uE001 is a private-use pair that cannot occur in normal text.
  const put = (html: string): string => "\uE000" + (keep.push(html) - 1) + "\uE001";
  // A stashed fragment may itself hold stashes (code inside a link label), and replace()
  // never rescans what it wrote, so every slot is expanded on the way in.
  const restore = (s: string): string =>
    s.replace(/\uE000(\d+)\uE001/g, (_m, n: string) => restore(keep[+n] ?? ""));
  const emph = (s: string): string => s
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/(?<![\w])_([^_\n]+)_(?![\w])/g, "<em>$1</em>");
  // [^\[\]] not [^\]]: a run of unmatched "[" makes the latter backtrack quadratically.
  let t = esc(raw).replace(/`([^`\n]+)`/g, (_m, c: string) => put("<code>" + c + "</code>"));
  t = t.replace(/!\[([^\[\]]*)\]\(([^)\s]+)\)/g, (m, alt: string, url: string) =>
    urlOk(url) ? put('<img src="' + url + '" alt="' + restore(alt) + '">') : m);
  t = t.replace(/\[([^\[\]]+)\]\(([^)\s]+)\)/g, (m, label: string, url: string) =>
    urlOk(url) ? put('<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + restore(emph(label)) + "</a>") : m);
  return restore(emph(t));
}

function cells(line: string): string[] {
  // shortcut: no \| escape; a cell containing a pipe splits. Upgrade if a table needs one.
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map(c => c.trim());
}

/** The block starting at `lines[i]`, or null when the line is plain paragraph text. */
function block(lines: string[], i: number, depth = 0): { html: string; next: number } | null {
  const line = lines[i];

  const f = FENCE.exec(line);
  if (f) {
    const ch = f[1][0];
    const openLen = f[1].length;
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const t = lines[j].trim();
      if (t.length >= openLen && t[0] === ch && t === ch.repeat(t.length)) break;
      body.push(lines[j]);
      j++;
    }
    const lang0 = f[2].trim().split(/\s+/)[0];
    const lang = lang0 ? ' class="language-' + esc(lang0) + '"' : "";
    return { html: "<pre><code" + lang + ">" + esc(body.join("\n")) + "</code></pre>", next: j + 1 };
  }

  const h = HEADING.exec(line);
  if (h) {
    const n = h[1].length;
    return { html: "<h" + n + ">" + inline(h[2]) + "</h" + n + ">", next: i + 1 };
  }

  if (HR.test(line)) return { html: "<hr>", next: i + 1 };

  if (QUOTE.test(line)) {
    const inner: string[] = [];
    let j = i;
    for (let m = QUOTE.exec(lines[j]); m; m = j < lines.length ? QUOTE.exec(lines[j]) : null) {
      inner.push(m[1]);
      j++;
    }
    // Past the cap, stop recursing: the rest is quoted text, not more blocks.
    if (depth >= 8) return { html: "<blockquote>" + esc(inner.join("\n")) + "</blockquote>", next: j };
    return { html: "<blockquote>" + blocks(inner, depth + 1) + "</blockquote>", next: j };
  }

  if (line.includes("|") && i + 1 < lines.length && lines[i + 1].includes("|") &&
      TABLE_SEP.test(lines[i + 1])) {
    const head = cells(line);
    const rows: string[] = [];
    let j = i + 2;
    while (j < lines.length && lines[j].trim() && lines[j].includes("|")) {
      const c = cells(lines[j]);
      const out: string[] = [];
      for (let k = 0; k < head.length; k++) out.push("<td>" + inline(c[k] ?? "") + "</td>");
      rows.push("<tr>" + out.join("") + "</tr>");
      j++;
    }
    return {
      html: "<table><thead><tr>" + head.map(c => "<th>" + inline(c) + "</th>").join("") +
        "</tr></thead><tbody>" + rows.join("") + "</tbody></table>",
      next: j,
    };
  }

  for (const [re, tag] of [[UL, "ul"], [OL, "ol"]] as const) {
    const first = re.exec(line);
    if (!first) continue;
    const items: string[] = [];
    let j = i;
    for (let m = re.exec(lines[j]); m; m = j < lines.length ? re.exec(lines[j]) : null) {
      items.push("<li>" + inline(m[1]) + "</li>");
      j++;
    }
    return { html: "<" + tag + ">" + items.join("") + "</" + tag + ">", next: j };
  }

  return null;
}

function blocks(lines: string[], depth = 0): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].trim()) { i++; continue; }
    let b = block(lines, i, depth);
    if (b) { out.push(b.html); i = b.next; continue; }
    const para: string[] = [];
    // Keep the block the paragraph stopped on: parsing it again here would re-run a quote
    // subtree (the only recursion) twice per level, i.e. 2^depth for nested `> `.
    while (i < lines.length && lines[i].trim()) {
      b = block(lines, i, depth);
      if (b) break;
      para.push(inline(lines[i++]));
    }
    out.push("<p>" + para.join("<br>") + "</p>");
    if (b) { out.push(b.html); i = b.next; }
  }
  return out.join("");
}

export function md(s: string): string {
  if (!s) return "";
  // Blocks are detected on the raw lines (`> ` quoting needs the ``>``), and every text exit
  // from block() goes through inline() or esc(), so escaping still happens before any markup.
  return blocks(s.split(/\r?\n/));
}
