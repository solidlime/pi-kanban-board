// Attachment rules: which bytes may be stored, how they are named, how large.
// Only images are accepted — an uploaded text/html served from our own origin is XSS.
import { basename } from "node:path";

export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

export interface ImageInfo { mime: string; ext: string }

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const GIF87 = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const GIF89 = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];

const startsWith = (buf: Uint8Array, sig: readonly number[]): boolean =>
  buf.length >= sig.length && sig.every((b, i) => buf[i] === b);

/** Magic-byte sniff. The client's content-type is a hint, never the decision. */
export function sniffImage(buf: Uint8Array): ImageInfo | null {
  if (startsWith(buf, PNG)) return { mime: "image/png", ext: "png" };
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", ext: "jpg" };
  if (startsWith(buf, GIF87) || startsWith(buf, GIF89)) return { mime: "image/gif", ext: "gif" };
  const ascii = (from: number, len: number): string => String.fromCharCode(...buf.subarray(from, from + len));
  if (buf.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return { mime: "image/webp", ext: "webp" };
  return null;
}

/** A display name that cannot escape its directory or carry control characters. */
export function safeAttachmentName(raw: string, fallback: string): string {
  const base = basename(String(raw ?? "").trim()).replace(/[\u0000-\u001f\u007f]/g, "");
  const cleaned = base.replace(/[^A-Za-z0-9._\- \u3040-\u30ff\u4e00-\u9fff]+/g, "_").replace(/^[.\s]+|[.\s]+$/g, "");
  return (cleaned === "" ? fallback : cleaned).slice(0, 120);
}
