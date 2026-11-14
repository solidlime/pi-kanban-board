// Token carriers are ordered, not exclusive: a bad cookie must never veto a good bearer or
// query token. v1 and v2 share the cookie name kb_auth, so after a home is recreated every
// browser still holds a stale one — shadowing made /?token=<token> return 401 forever.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./_load.mjs";

const { presentedTokens, acceptToken, tokenMatches, readCookie, bearerToken, authCookie, clearCookie } =
  await import("../../src/api/auth.ts");

const req = (headers = {}) => ({ headers });
const url = (q = "") => new URL("http://x/" + q);

test("presentedTokens: every carrier, cookie first", () => {
  const all = presentedTokens(
    req({ cookie: "kb_auth=c", authorization: "Bearer b" }),
    url("?token=q"),
  );
  assert.deepEqual(all.map((c) => c.via), ["cookie", "bearer", "query"]);
  assert.deepEqual(all.map((c) => c.token), ["c", "b", "q"]);

  assert.deepEqual(presentedTokens(req(), url()), []);
  assert.deepEqual(presentedTokens(req({ authorization: "Basic zzz" }), url()), [], "non-bearer schemes are not tokens");
});

test("acceptToken: a stale cookie does not shadow a good query token", () => {
  const cands = presentedTokens(req({ cookie: "kb_auth=stale" }), url("?token=good"));
  assert.equal(acceptToken("good", cands)?.via, "query");
});

test("acceptToken: a stale cookie does not shadow a good bearer", () => {
  const cands = presentedTokens(req({ cookie: "kb_auth=stale", authorization: "Bearer good" }), url());
  assert.equal(acceptToken("good", cands)?.via, "bearer");
});

test("acceptToken: the cookie still wins when every carrier is valid", () => {
  const cands = presentedTokens(req({ cookie: "kb_auth=good", authorization: "Bearer good" }), url("?token=good"));
  assert.equal(acceptToken("good", cands)?.via, "cookie");
});

test("acceptToken: nothing matches, or there is no token file", () => {
  const cands = presentedTokens(req({ cookie: "kb_auth=stale" }), url("?token=nope"));
  assert.equal(acceptToken("good", cands), null);
  assert.equal(acceptToken(null, cands), null, "a home without a token authenticates nobody");
});

test("tokenMatches: missing sides never match, any length is fine", () => {
  assert.equal(tokenMatches(null, "x"), false);
  assert.equal(tokenMatches("x", null), false);
  assert.equal(tokenMatches("", ""), false);
  assert.equal(tokenMatches("a".repeat(64), "a".repeat(64)), true);
  assert.equal(tokenMatches("a", "b"), false);
});

test("carriers parse and serialise predictably", () => {
  assert.equal(readCookie("a=1; kb_auth=abc; b=2", "kb_auth"), "abc");
  assert.equal(readCookie("kb_auth=", "kb_auth"), null, "an empty cookie is not a token");
  assert.equal(readCookie(undefined, "kb_auth"), null);
  assert.equal(bearerToken("Bearer abc"), "abc");
  assert.equal(bearerToken("bearer  abc "), "abc");
  assert.equal(bearerToken("Basic abc"), null);

  assert.match(authCookie("t"), /^kb_auth=t; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
  assert.match(authCookie("t", 5), /Max-Age=5$/);
  assert.match(clearCookie(), /^kb_auth=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0$/);
});
