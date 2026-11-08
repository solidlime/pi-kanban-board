// #104: 送信層の圧縮 (br / gzip / identity) 自己検証 (#011)。
// フレームワーク無しで `node tests/kanban-compression.test.mjs`。
// HOME と KANBAN_PORT を差し替えるので本番の ~/.pi/kanban と 8789 には触れない。
//
// fetch は accept-encoding を自分で足し、応答も勝手に展開して content-encoding を落とす。
// 圧縮そのものを見るテストなので node:http の生リクエストで受ける。
import http from "node:http";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { authFetch, tokenHeader } from "./helpers/token.mjs";
import { useKanban, seedBoard } from "./helpers/board.mjs";

const HOME_DIR = "/tmp/kb-compress-home";
rmSync(HOME_DIR, { recursive: true, force: true });
const KB = `${HOME_DIR}/.pi/kanban`;
mkdirSync(`${KB}/sessions`, { recursive: true });
mkdirSync(`${KB}/media`, { recursive: true });
process.env.HOME = HOME_DIR;
// Windows: os.homedir() prefers USERPROFILE over HOME, so keep them in step or the
// server writes its token to the real profile and this test reads a missing file.
process.env.USERPROFILE = process.env.HOME;
process.env.KANBAN_PORT = String(
	await new Promise((resolve) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	}),
);
const PORT = process.env.KANBAN_PORT;
const BASE = `http://127.0.0.1:${PORT}`;

const require = createRequire(import.meta.url);
const { createJiti } = require(
	process.env.KANBAN_JITI ?? createRequire(import.meta.url).resolve("jiti"),
);
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(fileURLToPath(new URL("../extensions/kanban.ts", import.meta.url)));
useKanban(mod);

const failures = [];
let passed = 0;
async function check(name, fn) {
	try {
		await fn();
		passed += 1;
	} catch (err) {
		failures.push(`${name}: ${err.message}`);
	}
}

const pi = {
	registerCommand() {},
	registerTool() {},
	appendEntry() {},
	on() {},
	sendUserMessage() {},
};
mod.default(pi);

seedBoard(`${KB}/global.json`, { cards: [{ id: 1, text: "g1", col: "todo" }], nextId: 2 });
// 圧縮の対象になる大きさ（>= 1024B）が要る。実ボードは 100KB だが、この HOME は空なので
// カードで埋める。
const many = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, text: `card-${i + 1}`, col: "todo" }));
seedBoard(`${KB}/projects/pi-kanban-board.json`, {
	cards: many,
	nextId: many.length + 1,
});

for (let i = 0; i < 40; i++) {
	try {
		if ((await authFetch(`${BASE}/api/kanban`)).ok) break;
	} catch {
		// まだ listen していない
	}
	await new Promise((r) => setTimeout(r, 100));
}

/** 生の GET。本文は Buffer のまま返す（fetch は展開してしまう）。 */
function raw(path, headers = {}) {
	const sent = { Cookie: tokenHeader(), ...headers };
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port: PORT, path, method: "GET", headers: sent }, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () =>
				resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
			);
		});
		req.on("error", reject);
		req.end();
	});
}

// --- 1. gzip ------------------------------------------------------------------
const identity = await raw("/api/dashboard", { "accept-encoding": "identity" });
const gz = await raw("/api/dashboard", { "accept-encoding": "gzip" });

await check("gzip: content-encoding: gzip + Vary: Accept-Encoding", () => {
	assert.equal(gz.status, 200, `status=${gz.status}`);
	assert.equal(gz.headers["content-encoding"], "gzip", `ce=${gz.headers["content-encoding"]}`);
	assert.match(gz.headers.vary ?? "", /accept-encoding/i, `vary=${gz.headers.vary}`);
});
await check("gzip: 展開すると identity と同じ JSON", () => {
	assert.deepEqual(JSON.parse(gunzipSync(gz.body).toString("utf8")), JSON.parse(identity.body.toString("utf8")));
});
await check("gzip は identity より小さい", () => {
	assert.ok(gz.body.length < identity.body.length, `gzip=${gz.body.length}B identity=${identity.body.length}B`);
});

// --- 2. br --------------------------------------------------------------------
const br = await raw("/api/dashboard", { "accept-encoding": "br" });

await check("br: content-encoding: br", () => assert.equal(br.headers["content-encoding"], "br", `ce=${br.headers["content-encoding"]}`));
await check("br: 展開すると identity と同じ JSON", () => {
	assert.deepEqual(JSON.parse(brotliDecompressSync(br.body).toString("utf8")), JSON.parse(identity.body.toString("utf8")));
});
await check("同じ本文でも符号化が違えば ETag も違う", () => {
	assert.ok(identity.headers.etag && br.headers.etag, "ETag が無い");
	assert.notEqual(br.headers.etag, identity.headers.etag);
});
await check("gzip と identity でも ETag が違う", () => {
	assert.ok(identity.headers.etag && gz.headers.etag, "ETag が無い");
	assert.notEqual(gz.headers.etag, identity.headers.etag);
});
await check("q を使う: br;q=0, gzip は gzip", async () => {
	const r = await raw("/api/dashboard", { "accept-encoding": "br;q=0, gzip" });
	assert.equal(r.status, 200, `status=${r.status}`);
	assert.equal(r.headers["content-encoding"], "gzip", `ce=${r.headers["content-encoding"]}`);
	assert.deepEqual(JSON.parse(gunzipSync(r.body).toString("utf8")), JSON.parse(identity.body.toString("utf8")));
});

// --- 3. accept-encoding 無し = identity ---------------------------------------
const none = await raw("/api/dashboard");

await check("accept-encoding 無し: content-encoding が付かない", () => {
	assert.equal(none.status, 200, `status=${none.status}`);
	assert.equal(none.headers["content-encoding"], undefined, `ce=${none.headers["content-encoding"]}`);
	assert.deepEqual(JSON.parse(none.body.toString("utf8")), JSON.parse(identity.body.toString("utf8")));
});
await check("identity 応答でも Vary は付く（Vary: Origin と合流する）", async () => {
	// Origin 付き = corsHeaders() が先に Vary: Origin を置く。identity で Vary を省くと
	// 共有キャッシュが圧縮版と取り違える。
	const r = await raw("/api/dashboard", { origin: `http://127.0.0.1:${PORT}` });
	assert.equal(r.status, 200, `status=${r.status}`);
	assert.equal(r.headers["content-encoding"], undefined, `ce=${r.headers["content-encoding"]}`);
	assert.equal(r.headers.vary, "Origin, Accept-Encoding", `vary=${r.headers.vary}`);
});

// --- 4. 同じ accept-encoding で 2 回目は 304 ----------------------------------
const again = await raw("/api/dashboard", { "accept-encoding": "br", "if-none-match": br.headers.etag });

await check("同じ accept-encoding の再取得は 304（本文 0B、content-encoding 無し）", () => {
	assert.equal(again.status, 304, `status=${again.status}`);
	assert.equal(again.body.length, 0, `body=${again.body.length}B`);
	assert.equal(again.headers["content-encoding"], undefined, `ce=${again.headers["content-encoding"]}`);
});

// --- 5. GET / も br で返る -----------------------------------------------------
const html = await raw("/", { "accept-encoding": "br" });
const htmlText = html.headers["content-encoding"] === "br" ? brotliDecompressSync(html.body).toString("utf8") : "";

await check("GET / を br で取ると HTML が展開できる（1000B 超）", () => {
	assert.equal(html.status, 200, `status=${html.status}`);
	assert.equal(html.headers["content-encoding"], "br", `ce=${html.headers["content-encoding"]}`);
	assert.ok(htmlText.length > 1000, `html=${htmlText.length}B`);
	assert.match(htmlText, /<html/i);
});

// --- 6. 1024B 未満は圧縮しない --------------------------------------------------
// /api/serve の失敗応答は 33B 程度（状態は変えない）。
const tiny = await raw("/api/serve?id=nope&action=remove", { "accept-encoding": "br" });

await check("1024B 未満は gzip/br にしない", () => {
	assert.equal(tiny.status, 404, `status=${tiny.status}`);
	assert.ok(tiny.body.length < 1024, `body=${tiny.body.length}B`);
	assert.equal(tiny.headers["content-encoding"], undefined, `ce=${tiny.headers["content-encoding"]}`);
	assert.equal(JSON.parse(tiny.body.toString("utf8")).error, "not registered");
});

console.log(
	`[compress] dashboard identity=${identity.body.length}B gzip=${gz.body.length}B br=${br.body.length}B ` +
		`html br=${html.body.length}B small=${tiny.body.length}B`,
);
for (const f of failures) console.log(`FAIL ${f}`);
console.log(`${passed} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
