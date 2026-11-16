// The one place a blob is written. Content-addressed, allowlisted by bytes, size-capped.
// Callers get the blob name; deleting is the caller's job (see deleteAttachment's `shared` flag).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sniffAttachment } from "./core/attachment.js";

export function mediaDir(home: string): string {
  const dir = join(home, "media", "att");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface StoredBlob { blobName: string; mime: string; size: number }

/** Null means "not a file we serve": the caller turns that into a 422. */
export function storeBlob(home: string, bytes: Buffer, name: string): StoredBlob | null {
  const info = sniffAttachment(bytes, name);
  if (!info) return null;
  const blobName = createHash("sha256").update(bytes).digest("hex").slice(0, 32) + "." + info.ext;
  writeFileSync(join(mediaDir(home), blobName), bytes);
  return { blobName, mime: info.mime, size: bytes.length };
}

export function blobPath(home: string, blobName: string): string | null {
  // The stored name is a hash, but a hand-edited DB row must still not escape the directory.
  if (!/^[a-f0-9]{32}\.[a-z0-9]{1,8}$/.test(blobName)) return null;
  const p = join(mediaDir(home), blobName);
  return existsSync(p) ? p : null;
}
