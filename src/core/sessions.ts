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

/** Newest first. A session pi never named is not something a card can pick, so it is dropped. */
export function formatSessions(entries: { file: string; name: string | null; updatedAt: string }[]): SessionRef[] {
  const out: SessionRef[] = [];
  for (const e of entries) {
    const id = sessionIdOfFile(e.file);
    if (id === null || e.name === null) continue;
    out.push({ id, name: e.name, updatedAt: e.updatedAt });
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

const SCAN_MAX = 50;
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
 * (a board nobody has woken yet). Only the newest SCAN_MAX files are read.
 * shortcut: a rename buried between the head and tail chunks of a file is not seen.
 */
export async function readSessions(dir: string): Promise<SessionRef[]> {
  const found: { file: string; updatedAt: string; size: number }[] = [];
  try {
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const st = await stat(join(dir, name));
      if (!st.isFile()) continue;
      found.push({ file: name, size: st.size, updatedAt: st.mtime.toISOString() });
    }
  } catch {
    return [];
  }
  found.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const entries = await Promise.all(found.slice(0, SCAN_MAX).map(async f => ({
    file: f.file, updatedAt: f.updatedAt, name: sessionNameOf(await headAndTail(join(dir, f.file), f.size)),
  })));
  return formatSessions(entries);
}
