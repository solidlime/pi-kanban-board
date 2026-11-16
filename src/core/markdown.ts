// Minimal Markdown for the deliverable viewer — a straight port of web/md.js.
// The ORDER is load-bearing: escaping runs before any markup is produced, so no raw tag
// from the source can survive, and links are only made for http(s) URLs.
const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

export const esc = (s: unknown): string => String(s).replace(/[&<>"]/g, c => ESC[c]);

export function md(s: string): string {
  let e = esc(s);
  // [^\[\]] not [^\]]: a run of unmatched "[" makes the latter backtrack quadratically.
  e = e.replace(/\[([^\[\]]+)\]\(([^)\s]+)\)/g, (m, label: string, url: string) => {
    const low = url.toLowerCase();
    const ok = low.indexOf("http://") === 0 || low.indexOf("https://") === 0;
    return ok ? '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + "</a>" : m;
  });
  e = e.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  e = e.replace(/`([^`]+)`/g, "<code>$1</code>");
  const res: string[] = [];
  let list: string[] = [];
  const flush = (): void => {
    if (list.length) { res.push("<ul>" + list.join("") + "</ul>"); list = []; }
  };
  for (const line of e.split("\n")) {
    const li = /^- (.*)$/.exec(line);
    if (li) list.push("<li>" + li[1] + "</li>");
    else { flush(); res.push(line); }
  }
  flush();
  return res.join("<br>");
}
