// HTTP server: token gate first, then /api routes, then the built UI from web/dist.
// Nothing here opens or migrates the DB — src/api/start.ts owns the lifecycle and hands
// a ready handle in, so the server stays a function of its deps.
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fail, type ErrorCode } from "../shared/errors.js";
import { TOKEN_COOKIE } from "../shared/constants.js";
import type { HomeState } from "../persistence/init.js";
import type { Db } from "../persistence/db.js";
import { acceptToken, authCookie, clearCookie, presentedTokens } from "./auth.js";
import { API_VERSION, handleApi, sendJson, type Ctx } from "./routes.js";

export interface ServerDeps {
  /** null when the home is not initialized: meta/selftest still answer, writes refuse. */
  db: Db | null;
  home: string;
  state: HomeState;
  /** null when the home has no token file: every request is 401. */
  token: string | null;
  webRoot: string;
  buildHash: string;
  version?: string;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** A static-file refusal: the status the request deserves. */
class FileError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  constructor(status: number, code: ErrorCode, message: string) {
    super(message);
    this.name = "FileError";
    this.status = status;
    this.code = code;
  }
}

/** Same-origin writes only (docs/REWRITE_V2_PLAN.md §1.5); a curl without Origin passes. */
function originAllowed(req: http.IncomingMessage): boolean {
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin === "") return true;
  const host = req.headers.host;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function createServer(deps: ServerDeps) {
  const webRoot = path.resolve(deps.webRoot);

  async function serveFile(ctx: Ctx, extraHeaders: Record<string, string>): Promise<void> {
    const rel = ctx.url.pathname === "/" ? "/index.html" : ctx.url.pathname;
    if (rel.includes("\0")) throw new FileError(400, "BAD_REQUEST", "bad path");
    const fp = path.resolve(webRoot, `.${rel}`);
    // No traversal: the resolved path must stay inside the web root.
    if (fp !== webRoot && !fp.startsWith(webRoot + path.sep)) {
      throw new FileError(403, "FORBIDDEN", "path escapes the web root");
    }
    const st = await stat(fp).catch(() => null);
    if (!st || !st.isFile()) throw new FileError(404, "NOT_FOUND", "not found");
    const data = await readFile(fp);
    ctx.res.writeHead(200, {
      "content-type": MIME[path.extname(fp).toLowerCase()] ?? "application/octet-stream",
      "content-length": data.length,
      // The shell is revalidated, never cached blind: a stale UI must not outlive a build.
      "cache-control": path.extname(fp) === ".html" ? "no-store" : "no-cache",
      ...extraHeaders,
    });
    ctx.res.end(ctx.req.method === "HEAD" ? undefined : data);
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url || "/", "http://localhost");
    } catch {
      return sendJson(rawCtx(req, res), 400, fail("BAD_REQUEST", "malformed request target"));
    }
    function rawCtx(r: http.IncomingMessage, s: http.ServerResponse): Ctx {
      return {
        req: r, res: s, url: url!, db: deps.db, home: deps.home, state: deps.state,
        token: deps.token, version: deps.version ?? API_VERSION, buildHash: deps.buildHash,
      };
    }
    const ctx = rawCtx(req, res);

    try {
      // ---- auth: everything is behind the token, including the UI shell.
      // `?token=` is a bootstrap carrier, not a general one: it is honoured on GET /
      // (and /index.html) only, where it becomes the cookie. Accepting it anywhere would put the token
      // in history, Referer headers and proxy logs for no gain — every other call already has a cookie.
      const bootstrapPath = req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html");
      const candidates = presentedTokens(req, url).filter((c) => c.via !== "query" || bootstrapPath);
      const picked = acceptToken(deps.token, candidates);
      const authed = picked !== null;
      const staleCookie = candidates.some((c) => c.via === "cookie");
      // Whatever just authenticated has to end up in the cookie, and a cookie that did not has to go:
      // otherwise one bad cookie shadows every later request for its full 30 days.
      const cookieFix: Record<string, string> = {};
      if (picked) {
        if (picked.via !== "cookie") cookieFix["set-cookie"] = authCookie(picked.token);
        // The token rode in on a URL: keep it out of Referer headers on the way back out.
        if (picked.via === "query") cookieFix["referrer-policy"] = "no-referrer";
      } else if (staleCookie) {
        cookieFix["set-cookie"] = clearCookie();
      }
      // No token file yet (home not initialized): the two read-only diagnostics stay open so the
      // UI can say "run init" instead of failing with 401 forever. Both expose nothing secret.
      const diagnostics = deps.token === null && req.method === "GET"
        && (url.pathname === "/api/meta" || url.pathname === "/api/selftest");
      if (!authed && !diagnostics) {
        // Name the carrier: a stale cookie is the one failure that looks identical to "no token"
        // and that the user cannot fix without knowing which carrier to replace.
        let message = "missing or invalid token";
        if (deps.token === null) {
          message = `no token file in ${deps.home} (home ${deps.state.status}) — run the v2 init, which ` +
            `rewrites the v1 layout and therefore needs explicit confirmation`;
        } else if (staleCookie) {
          message = `invalid token in cookie ${TOKEN_COOKIE} (stale from an older home?) — ` +
            `open /?token=<token> to replace it`;
        }
        return sendJson(ctx, 401, fail("UNAUTHORIZED", message), cookieFix);
      }

      if (req.method !== "GET" && req.method !== "HEAD" && !originAllowed(req)) {
        return sendJson(ctx, 403, fail("FORBIDDEN", "cross-origin writes are not allowed"));
      }

      if (await handleApi(ctx)) return;

      if (req.method === "GET" || req.method === "HEAD") {
        return void await serveFile(ctx, cookieFix);
      }
      return sendJson(ctx, 404, fail("NOT_FOUND", `no route for ${req.method} ${url.pathname}`));
    } catch (err) {
      if (res.headersSent) return void res.end();
      if (err instanceof FileError) return sendJson(ctx, err.status, fail(err.code, err.message));
      const message = err instanceof Error ? err.message : String(err);
      sendJson(ctx, 500, fail("INTERNAL", message));
    }
  }

  return http.createServer((req, res) => {
    void handle(req, res);
  });
}
