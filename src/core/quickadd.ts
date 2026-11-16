// v1's quick-add line: leading tokens name the project, the estimate and the due date,
// the rest is the title. Tokens count only while they run from the start of the text
// (v1 `parseQuickAdd`, extensions/kanban.ts:874-925); a `#` mid-sentence is a title.
import { assertDue, assertSlug } from "./validation.js";

/** v1 capped this at 8KB because the text rode a GET query. Kept as the same rule. */
export const QUICKADD_MAX_BYTES = 8192;

const TOKEN_RE = /^(#[A-Za-z0-9._-]+|![0-9]{1,3}|due:\S+)$/;
const ESTIMATE_MIN = 1;
const ESTIMATE_MAX = 5;

export interface QuickAdd {
  /** What is left after the tokens. v1 dropped a line that was tokens only. */
  title: string;
  /** `#slug`, or null to keep whatever project the caller already picked. */
  project: string | null;
  /** `!N`, clamped to 1..5 — v1 clamped rather than rejecting. */
  estimate: number | null;
  due: string | null;
}

export type QuickAddResult = { ok: true; value: QuickAdd } | { ok: false; error: string };

/**
 * v1 made one card per line and dropped lines starting with `//`; a single-card input has no
 * lines to drop, so `//` stays part of the title. Returns an error rather than throwing, so
 * both the HTTP and the command path can surface the same message.
 */
export function parseQuickAdd(text: string): QuickAddResult {
  if (Buffer.byteLength(text, "utf8") > QUICKADD_MAX_BYTES) {
    return { ok: false, error: `text must be at most ${QUICKADD_MAX_BYTES / 1024}KB` };
  }
  const words = text.trim().split(/\s+/).filter((w) => w !== "");
  let project: string | null = null;
  let estimate: number | null = null;
  let due: string | null = null;
  let i = 0;
  for (; i < words.length; i++) {
    const w = words[i];
    if (!TOKEN_RE.test(w)) break;
    if (w.startsWith("#")) {
      // The first project wins; a later `#x` is consumed and ignored, as in v1.
      if (project === null) {
        // Validated here, not by each caller: a bad slug must fail the same way on HTTP and
        // on the command path. v1 kept the case as typed; v2 needs a real slug.
        try {
          project = assertSlug(w.slice(1), "#slug");
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : "invalid #slug" };
        }
      }
    } else if (w.startsWith("!")) {
      if (estimate === null) {
        estimate = Math.min(ESTIMATE_MAX, Math.max(ESTIMATE_MIN, Number(w.slice(1))));
      }
    } else if (due === null) {
      try {
        due = assertDue(w.slice(4));
      } catch {
        return { ok: false, error: "due must be a YYYY-MM-DD date" };
      }
    }
  }
  const title = words.slice(i).join(" ");
  if (title === "") return { ok: false, error: "title is required" };
  return { ok: true, value: { title, project, estimate, due } };
}
