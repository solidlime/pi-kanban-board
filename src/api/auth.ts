// Token auth for the v2 HTTP surface. Three carriers: cookie `kb_auth`, `Authorization: Bearer`,
// and `?token=` — the last only on GET / (and /index.html), where it becomes the cookie so the
// token never has to live in a bookmarked URL.
//
// A wrong cookie must never veto a good bearer or query token. Browsers keep `kb_auth` for 30 days
// and v1 used the same name, so a stale cookie is the normal case after a home is recreated — not
// an attack. Shadowing turned a valid `/?token=<token>` into a 401 that could never self-heal.
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

export type TokenVia = "cookie" | "bearer" | "query";

export interface PresentedToken {
  token: string;
  via: TokenVia;
}

/** Every token the request presents, most trusted first. Cookie first: it is the common path. */
export function presentedTokens(req: http.IncomingMessage, url: URL): PresentedToken[] {
  const out: PresentedToken[] = [];
  const cookie = readCookie(req.headers.cookie, TOKEN_COOKIE);
  if (cookie) out.push({ token: cookie, via: "cookie" });
  const bearer = bearerToken(req.headers.authorization);
  if (bearer) out.push({ token: bearer, via: "bearer" });
  const query = url.searchParams.get("token");
  if (query) out.push({ token: query, via: "query" });
  return out;
}

/** False when either side is missing: a home without a token file authenticates nobody. */
export function tokenMatches(expected: string | null, presented: string | null): boolean {
  if (!expected || !presented) return false;
  return timingSafeEqual(sha(expected), sha(presented));
}

/** The first candidate that matches `expected`; null when none does. Never throws on a bad cookie. */
export function acceptToken(
  expected: string | null,
  candidates: readonly PresentedToken[],
): PresentedToken | null {
  if (!expected) return null;
  return candidates.find((c) => tokenMatches(expected, c.token)) ?? null;
}

export function authCookie(token: string, maxAge: number = TOKEN_COOKIE_MAX_AGE): string {
  return `${TOKEN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

/** Set-cookie that deletes the carrier — what a stale cookie needs to stop shadowing. */
export function clearCookie(): string {
  return `${TOKEN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
