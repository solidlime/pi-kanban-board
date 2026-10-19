// #83b: `/`, `/api/**` and `/serve/**` now need a token. Every test swaps HOME to an
// isolated dir before importing the extension, so the server writes its token to
// `${HOME}/.pi/kanban/token` on startup and a test can simply read that file back.
// One helper, so exactly one place knows where the secret lives.
import { readFileSync } from "node:fs";

/** The token this test's isolated server generated. Call after the server answers. */
export function readToken(home = process.env.HOME) {
	let lastErr;
	for (let i = 0; i < 200; i++) {
		try {
			const t = readFileSync(`${home}/.pi/kanban/token`, "utf8").trim();
			if (t.length > 0) return t;
		} catch (err) {
			lastErr = err;
		}
		// The server writes it during startup; a caller that beat it waits a few ms.
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
	}
	throw lastErr ?? new Error("token file never appeared");
}

/** fetch + the `kb_token` cookie. Same signature as fetch. */
export function authFetch(input, init = {}) {
	const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
	if (!headers.has("cookie")) headers.set("Cookie", `kb_token=${readToken()}`);
	return fetch(input, { ...init, headers });
}

/** The same credential for tests that have to build a raw `http.request` themselves. */
export function tokenHeader() {
	return `kb_token=${readToken()}`;
}
