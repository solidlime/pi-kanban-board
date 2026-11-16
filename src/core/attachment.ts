// Attachment rules: which bytes may be stored, how they are named, how large.
// Images, documents, media, archives and plain text pass. Anything that would run as our own
// origin (html, svg) does not: uploads are served back with nosniff, from this server.
import { basename, extname } from "node:path";

export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

export interface MediaInfo { mime: string; ext: string }

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const GIF87 = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const GIF89 = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];

const startsWith = (buf: Uint8Array, sig: readonly number[]): boolean =>
  buf.length >= sig.length && sig.every((b, i) => buf[i] === b);

const ascii = (buf: Uint8Array, from: number, len: number): string =>
  String.fromCharCode(...buf.subarray(from, from + len));

/** Magic-byte sniff. The client's content-type is a hint, never the decision. */
export function sniffMedia(buf: Uint8Array): MediaInfo | null {
  if (startsWith(buf, PNG)) return { mime: "image/png", ext: "png" };
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", ext: "jpg" };
  if (startsWith(buf, GIF87) || startsWith(buf, GIF89)) return { mime: "image/gif", ext: "gif" };
  if (buf.length >= 12 && ascii(buf, 0, 4) === "RIFF" && ascii(buf, 8, 4) === "WEBP") return { mime: "image/webp", ext: "webp" };
  if (buf.length >= 12 && ascii(buf, 0, 4) === "RIFF" && ascii(buf, 8, 4) === "WAVE") return { mime: "audio/wav", ext: "wav" };
  if (buf.length >= 5 && ascii(buf, 0, 5) === "%PDF-") return { mime: "application/pdf", ext: "pdf" };
  // ISO base media (mp4/mov/m4a): a 4-byte box size, then "ftyp", then the brand.
  if (buf.length >= 12 && ascii(buf, 4, 4) === "ftyp") {
    const brand = ascii(buf, 8, 4);
    if (brand.startsWith("M4A")) return { mime: "audio/mp4", ext: "m4a" };
    if (brand.startsWith("qt")) return { mime: "video/quicktime", ext: "mov" };
    return { mime: "video/mp4", ext: "mp4" };
  }
  // EBML carries both webm and mkv; the browser plays the former and offers the latter.
  if (startsWith(buf, [0x1a, 0x45, 0xdf, 0xa3])) return { mime: "video/webm", ext: "webm" };
  if (buf.length >= 4 && ascii(buf, 0, 4) === "OggS") return { mime: "audio/ogg", ext: "ogg" };
  if (buf.length >= 4 && ascii(buf, 0, 4) === "fLaC") return { mime: "audio/flac", ext: "flac" };
  // An mp3 either starts with an ID3 tag or straight on an MPEG audio frame header.
  if (buf.length >= 3 && ascii(buf, 0, 3) === "ID3") return { mime: "audio/mpeg", ext: "mp3" };
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0 &&
    buf[1] !== 0xfe && buf[1] !== 0xff && ((buf[1] >> 3) & 3) !== 1) {
    return { mime: "audio/mpeg", ext: "mp3" };
  }
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) || startsWith(buf, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(buf, [0x50, 0x4b, 0x07, 0x08])) return { mime: "application/zip", ext: "zip" };
  return null;
}

/** Text has no magic bytes: ask for valid UTF-8 and no control characters beyond whitespace. */
function looksLikeText(buf: Uint8Array): boolean {
  if (buf.length === 0) return false;
  const sample = buf.subarray(0, 8192);
  try {
    // stream:true tolerates a multi-byte character cut by the sample window.
    new TextDecoder("utf-8", { fatal: true }).decode(sample, { stream: true });
  } catch {
    return false;
  }
  for (const b of sample) {
    if (b === 0x1b) continue; // ANSI colour codes are normal in .log files
    if (b < 0x09 || (b > 0x0d && b < 0x20) || b === 0x7f) return false;
  }
  return true;
}

/** Plain documents only. A name of .html would otherwise become a page on our origin. */
const TEXT_EXT: Record<string, MediaInfo> = {
  md: { mime: "text/markdown; charset=utf-8", ext: "md" },
  markdown: { mime: "text/markdown; charset=utf-8", ext: "md" },
  txt: { mime: "text/plain; charset=utf-8", ext: "txt" },
  log: { mime: "text/plain; charset=utf-8", ext: "log" },
  csv: { mime: "text/csv; charset=utf-8", ext: "csv" },
  json: { mime: "application/json; charset=utf-8", ext: "json" },
  yaml: { mime: "text/yaml; charset=utf-8", ext: "yaml" },
  yml: { mime: "text/yaml; charset=utf-8", ext: "yaml" },
};

/** What an upload is, by bytes first and filename second. Null is a 422. */
export function sniffAttachment(buf: Uint8Array, name: string): MediaInfo | null {
  const media = sniffMedia(buf);
  if (media) return media;
  if (!looksLikeText(buf)) return null;
  return TEXT_EXT[extname(basename(String(name ?? ""))).slice(1).toLowerCase()] ?? null;
}

/** A display name that cannot escape its directory or carry control characters. */
export function safeAttachmentName(raw: string, fallback: string): string {
  const base = basename(String(raw ?? "").trim()).replace(/[\u0000-\u001f\u007f]/g, "");
  const cleaned = base.replace(/[^A-Za-z0-9._\- \u3040-\u30ff\u4e00-\u9fff]+/g, "_").replace(/^[.\s]+|[.\s]+$/g, "");
  return (cleaned === "" ? fallback : cleaned).slice(0, 120);
}
