// A5: the notifications() output, given somewhere to go. Off unless KANBAN_NOTIFY_SINK says
// otherwise; a slot is written at most once per 24h so a still-broken card does not shout
// every poll. JSON Lines, append-only: one line per delivered notification.
//
// shortcut: dedupe reads the whole sink file on every delivery, so a sink that grows past a
// few MB should move to a sqlite side table.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Notification } from "../shared/dto.js";
import { DomainError } from "../shared/errors.js";

export const SINK_ENV = "KANBAN_NOTIFY_SINK";
export const THROTTLE_MS = 86_400_000;

export type SinkSetting = { kind: "off" } | { kind: "file"; path: string };

export interface Delivery { path: string; written: number; skipped: number }

export interface SinkLine { at: string; slot: string; notification: Notification }

/** `off` / unset means nothing is written; anything else must be `file:<path>`. */
export function parseSinkSetting(raw: string | undefined | null): SinkSetting {
  const v = (raw ?? "").trim();
  if (v === "" || v === "off") return { kind: "off" };
  const m = /^file:(.+)$/.exec(v);
  const path = m ? m[1].trim() : "";
  if (path === "") {
    throw new DomainError("VALIDATION", `${SINK_ENV} must be off or file:<path> (got "${v}")`);
  }
  return { kind: "file", path };
}

/** What makes two notifications "the same" for the throttle: who + what + where, never the detail. */
export const slotOf = (n: Notification): string =>
  [n.projectId, n.kind, n.cardId ?? "", n.columnId ?? ""].join("|");

export function deliverNotifications(
  items: readonly Notification[],
  setting: SinkSetting,
  opts: { now?: Date } = {},
): Delivery | null {
  if (setting.kind === "off") return null;
  const now = opts.now ?? new Date();
  const seen = readSlots(setting.path);
  const lines: string[] = [];
  let skipped = 0;
  for (const n of items) {
    const slot = slotOf(n);
    const last = seen.get(slot);
    if (last !== undefined && now.getTime() - last < THROTTLE_MS) {
      skipped++;
      continue;
    }
    seen.set(slot, now.getTime());
    lines.push(JSON.stringify({ at: now.toISOString(), slot, notification: n } satisfies SinkLine));
  }
  if (lines.length > 0) {
    mkdirSync(dirname(setting.path), { recursive: true });
    appendFileSync(setting.path, `${lines.join("\n")}\n`, "utf8");
  }
  return { path: setting.path, written: lines.length, skipped };
}

/** slot → the newest `at` (ms) already written. A missing or half-written file reads as empty. */
function readSlots(path: string): Map<string, number> {
  const out = new Map<string, number>();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const e = JSON.parse(line) as Partial<SinkLine>;
      const at = typeof e.at === "string" ? Date.parse(e.at) : NaN;
      if (typeof e.slot !== "string" || Number.isNaN(at)) continue;
      if (at > (out.get(e.slot) ?? 0)) out.set(e.slot, at);
    } catch {
      continue; // a truncated tail line is not a reason to lose the rest
    }
  }
  return out;
}
