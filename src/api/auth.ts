// Token auth for the v2 HTTP surface. Three carriers, in order: cookie `kb_auth`,
// `Authorization: Bearer`, and `?token=` — the last one only on GET / where it is turned
// into the cookie, so the token never has to live in a bookmarked page URL.
import { createHash, timingSafeEqual } from "node:crypto";
import type http from "node:http";
import { TOKEN_COOKIE, TOKEN_COOKIE_MAX_AGE } from "../shared/constants.js";

/** Constant-time compare of two strings of any length (hash first — lengths differ). */
const sha = (s: string): Buffer => createHash("sha256").update(s).digest();

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const v = part.slice(eq + 1).trim();
    return v === "" ? null : v;
  }
  return null;
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m ? m[1] : null;
}

export type TokenVia = "cookie" | "bearer" | "query" | null;

/** The token a request presents, and which carrier it came from. */
export function presentedToken(req: http.IncomingMessage, url: URL): { token: string | null; via: TokenVia } {
  const cookie = readCookie(req.headers.cookie, TOKEN_COOKIE);
  if (cookie) return { token: cookie, via: "cookie" };
  const bearer = bearerToken(req.headers.authorization);
  if (bearer) return { token: bearer, via: "bearer" };
  const query = url.searchParams.get("token");
  if (query) return { token: query, via: "query" };
  return { token: null, via: null };
}

/** False when either side is missing: a home without a token file authenticates nobody. */
export function tokenMatches(expected: string | null, presented: string | null): boolean {
  if (!expected || !presented) return false;
  return timingSafeEqual(sha(expected), sha(presented));
}

export function authCookie(token: string, maxAge: number = TOKEN_COOKIE_MAX_AGE): string {
  return `${TOKEN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}
