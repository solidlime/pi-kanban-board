// Which pi session a card resumes. pi keeps one folder per cwd (`--root-workspace-x--`) of
// `<timestamp>_<uuid>.jsonl` files; the only name a reader may show is the one pi itself wrote
// (`--name` at creation, or a pi-web title). The name/id parsing is pure; readSessions is the
// one fs entry point, so the route stays a two-liner.
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface SessionRef { id: string; name: string; updatedAt: string }

/** pi's per-cwd session folder: `/root/workspace/x` -> `--root-workspace-x--`. */
export function sessionDirName(cwd: string): string {
  const trimmed = cwd.trim().replace(/[/\\]+$/, "");
  return `--${trimmed.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** `<timestamp>_<uuid>.jsonl` -> the uuid; null for anything that is not a session file. */
export function sessionIdOfFile(file: string): string | null {
  const m = /_([^_/]+)\.jsonl$/.exec(file);
  return m === null ? null : m[1];
}

/**
 * The LAST `session_info` name in a chunk of session JSONL — a rename appends a new record.
 * A line the chunk boundary cut is skipped: only the tail of a line can be damaged.
 */
export function sessionNameOf(chunk: string): string | null {
  let name: string | null = null;
  for (const line of chunk.split("\n")) {
    if (!line.includes('"session_info"')) continue;
    try {
      const rec = JSON.parse(line) as { type?: unknown; name?: unknown };
      if (rec.type === "session_info" && typeof rec.name === "string" && rec.name.trim() !== "") {
        name = rec.name.trim();
      }
    } catch {
      // a cut line is not a record
    }
  }
  return name;
}

/**
 * Did pi-web write this file for a session it spawned (a doll / side pane)? The parent only gets a
 * `custom_message` notification whose customType merely starts the same way, so the marker has to
 * be parsed and compared whole. A cut line is not a record.
 */
export function isChildChunk(chunk: string): boolean {
  for (const line of chunk.split("\n")) {
    if (!line.includes('"pi-web:')) continue;
    try {
      const rec = JSON.parse(line) as { type?: unknown; customType?: unknown };
      if (rec.type === "custom" && (rec.customType === "pi-web:subagent" || rec.customType === "pi-web:side")) {
        return true;
      }
    } catch {
      // a cut line is not a record
    }
  }
  return false;
}

/** Newest first. A session pi never named is not something a card can pick, so it is dropped; neither
 * is a session pi-web made for a doll, which the board would otherwise list instead of its own.
 * `child` has no default on purpose: a caller that forgets to say would silently list the dolls. */
export function formatSessions(
  entries: { file: string; name: string | null; updatedAt: string; child: boolean }[],
): SessionRef[] {
  const out: SessionRef[] = [];
  for (const e of entries) {
    const id = sessionIdOfFile(e.file);
    if (id === null || e.name === null || e.child) continue;
    out.push({ id, name: e.name, updatedAt: e.updatedAt });
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// A doll's session is named like any other and is usually the newest, so the window that fills up
// first is the pile of them: the budget is on files read, not on what the picker ends up showing.
const SCAN_MAX = 50;
const SCAN_FILES_MAX = 200;
const READ_BATCH = 16;
const CHUNK = 32 * 1024;

/** Head and tail of a session file: a whole JSONL is tens of MB, and a chunk costs one read. */
async function headAndTail(path: string, size: number): Promise<string> {
  const fh = await open(path, "r");
  try {
    const head = Buffer.alloc(Math.min(size, CHUNK));
    await fh.read(head, 0, head.length, 0);
    if (size <= CHUNK) return head.toString("utf8");
    const tail = Buffer.alloc(CHUNK);
    await fh.read(tail, 0, tail.length, size - CHUNK);
    return `${head.toString("utf8")}\n${tail.toString("utf8")}`;
  } finally {
    await fh.close();
  }
}

/**
 * The named sessions of one session folder, newest first. A missing folder is an empty list
 * (a board nobody has woken yet). At most SCAN_MAX come back, from at most SCAN_FILES_MAX files.
 * shortcut: a rename buried between the head and tail chunks of a file is not seen; past
 * SCAN_FILES_MAX the oldest session drops out of the picker — switch to pi-web's own listing then.
 */
export async function readSessions(dir: string): Promise<SessionRef[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return []; // a board nobody has woken yet
  }
  const found: { file: string; updatedAt: string; size: number }[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    try {
      const st = await stat(join(dir, name));
      if (!st.isFile()) continue;
      found.push({ file: name, size: st.size, updatedAt: st.mtime.toISOString() });
    } catch {
      // A session rotated away between the listing and the stat is not a reason to hide the rest.
      continue;
    }
  }
  found.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  // In batches: 200 files opened at once spikes the fd count, and one unreadable file (EACCES, or a
  // session rotated away between the stat and the read) must not turn the whole picker into a 500.
  const entries: { file: string; updatedAt: string; name: string | null; child: boolean }[] = [];
  const limit = Math.min(found.length, SCAN_FILES_MAX);
  for (let i = 0; i < limit; i += READ_BATCH) {
    const batch = found.slice(i, Math.min(i + READ_BATCH, limit));
    const got = await Promise.all(batch.map(async f => {
      try {
        const chunk = await headAndTail(join(dir, f.file), f.size);
        return { file: f.file, updatedAt: f.updatedAt, name: sessionNameOf(chunk), child: isChildChunk(chunk) };
      } catch {
        return null;
      }
    }));
    for (const e of got) if (e) entries.push(e);
  }
  return formatSessions(entries).slice(0, SCAN_MAX);
}
